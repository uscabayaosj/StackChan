import { describe, it, expect } from 'vitest';
import { streamChat, streamChatWithFallback } from '../src/llm.js';

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
  });
});
