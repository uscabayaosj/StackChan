import { describe, it, expect, vi } from 'vitest';
import { streamChat, streamChatWithFallback, LlmHttpError } from '../src/llm.js';

function sse(lines: string[]): Response {
  const body = lines.map(l => `data: ${l}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const cfg = { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', providerOrder: ['groq'] };

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
    expect(captured.init.headers.Authorization).toBe('Bearer k');
  });
  it('falls back to the second model on a 5xx', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://llm.test')) return new Response('boom', { status: 503 });
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), '[DONE]']);
    }) as unknown as typeof fetch;
    const fb = { baseUrl: 'https://fb.test/v1', apiKey: 'f', model: 'fm' };
    const out: string[] = [];
    for await (const d of streamChatWithFallback(cfg, fb, [{ role: 'user', content: 'hi' }], fetchImpl)) out.push(d);
    expect(out.join('')).toBe('ok');
    expect(calls).toEqual(['https://llm.test/v1/chat/completions', 'https://fb.test/v1/chat/completions']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

const fb = { baseUrl: 'https://fb.test/v1', apiKey: 'f', model: 'fm' };
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
      return sse(['[DONE]']);
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
