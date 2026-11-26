import type { Config } from './config.js';
import { OUT_FRAME_BYTES, OUTPUT_SAMPLE_RATE, padFrame, type OpusCodec } from './opus.js';

const LIMITER_KNEE = 24_576;
const LIMITER_HEADROOM = 32_000 - LIMITER_KNEE;

export async function* synthesizeToFrames(
  cfg: Config['elevenlabs'],
  text: string,
  codec: OpusCodec,
  fetchImpl: typeof fetch = fetch,
  opts?: { signal?: AbortSignal; gain?: number },
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

  const gain = opts?.gain ?? 1;
  const encode = (pcm: Buffer) => {
    if (gain === 1) return codec.encodeFrame(pcm);
    const amplified = Buffer.from(pcm);
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(i) * gain;
      const magnitude = Math.abs(sample);
      const over = magnitude - LIMITER_KNEE;
      // Keep the requested gain below the knee and smoothly compress peaks above it.
      const limited = over > 0 ? LIMITER_KNEE + LIMITER_HEADROOM * over / (LIMITER_HEADROOM + over) : magnitude;
      amplified.writeInt16LE(Math.round(Math.sign(sample) * limited), i);
    }
    return codec.encodeFrame(amplified);
  };
  const reader = res.body.getReader();
  try {
    let pending = Buffer.alloc(0);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending = pending.length ? Buffer.concat([pending, Buffer.from(value)]) : Buffer.from(value);
      while (pending.length >= OUT_FRAME_BYTES) {
        yield encode(pending.subarray(0, OUT_FRAME_BYTES));
        pending = pending.subarray(OUT_FRAME_BYTES);
      }
    }
    if (pending.length > 0) yield encode(padFrame(pending, OUT_FRAME_BYTES));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
