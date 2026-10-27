import type { Config } from './config.js';
import { OUT_FRAME_BYTES, OUTPUT_SAMPLE_RATE, padFrame, type OpusCodec } from './opus.js';

export async function* synthesizeToFrames(
  cfg: Config['elevenlabs'],
  text: string,
  codec: OpusCodec,
  fetchImpl: typeof fetch = fetch,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<Buffer> {
  // PCM at the robot's speaker rate (24 kHz), framed into 60 ms Opus packets by the codec's 24 kHz encoder.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream?output_format=pcm_${OUTPUT_SAMPLE_RATE}`;
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
      while (pending.length >= OUT_FRAME_BYTES) {
        yield codec.encodeFrame(pending.subarray(0, OUT_FRAME_BYTES));
        pending = pending.subarray(OUT_FRAME_BYTES);
      }
    }
    if (pending.length > 0) yield codec.encodeFrame(padFrame(pending, OUT_FRAME_BYTES));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
