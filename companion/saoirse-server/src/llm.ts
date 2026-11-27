import type { LlmConfig } from './config.js';

/** A tool call the model asked for; `arguments` is the raw JSON string from the model. */
export interface ToolCall { id: string; name: string; arguments: string }

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** OpenAI-style function tool definition (what `tools/list` from the robot maps to). */
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: unknown } }

export type ChatEvent = { type: 'text'; text: string } | { type: 'tool_calls'; calls: ToolCall[] };

export interface ChatOptions { signal?: AbortSignal; tools?: ToolSpec[] }

export class LlmHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

const NO_CONTENT = 'LLM stream produced no content';

interface ToolCallFragment { index: number; id?: string; function?: { name?: string; arguments?: string } }
interface Delta { text?: string; toolCalls?: ToolCallFragment[]; done?: boolean }

function parseDelta(payload: string): Delta | undefined {
  try {
    const json = JSON.parse(payload);
    const d = json.choices?.[0]?.delta;
    if (!d) return undefined;
    const out: Delta = {};
    if (typeof d.content === 'string' && d.content) out.text = d.content;
    if (Array.isArray(d.tool_calls)) out.toolCalls = d.tool_calls;
    return out.text || out.toolCalls ? out : undefined;
  } catch {
    return undefined; // keep-alive or partial line
  }
}

// Translate Anthropic SSE into the same text and tool fragments used by the voice session.
function parseAnthropicDelta(payload: string): Delta | undefined {
  const event = JSON.parse(payload);
  if (event.type === 'message_stop') return { done: true };
  if (event.type === 'error') throw new LlmHttpError(502, 'Anthropic interrupted the stream');
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const { id, name, input } = event.content_block;
    return { toolCalls: [{ index: event.index, id, function: {
      name, arguments: Object.keys(input ?? {}).length ? JSON.stringify(input) : '',
    } }] };
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
    return { toolCalls: [{ index: event.index, function: { arguments: event.delta.partial_json } }] };
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return { text: event.delta.text };
  }
}

function anthropicBody(body: Record<string, unknown>, messages: ChatMessage[], tools: ToolSpec[] = []) {
  const system = messages.filter(msg => msg.role === 'system').map(msg => msg.content).join('\n\n');
  const turns: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const content: Record<string, unknown>[] = [];
    if (msg.role === 'tool') {
      content.push({ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content });
    } else {
      if (msg.content) content.push({ type: 'text', text: msg.content });
      if (msg.role === 'assistant') {
        for (const call of msg.tool_calls ?? []) {
          let input: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(call.function.arguments);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
          } catch { /* the tool result explains invalid arguments */ }
          content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
        }
      }
    }
    if (content.length === 0) continue;
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...content);
    else turns.push({ role, content });
  }
  return {
    model: body.model,
    stream: true,
    max_tokens: body.max_tokens,
    thinking: { type: 'disabled' },
    system,
    messages: turns,
    ...(tools.length > 0 ? {
      tools: tools.map(({ function: tool }) => ({
        name: tool.name, description: tool.description, input_schema: tool.parameters,
      })),
    } : {}),
  };
}

/** Accumulates streamed tool-call fragments (by index) into complete calls. */
class ToolCallAssembler {
  private calls = new Map<number, ToolCall>();
  add(frags: ToolCallFragment[]): void {
    for (const f of frags) {
      const idx = typeof f.index === 'number' ? f.index : this.calls.size;
      const cur = this.calls.get(idx) ?? { id: '', name: '', arguments: '' };
      if (f.id) cur.id = f.id;
      if (f.function?.name) cur.name += f.function.name;
      if (f.function?.arguments) cur.arguments += f.function.arguments;
      this.calls.set(idx, cur);
    }
  }
  finish(): ToolCall[] {
    return [...this.calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ ...c, id: c.id || `call_${i}` })).filter(c => c.name);
  }
}

/** Streams text and, if the model asks for tools, one `tool_calls` event at the end. */
export async function* streamChatEvents(
  cfg: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  opts?: ChatOptions,
): AsyncGenerator<ChatEvent> {
  // Keep firmware names internally and use portable names at the provider boundary.
  const aliases = new Map<string, string>();
  const originalNames = new Map<string, string>();
  const names = [
    ...(opts?.tools?.map(tool => tool.function.name) ?? []),
    ...messages.flatMap(message => message.role === 'assistant' ? message.tool_calls?.map(call => call.function.name) ?? [] : []),
  ];
  const used = new Set(names.filter(name => /^[a-zA-Z0-9_-]{1,64}$/.test(name)));
  for (const name of names) {
    if (used.has(name) || aliases.has(name)) continue;
    const base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 55);
    let alias = base;
    for (let suffix = 1; used.has(alias); suffix++) alias = `${base}_${suffix}`;
    used.add(alias);
    aliases.set(name, alias);
    originalNames.set(alias, name);
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: messages.map(message => message.role === 'assistant' && message.tool_calls
      ? { ...message, tool_calls: message.tool_calls.map(call => ({
        ...call, function: { ...call.function, name: aliases.get(call.function.name) ?? call.function.name },
      })) }
      : message),
    stream: true,
    max_tokens: cfg.maxTokens,
  };
  if (opts?.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map(tool => ({
      ...tool, function: { ...tool.function, name: aliases.get(tool.function.name) ?? tool.function.name },
    }));
    body.tool_choice = 'auto';
  }
  if (cfg.reasoningEffort && cfg.reasoningEffort !== 'none') {
    body.reasoning = { effort: cfg.reasoningEffort, exclude: true };
  }
  if (cfg.providerOrder && cfg.providerOrder.length > 0) {
    body.provider = { order: cfg.providerOrder, allow_fallbacks: true };
  }
  const anthropic = cfg.protocol === 'anthropic';
  const parse = anthropic ? parseAnthropicDelta : parseDelta;
  const res = await fetchImpl(`${cfg.baseUrl}/${anthropic ? 'messages' : 'chat/completions'}`, {
    method: 'POST',
    headers: anthropic ? {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    } : {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/uscabayaosj/StackChan',
      'X-Title': 'Saoirse StackChan',
    },
    body: JSON.stringify(anthropic ? anthropicBody(body, body.messages as ChatMessage[], body.tools as ToolSpec[] | undefined) : body),
    signal: opts?.signal,
  });
  if (!res.ok || !res.body) throw new LlmHttpError(res.status, await res.text().catch(() => ''));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let sawContent = false;
  const assembler = new ToolCallAssembler();
  // Emits what a delta carried; tool-call fragments only accumulate (they are emitted once, at the end).
  function* consume(delta: Delta | undefined): Generator<ChatEvent> {
    if (!delta) return;
    if (delta.toolCalls) assembler.add(delta.toolCalls);
    if (delta.text && (sawContent || delta.text.trim())) { sawContent = true; yield { type: 'text', text: delta.text }; }
  }
  function* finish(): Generator<ChatEvent> {
    const calls = assembler.finish().map(call => ({ ...call, name: originalNames.get(call.name) ?? call.name }));
    if (!sawContent && calls.length === 0) throw new LlmHttpError(502, NO_CONTENT);
    if (calls.length > 0) yield { type: 'tool_calls', calls };
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { yield* finish(); return; }
        const delta = parse(payload);
        if (delta?.done) { yield* finish(); return; }
        yield* consume(delta);
      }
    }
    // Flush: a last data line may arrive without a trailing newline.
    pending += decoder.decode();
    const last = pending.trim();
    if (last.startsWith('data:')) {
      const payload = last.slice(5).trim();
      if (payload !== '[DONE]') {
        const delta = parse(payload);
        if (delta?.done) { yield* finish(); return; }
        yield* consume(delta);
      }
    }
    if (anthropic) throw new LlmHttpError(502, 'Anthropic stream ended before message_stop');
    yield* finish();
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Text-only view of `streamChatEvents` (no tools offered, any tool call is ignored). */
export async function* streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<string> {
  for await (const ev of streamChatEvents(cfg, messages, fetchImpl, opts)) {
    if (ev.type === 'text') yield ev.text;
  }
}

export async function* streamChatEventsWithFallback(
  primary: LlmConfig,
  fallback: LlmConfig | undefined,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  opts?: ChatOptions,
): AsyncGenerator<ChatEvent> {
  let yielded = false;
  const started = Date.now();
  try {
    for await (const ev of streamChatEvents(primary, messages, fetchImpl, opts)) {
      if (!yielded && primary.protocol === 'anthropic') {
        console.log(`[llm] Anthropic ${primary.model} first ${ev.type} in ${Date.now() - started} ms (thinking disabled)`);
      }
      yielded = true;
      yield ev;
    }
    return;
  } catch (err) {
    // A caller abort or deadline (TimeoutError, custom reason) never earns a fallback attempt.
    const aborted = (err as { name?: string })?.name === 'AbortError' || opts?.signal?.aborted === true;
    const retryable = err instanceof LlmHttpError ? err.status === 429 || err.status >= 500 : true;
    if (!fallback || !retryable || aborted || yielded) throw err;
    console.warn('[llm] primary failed, using fallback:', (err as Error).message);
  }
  yield* streamChatEvents(fallback, messages, fetchImpl, opts);
}

/** Text-only view of `streamChatEventsWithFallback`. */
export async function* streamChatWithFallback(
  primary: LlmConfig,
  fallback: LlmConfig | undefined,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<string> {
  for await (const ev of streamChatEventsWithFallback(primary, fallback, messages, fetchImpl, opts)) {
    if (ev.type === 'text') yield ev.text;
  }
}
