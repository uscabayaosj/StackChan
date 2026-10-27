import { describe, it, expect } from 'vitest';
import { createCodec, pcmToFrames, rms, FRAME_BYTES, FRAME_SAMPLES } from '../src/opus.js';

function sine(samples: number, amp = 8000, freq = 440, rate = 16000): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  return b;
}

describe('opus', () => {
  it('splits PCM into 60 ms frames and zero-pads the tail', () => {
    const frames = pcmToFrames(Buffer.alloc(FRAME_BYTES * 2 + 100));
    expect(frames).toHaveLength(3);
    expect(frames.every(f => f.length === FRAME_BYTES)).toBe(true);
    expect(frames[2].subarray(100).every(b => b === 0)).toBe(true);
  });
  it('round-trips a frame through the encoder and decoder', () => {
    const codec = createCodec();
    const packet = codec.encodeFrame(sine(FRAME_SAMPLES));
    expect(packet.length).toBeGreaterThan(10);
    expect(packet.length).toBeLessThan(400);
    const pcm = codec.decode(packet);
    expect(pcm.length).toBe(FRAME_BYTES);
    expect(rms(pcm)).toBeGreaterThan(0.05);
  });
  it('rms is 0 for silence and ~0.17 for a 8000-amplitude sine', () => {
    expect(rms(Buffer.alloc(FRAME_BYTES))).toBe(0);
    expect(rms(sine(FRAME_SAMPLES))).toBeCloseTo(0.17, 1);
  });
});
