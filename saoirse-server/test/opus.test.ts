import { describe, it, expect } from 'vitest';
import { createCodec, pcmToFrames, rms, frameBytesFor, FRAME_BYTES, FRAME_SAMPLES, OUT_FRAME_BYTES, OUT_FRAME_SAMPLES, type CodecKind } from '../src/opus.js';

// The native @discordjs/opus encoder segfaults (uncatchable) on quiet audio on
// darwin-arm64, so every native test is opt-in: OPUS_TEST_NATIVE=1 npm test.
const RUN_NATIVE = process.env.OPUS_TEST_NATIVE === '1';

function sine(samples: number, amp = 8000, freq = 440, rate = 16000): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  return b;
}
const sym16 = { encodeRate: 16000, decodeRate: 16000 };
const sym24 = { encodeRate: 24000, decodeRate: 24000 };

describe('opus', () => {
  it('frame sizes: 60 ms is 1920 bytes at 16 kHz (input) and 2880 bytes at 24 kHz (output)', () => {
    expect(FRAME_BYTES).toBe(1920);
    expect(OUT_FRAME_BYTES).toBe(2880);
    expect(frameBytesFor(16000)).toBe(FRAME_BYTES);
    expect(frameBytesFor(24000)).toBe(OUT_FRAME_BYTES);
  });

  it('splits PCM into 60 ms frames and zero-pads the tail', () => {
    const frames = pcmToFrames(Buffer.alloc(FRAME_BYTES * 2 + 100));
    expect(frames).toHaveLength(3);
    expect(frames.every(f => f.length === FRAME_BYTES)).toBe(true);
    expect(frames[2].subarray(100).every(b => b === 0)).toBe(true);
  });

  function codecSuite(kind: CodecKind) {
    it('default rates: encodes 24 kHz frames for the robot speaker, decodes 16 kHz packets from its microphone', () => {
      const codec = createCodec(kind);
      const packet = codec.encodeFrame(sine(OUT_FRAME_SAMPLES, 8000, 440, 24000));
      expect(packet.length).toBeGreaterThan(10);
      expect(packet.length).toBeLessThan(400);
      const played = createCodec(kind, sym24).decode(packet); // what the robot hears, at its 24 kHz
      expect(played.length).toBe(OUT_FRAME_BYTES);
      expect(rms(played)).toBeGreaterThan(0.12);
      const heard = codec.decode(createCodec(kind, sym16).encodeFrame(sine(FRAME_SAMPLES))); // what the robot sent, at 16 kHz
      expect(heard.length).toBe(FRAME_BYTES);
      expect(rms(heard)).toBeGreaterThan(0.12);
    });
    it('default rates reject a 16 kHz-sized frame (the encoder is 24 kHz)', () => {
      expect(() => createCodec(kind).encodeFrame(sine(FRAME_SAMPLES))).toThrow(RangeError);
      expect(() => createCodec(kind).encodeFrame(Buffer.alloc(100))).toThrow(RangeError);
    });
    it('symmetric 16 kHz round-trips a frame', () => {
      const codec = createCodec(kind, sym16);
      const pcm = codec.decode(codec.encodeFrame(sine(FRAME_SAMPLES)));
      expect(pcm.length).toBe(FRAME_BYTES);
      expect(rms(pcm)).toBeGreaterThan(0.12);
    });
    it.each([1500, 200])('encodes a quiet 24 kHz sine (amplitude %i) without throwing', (amp) => {
      const codec = createCodec(kind);
      const packet = codec.encodeFrame(sine(OUT_FRAME_SAMPLES, amp, 440, 24000));
      expect(createCodec(kind, sym24).decode(packet).length).toBe(OUT_FRAME_BYTES);
    });
  }

  describe('wasm codec', () => {
    codecSuite('wasm');
    it('dispose frees both directions; later use throws instead of touching freed memory; twice is harmless', () => {
      const codec = createCodec('wasm');
      codec.dispose?.();
      codec.dispose?.();
      expect(() => codec.encodeFrame(sine(OUT_FRAME_SAMPLES, 8000, 440, 24000))).toThrow(/disposed/);
      expect(() => codec.decode(Buffer.from([1, 2, 3]))).toThrow(/disposed/);
      const sym = createCodec('wasm', sym16);
      sym.dispose?.();
      expect(() => sym.encodeFrame(sine(FRAME_SAMPLES))).toThrow(/disposed/);
    });
  });

  describe.skipIf(!RUN_NATIVE)('native codec (OPUS_TEST_NATIVE=1)', () => {
    codecSuite('native');
  });

  describe('default (auto) codec', () => {
    // Regression: auto used to pick the native encoder, which segfaults here.
    codecSuite('auto');
  });

  it('rms is 0 for silence and ~0.17 for a 8000-amplitude sine', () => {
    expect(rms(Buffer.alloc(FRAME_BYTES))).toBe(0);
    expect(rms(sine(FRAME_SAMPLES))).toBeCloseTo(0.17, 1);
  });
});
