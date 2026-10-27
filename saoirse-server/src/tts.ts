import type { Config } from './config.js';
import { FRAME_BYTES, padFrame, type OpusCodec } from './opus.js';

export async function* synthesizeToFrames(
  cfg: Config['elevenlabs'],
  text: string,
  codec: OpusCodec,
  fetchImpl: typeof fetch = fetch,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<Buffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream?output_format=pcm_16000`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.ttsModel }),
    signal: opts?.signal,
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  if (!res.body) throw new Error('TTS response had no body');

  const reader = res.body.getReader();
  try {
    let pending = Buffer.alloc(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending = pending.length ? Buffer.concat([pending, Buffer.from(value)]) : Buffer.from(value);
      while (pending.length >= FRAME_BYTES) {
        yield codec.encodeFrame(pending.subarray(0, FRAME_BYTES));
        pending = pending.subarray(FRAME_BYTES);
      }
    }
    if (pending.length > 0) yield codec.encodeFrame(padFrame(pending));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
