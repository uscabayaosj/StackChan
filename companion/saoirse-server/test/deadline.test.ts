import { describe, it, expect } from 'vitest';
import { callWithDeadline, streamWithDeadline } from '../src/deadline.js';

const never = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

async function collect<T>(gen: AsyncIterable<T>, delayMs = 0): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) { out.push(v); if (delayMs) await new Promise(r => setTimeout(r, delayMs)); }
  return out;
}

describe('callWithDeadline', () => {
  it('resolves with the result when the call finishes in time', async () => {
    expect(await callWithDeadline('STT', 1000, new AbortController().signal, async () => 'hi')).toBe('hi');
  });
  it('rejects with a labelled timeout and aborts the signal the call got', async () => {
    let seen: AbortSignal | undefined;
    await expect(callWithDeadline('STT', 20, new AbortController().signal, s => { seen = s; return never(s); }))
      .rejects.toThrow('STT timed out after 20 ms');
    expect(seen?.aborted).toBe(true);
  });
  it('rejects even when the call ignores its signal', async () => {
    await expect(callWithDeadline('STT', 20, new AbortController().signal, () => new Promise<never>(() => {})))
      .rejects.toThrow('STT timed out after 20 ms');
  });
  it('passes a session abort through unlabelled', async () => {
    const ac = new AbortController();
    const p = callWithDeadline('STT', 1000, ac.signal, never);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('streamWithDeadline', () => {
  it('bounds the upstream call, not a consumer that plays the result out slowly', async () => {
    async function* fast() { yield 1; yield 2; yield 3; }
    // The consumer takes ~3 x 30 ms, far past the 40 ms deadline; the producer finished at once.
    expect(await collect(streamWithDeadline('TTS', 40, new AbortController().signal, fast), 30)).toEqual([1, 2, 3]);
  });
  it('throws a labelled timeout when the producer stalls, after what it already produced', async () => {
    async function* stall(signal: AbortSignal) { yield 'a'; await never(signal); }
    const out: string[] = [];
    const run = async () => { for await (const v of streamWithDeadline('LLM', 30, new AbortController().signal, stall)) out.push(v); };
    await expect(run()).rejects.toThrow('LLM timed out after 30 ms');
    expect(out).toEqual(['a']);
  });
  it('throws a labelled timeout even when the producer ignores its signal', async () => {
    async function* hang() { yield 'a'; await new Promise(() => {}); }
    const run = async () => { for await (const _ of streamWithDeadline('LLM', 30, new AbortController().signal, hang)) void _; };
    await expect(run()).rejects.toThrow('LLM timed out after 30 ms');
  });
  it('propagates a producer error', async () => {
    async function* boom() { yield 1; throw new Error('boom'); }
    await expect(collect(streamWithDeadline('LLM', 1000, new AbortController().signal, boom))).rejects.toThrow('boom');
  });
  it('aborts the producer signal when the consumer stops early', async () => {
    let seen: AbortSignal | undefined;
    async function* many(signal: AbortSignal) { seen = signal; for (let i = 0; ; i++) { yield i; await new Promise(r => setTimeout(r, 1)); if (signal.aborted) return; } }
    for await (const v of streamWithDeadline('LLM', 1000, new AbortController().signal, many)) if (v === 2) break;
    expect(seen?.aborted).toBe(true);
  });
});
