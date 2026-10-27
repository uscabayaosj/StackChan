import { describe, it, expect } from 'vitest';
import { synthesizeToFrames } from '../src/tts.js';
import { FRAME_BYTES } from '../src/opus.js';

// Throws like the real codec unless handed exactly one frame; records every PCM input.
function makeCodec() {
  const inputs: Buffer[] = [];
  return {
    inputs,
    encodeFrame: (pcm: Buffer) => {
      if (pcm.length !== FRAME_BYTES) throw new RangeError(`bad frame size ${pcm.length}`);
      inputs.push(Buffer.from(pcm));
      return Buffer.from([inputs.length & 0xff, 1, 2]);
    },
    decode: (_p: Buffer) => Buffer.alloc(FRAME_BYTES),
  };
}
const cfg = { apiKey: 'e', voiceId: 'voice123', ttsModel: 'eleven_flash_v2_5', sttModel: 's' };

// With onCancel set the stream stays open (like a live HTTP body), so cancel() reaches the source.
function streamFetch(chunks: Buffer[], onCancel?: () => void, onInit?: (url: string, init: any) => void) {
  return (async (url: string, init: any) => {
    onInit?.(url, init);
    const stream = new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); if (!onCancel) c.close(); },
      cancel() { onCancel?.(); },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

async function collect(gen: AsyncGenerator<Buffer>) {
  const out: Buffer[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe('synthesizeToFrames', () => {
  it('requests pcm_16000 for the voice and frames the stream into 60 ms packets', async () => {
    let captured: any;
    const chunks = [Buffer.alloc(1000, 7), Buffer.alloc(1000, 7), Buffer.alloc(100, 7)]; // 2100 bytes -> 2 frames (padded)
    const codec = makeCodec();
    const frames = await collect(
      synthesizeToFrames(cfg, 'Hello.', codec, streamFetch(chunks, undefined, (url, init) => { captured = { url, init }; })),
    );
    expect(frames).toHaveLength(2);
    expect(frames.every(f => f.length === 3)).toBe(true);
    expect(captured.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=pcm_16000');
    expect(JSON.parse(captured.init.body)).toEqual({ text: 'Hello.', model_id: 'eleven_flash_v2_5' });
    expect(captured.init.headers['xi-api-key']).toBe('e');
    // padded tail: 2100 - 1920 = 180 data bytes, then zeros
    const tail = codec.inputs[1];
    expect(tail.subarray(0, 180).every(b => b === 7)).toBe(true);
    expect(tail.subarray(180).every(b => b === 0)).toBe(true);
    expect(tail.subarray(180).length).toBe(FRAME_BYTES - 180);
  });

  it('url-encodes the voice id', async () => {
    let url = '';
    await collect(synthesizeToFrames({ ...cfg, voiceId: 'a/b c?' }, 'x', makeCodec(), streamFetch([], undefined, (u) => { url = u; })));
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/a%2Fb%20c%3F/stream?output_format=pcm_16000');
  });

  it('reassembles odd-sized chunks (1001 + 999 + 7 bytes)', async () => {
    const codec = makeCodec();
    const frames = await collect(
      synthesizeToFrames(cfg, 'x', codec, streamFetch([Buffer.alloc(1001, 1), Buffer.alloc(999, 1), Buffer.alloc(7, 1)])),
    );
    expect(frames).toHaveLength(2); // 2007 bytes: one full frame + 87-byte padded tail
    expect(codec.inputs[1].subarray(0, 87).every(b => b === 1)).toBe(true);
    expect(codec.inputs[1].subarray(87).every(b => b === 0)).toBe(true);
  });

  it('yields zero frames for an empty 2xx body', async () => {
    const frames = await collect(synthesizeToFrames(cfg, 'x', makeCodec(), streamFetch([])));
    expect(frames).toHaveLength(0);
  });

  it('splits one chunk spanning several frames (5000 bytes -> 2 full + padded tail)', async () => {
    const codec = makeCodec();
    const frames = await collect(synthesizeToFrames(cfg, 'x', codec, streamFetch([Buffer.alloc(5000, 3)])));
    expect(frames).toHaveLength(3);
    expect(codec.inputs[2].subarray(0, 5000 - 2 * FRAME_BYTES).every(b => b === 3)).toBe(true);
    expect(codec.inputs[2].subarray(5000 - 2 * FRAME_BYTES).every(b => b === 0)).toBe(true);
  });

  it('cancels the HTTP body when the consumer returns early', async () => {
    let cancelled = false;
    const gen = synthesizeToFrames(cfg, 'x', makeCodec(), streamFetch([Buffer.alloc(FRAME_BYTES * 3)], () => { cancelled = true; }));
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(cancelled).toBe(false);
    await gen.return(undefined);
    expect(cancelled).toBe(true);
  });

  it('cancels the HTTP body when encodeFrame throws', async () => {
    let cancelled = false;
    const codec = { ...makeCodec(), encodeFrame: () => { throw new Error('boom'); } };
    const gen = synthesizeToFrames(cfg, 'x', codec, streamFetch([Buffer.alloc(FRAME_BYTES)], () => { cancelled = true; }));
    await expect(gen.next()).rejects.toThrow('boom');
    expect(cancelled).toBe(true);
  });

  it('passes the AbortSignal through to fetch', async () => {
    const ac = new AbortController();
    let init: any;
    await collect(synthesizeToFrames(cfg, 'x', makeCodec(), streamFetch([], undefined, (_u, i) => { init = i; }), { signal: ac.signal }));
    expect(init.signal).toBe(ac.signal);
  });

  it('throws on a non-2xx', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 422 })) as unknown as typeof fetch;
    const gen = synthesizeToFrames(cfg, 'x', makeCodec(), fetchImpl);
    await expect(gen.next()).rejects.toThrow(/422/);
  });

  it('throws a no-body error on a 2xx with a null body', async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const gen = synthesizeToFrames(cfg, 'x', makeCodec(), fetchImpl);
    await expect(gen.next()).rejects.toThrow('TTS response had no body');
  });
});
