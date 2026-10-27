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
interface Delta { text?: string; toolCalls?: ToolCallFragment[] }

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
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    max_tokens: cfg.maxTokens,
  };
  if (opts?.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  if (cfg.reasoningEffort && cfg.reasoningEffort !== 'none') {
    body.reasoning = { effort: cfg.reasoningEffort, exclude: true };
  }
  if (cfg.providerOrder && cfg.providerOrder.length > 0) {
    body.provider = { order: cfg.providerOrder, allow_fallbacks: true };
  }
  const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/uscabayaosj/StackChan',
      'X-Title': 'Saoirse StackChan',
    },
    body: JSON.stringify(body),
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
    if (delta.toolCalls) { sawContent = true; assembler.add(delta.toolCalls); }
    if (delta.text) { sawContent = true; yield { type: 'text', text: delta.text }; }
  }
  function* finish(): Generator<ChatEvent> {
    if (!sawContent) throw new LlmHttpError(502, NO_CONTENT);
    const calls = assembler.finish();
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
        yield* consume(parseDelta(payload));
      }
    }
    // Flush: a last data line may arrive without a trailing newline.
    pending += decoder.decode();
    const last = pending.trim();
    if (last.startsWith('data:')) {
      const payload = last.slice(5).trim();
      if (payload !== '[DONE]') yield* consume(parseDelta(payload));
    }
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
  try {
    for await (const ev of streamChatEvents(primary, messages, fetchImpl, opts)) {
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
