import { describe, it, expect, vi } from 'vitest';
import { streamChat, streamChatWithFallback, LlmHttpError } from '../src/llm.js';

function sse(lines: string[]): Response {
  const body = lines.map(l => `data: ${l}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const cfg = {
  baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', providerOrder: ['groq'],
  maxTokens: 400, reasoningEffort: 'low' as const,
};

describe('streamChat', () => {
  it('yields content deltas and sends the right request', async () => {
    let captured: any;
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, init };
      return sse([
        JSON.stringify({ choices: [{ delta: { content: '[doubtful] ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'No.' } }] }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;
    const out: string[] = [];
    for await (const d of streamChat(cfg, [{ role: 'user', content: 'hi' }], fetchImpl)) out.push(d);
    expect(out.join('')).toBe('[doubtful] No.');
    expect(captured.url).toBe('https://llm.test/v1/chat/completions');
    const body = JSON.parse(captured.init.body);
    expect(body.model).toBe('m');
    expect(body.stream).toBe(true);
    expect(body.provider).toEqual({ order: ['groq'], allow_fallbacks: true });
    expect(body.max_tokens).toBe(400);
    expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(captured.init.headers.Authorization).toBe('Bearer k');
  });
  it("omits the reasoning field when reasoningEffort is 'none'", async () => {
    let body: any;
    const fetchImpl = (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), '[DONE]']);
    }) as unknown as typeof fetch;
    for await (const _ of streamChat({ ...cfg, reasoningEffort: 'none' }, [{ role: 'user', content: 'hi' }], fetchImpl)) void _;
    expect(body).not.toHaveProperty('reasoning');
    expect(body.max_tokens).toBe(400);
  });
  it('falls back to the second model on a 5xx', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://llm.test')) return new Response('boom', { status: 503 });
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), '[DONE]']);
    }) as unknown as typeof fetch;
    const fb = { baseUrl: 'https://fb.test/v1', apiKey: 'f', model: 'fm', maxTokens: 400 };
    const out: string[] = [];
    for await (const d of streamChatWithFallback(cfg, fb, [{ role: 'user', content: 'hi' }], fetchImpl)) out.push(d);
    expect(out.join('')).toBe('ok');
    expect(calls).toEqual(['https://llm.test/v1/chat/completions', 'https://fb.test/v1/chat/completions']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

const fb = { baseUrl: 'https://fb.test/v1', apiKey: 'f', model: 'fm', maxTokens: 400, reasoningEffort: 'low' as const };
const msgs = [{ role: 'user' as const, content: 'hi' }];
const delta = (c: string) => JSON.stringify({ choices: [{ delta: { content: c } }] });

function chunked(chunks: string[], onCancel?: () => void): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (i < chunks.length) ctl.enqueue(enc.encode(chunks[i++]));
      else ctl.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('streamChat edge cases', () => {
  it('flushes a final data line with no trailing newline and no [DONE]', async () => {
    const fetchImpl = (async () => chunked([`data: ${delta('a')}\n\n`, `data: ${delta('b')}`])) as unknown as typeof fetch;
    const out: string[] = [];
    for await (const d of streamChat(cfg, msgs, fetchImpl)) out.push(d);
    expect(out).toEqual(['a', 'b']);
  });

  it('reassembles an SSE line split mid-line across two chunks', async () => {
    const line = `data: ${delta('hello')}\n\n`;
    const fetchImpl = (async () =>
      chunked([line.slice(0, 20), line.slice(20), `data: [DONE]\n\n`])) as unknown as typeof fetch;
    const out: string[] = [];
    for await (const d of streamChat(cfg, msgs, fetchImpl)) out.push(d);
    expect(out).toEqual(['hello']);
  });

  it('cancels the upstream reader when the consumer returns early', async () => {
    let cancelled = false;
    const fetchImpl = (async () =>
      chunked([`data: ${delta('a')}\n\n`, `data: ${delta('b')}\n\n`], () => {
        cancelled = true;
      })) as unknown as typeof fetch;
    const gen = streamChat(cfg, msgs, fetchImpl);
    const first = await gen.next();
    expect(first.value).toBe('a');
    await gen.return(undefined);
    expect(cancelled).toBe(true);
  });

  it('passes the abort signal to fetch', async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_u: string, init: any) => {
      seen = init.signal;
      return sse([delta('x'), '[DONE]']);
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    for await (const _ of streamChat(cfg, msgs, fetchImpl, { signal: ac.signal })) void _;
    expect(seen).toBe(ac.signal);
  });
});

describe('streamChatWithFallback policy', () => {
  it('does not fall back after a delta was already yielded', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://llm.test')) {
        const enc = new TextEncoder();
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(ctl) {
            if (!sent) {
              sent = true;
              ctl.enqueue(enc.encode(`data: ${delta('partial')}\n\n`));
            } else ctl.error(new Error('connection reset'));
          },
        });
        return new Response(body, { status: 200 });
      }
      return sse([delta('replay'), '[DONE]']);
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const run = async () => {
      for await (const d of streamChatWithFallback(cfg, fb, msgs, fetchImpl)) out.push(d);
    };
    await expect(run()).rejects.toThrow('connection reset');
    expect(out).toEqual(['partial']);
    expect(calls).toEqual(['https://llm.test/v1/chat/completions']);
  });

  it('sends no reasoning field to the fallback when its effort is none, and sends it when low', async () => {
    const run = async (effort: 'none' | 'low') => {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        if (url.startsWith('https://llm.test')) return new Response('down', { status: 503 });
        bodies.push(JSON.parse(String(init.body)));
        return sse([delta('ok'), '[DONE]']);
      }) as unknown as typeof fetch;
      for await (const _ of streamChatWithFallback(cfg, { ...fb, reasoningEffort: effort }, msgs, fetchImpl)) void _;
      return bodies;
    };
    const none = await run('none');
    expect(none).toHaveLength(1);
    expect('reasoning' in none[0]).toBe(false);
    const low = await run('low');
    expect(low[0].reasoning).toEqual({ effort: 'low', exclude: true });
  });

  it('does not fall back on a non-retryable 4xx', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response('nope', { status: 401 });
    }) as unknown as typeof fetch;
    const run = async () => {
      for await (const _ of streamChatWithFallback(cfg, fb, msgs, fetchImpl)) void _;
    };
    await expect(run()).rejects.toBeInstanceOf(LlmHttpError);
    expect(calls).toEqual(['https://llm.test/v1/chat/completions']);
  });

  it('does not fall back on AbortError', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const run = async () => {
      for await (const _ of streamChatWithFallback(cfg, fb, msgs, fetchImpl, { signal: new AbortController().signal })) void _;
    };
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['https://llm.test/v1/chat/completions']);
  });
});

describe('reasoning-only streams', () => {
  const reasoning = (r: string) => JSON.stringify({ choices: [{ delta: { reasoning: r, content: '' } }] });

  it('throws a 502 LlmHttpError when the stream produces no content', async () => {
    const fetchImpl = (async () => sse([reasoning('thinking'), reasoning('more'), '[DONE]'])) as unknown as typeof fetch;
    const run = async () => {
      for await (const _ of streamChat(cfg, msgs, fetchImpl)) void _;
    };
    await expect(run()).rejects.toMatchObject({ status: 502 });
    await expect(run()).rejects.toThrow('LLM stream produced no content');
  });

  it('throws the same error when the stream ends without [DONE]', async () => {
    const fetchImpl = (async () => chunked([`data: ${reasoning('x')}\n\n`])) as unknown as typeof fetch;
    const run = async () => {
      for await (const _ of streamChat(cfg, msgs, fetchImpl)) void _;
    };
    await expect(run()).rejects.toBeInstanceOf(LlmHttpError);
  });

  it('rejects when only reasoning arrives and there is no fallback', async () => {
    const fetchImpl = (async () => sse([reasoning('thinking'), '[DONE]'])) as unknown as typeof fetch;
    const run = async () => {
      for await (const _ of streamChatWithFallback(cfg, undefined, msgs, fetchImpl)) void _;
    };
    await expect(run()).rejects.toThrow('LLM stream produced no content');
  });

  it('falls back when the primary stream carries only reasoning deltas', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://llm.test')) return sse([reasoning('thinking'), '[DONE]']);
      return sse([delta('answer'), '[DONE]']);
    }) as unknown as typeof fetch;
    const out: string[] = [];
    for await (const d of streamChatWithFallback(cfg, fb, msgs, fetchImpl)) out.push(d);
    expect(out).toEqual(['answer']);
    expect(calls).toEqual(['https://llm.test/v1/chat/completions', 'https://fb.test/v1/chat/completions']);
    warn.mockRestore();
  });
});
