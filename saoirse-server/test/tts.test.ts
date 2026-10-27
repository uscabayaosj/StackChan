import { describe, it, expect } from 'vitest';
import { synthesizeToFrames } from '../src/tts.js';
import { FRAME_BYTES } from '../src/opus.js';

const fakeCodec = { encodeFrame: (pcm: Buffer) => Buffer.from([pcm.length & 0xff, 1, 2]), decode: (p: Buffer) => Buffer.alloc(FRAME_BYTES) };
const cfg = { apiKey: 'e', voiceId: 'voice123', ttsModel: 'eleven_flash_v2_5', sttModel: 's' };

describe('synthesizeToFrames', () => {
  it('requests pcm_16000 for the voice and frames the stream into 60 ms packets', async () => {
    let captured: any;
    const chunks = [Buffer.alloc(1000), Buffer.alloc(1000), Buffer.alloc(100)]; // 2100 bytes -> 2 frames (padded)
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, init };
      const stream = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close(); } });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const frames: Buffer[] = [];
    for await (const f of synthesizeToFrames(cfg, 'Hello.', fakeCodec, fetchImpl)) frames.push(f);
    expect(frames).toHaveLength(2);
    expect(frames.every(f => f.length === 3)).toBe(true);
    expect(captured.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=pcm_16000');
    expect(JSON.parse(captured.init.body)).toEqual({ text: 'Hello.', model_id: 'eleven_flash_v2_5' });
    expect(captured.init.headers['xi-api-key']).toBe('e');
  });
  it('throws on a non-2xx', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 422 })) as unknown as typeof fetch;
    const gen = synthesizeToFrames(cfg, 'x', fakeCodec, fetchImpl);
    await expect(gen.next()).rejects.toThrow(/422/);
  });
});
