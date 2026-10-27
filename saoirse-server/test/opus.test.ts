import { describe, it, expect } from 'vitest';
import { createCodec, pcmToFrames, rms, FRAME_BYTES, FRAME_SAMPLES } from '../src/opus.js';

// The native @discordjs/opus encoder segfaults (uncatchable) on quiet audio on
// darwin-arm64, so every native test is opt-in: OPUS_TEST_NATIVE=1 npm test.
const RUN_NATIVE = process.env.OPUS_TEST_NATIVE === '1';

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

  describe('wasm codec', () => {
    it('round-trips a frame through the encoder and decoder', () => {
      const codec = createCodec('wasm');
      const packet = codec.encodeFrame(sine(FRAME_SAMPLES));
      expect(packet.length).toBeGreaterThan(10);
      expect(packet.length).toBeLessThan(400);
      const pcm = codec.decode(packet);
      expect(pcm.length).toBe(FRAME_BYTES);
      expect(rms(pcm)).toBeGreaterThan(0.12);
    });
    it.each([1500, 200])('round-trips a quiet sine (amplitude %i) without throwing', (amp) => {
      const codec = createCodec('wasm');
      const pcm = codec.decode(codec.encodeFrame(sine(FRAME_SAMPLES, amp)));
      expect(pcm.length).toBe(FRAME_BYTES);
    });
    it('rejects a frame that is not exactly FRAME_BYTES', () => {
      const codec = createCodec('wasm');
      expect(() => codec.encodeFrame(Buffer.alloc(100))).toThrow(RangeError);
    });
  });

  describe.skipIf(!RUN_NATIVE)('native codec (OPUS_TEST_NATIVE=1)', () => {
    it('round-trips a frame through the encoder and decoder', () => {
      const codec = createCodec('native');
      const packet = codec.encodeFrame(sine(FRAME_SAMPLES));
      expect(packet.length).toBeGreaterThan(10);
      expect(packet.length).toBeLessThan(400);
      const pcm = codec.decode(packet);
      expect(pcm.length).toBe(FRAME_BYTES);
      expect(rms(pcm)).toBeGreaterThan(0.12);
    });
    it('rejects a frame that is not exactly FRAME_BYTES', () => {
      const codec = createCodec('native');
      expect(() => codec.encodeFrame(Buffer.alloc(100))).toThrow(RangeError);
    });
  });

  describe('default (auto) codec', () => {
    it('round-trips a frame', () => {
      const codec = createCodec();
      expect(rms(codec.decode(codec.encodeFrame(sine(FRAME_SAMPLES))))).toBeGreaterThan(0.12);
    });
    // Regression: auto used to pick the native encoder, which segfaults here.
    it.each([1500, 200])('encodes a quiet sine (amplitude %i) without crashing', (amp) => {
      const codec = createCodec();
      expect(codec.decode(codec.encodeFrame(sine(FRAME_SAMPLES, amp))).length).toBe(FRAME_BYTES);
    });
  });

  it('rms is 0 for silence and ~0.17 for a 8000-amplitude sine', () => {
    expect(rms(Buffer.alloc(FRAME_BYTES))).toBe(0);
    expect(rms(sine(FRAME_SAMPLES))).toBeCloseTo(0.17, 1);
  });
});
