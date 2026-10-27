import type { LlmConfig } from './config.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export class LlmHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

function parseDelta(payload: string): string | undefined {
  try {
    const json = JSON.parse(payload);
    const delta = json.choices?.[0]?.delta?.content;
    return typeof delta === 'string' && delta ? delta : undefined;
  } catch {
    return undefined; // keep-alive or partial line
  }
}

export async function* streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    max_tokens: 200,
  };
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
        if (payload === '[DONE]') return;
        const delta = parseDelta(payload);
        if (delta) yield delta;
      }
    }
    // Flush: a last data line may arrive without a trailing newline.
    pending += decoder.decode();
    const last = pending.trim();
    if (last.startsWith('data:')) {
      const payload = last.slice(5).trim();
      if (payload !== '[DONE]') {
        const delta = parseDelta(payload);
        if (delta) yield delta;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function* streamChatWithFallback(
  primary: LlmConfig,
  fallback: LlmConfig | undefined,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<string> {
  let yielded = false;
  try {
    for await (const delta of streamChat(primary, messages, fetchImpl, opts)) {
      yielded = true;
      yield delta;
    }
    return;
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    const retryable = err instanceof LlmHttpError ? err.status === 429 || err.status >= 500 : true;
    if (!fallback || !retryable || aborted || yielded) throw err;
    console.warn('[llm] primary failed, using fallback:', (err as Error).message);
  }
  yield* streamChat(fallback, messages, fetchImpl, opts);
}
