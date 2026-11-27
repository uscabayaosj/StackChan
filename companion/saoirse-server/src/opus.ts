import { createRequire } from 'node:module';

/** Audio the robot sends us (its microphone): the xiaozhi device hello pins this to 16 kHz. */
export const INPUT_SAMPLE_RATE = 16000;
/**
 * Audio we send the robot. Its speaker codec runs at 24 kHz; sending 24 kHz Opus lets the
 * firmware play it straight out instead of resampling 16 kHz up (which it warns "may cause distortion").
 */
export const OUTPUT_SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const FRAME_MS = 60;
export const FRAME_SAMPLES = (INPUT_SAMPLE_RATE * FRAME_MS) / 1000; // 960
/** One input (16 kHz) frame of 16-bit mono PCM. */
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 1920
export const OUT_FRAME_SAMPLES = (OUTPUT_SAMPLE_RATE * FRAME_MS) / 1000; // 1440
/** One output (24 kHz) frame of 16-bit mono PCM: what `encodeFrame` takes on the default codec. */
export const OUT_FRAME_BYTES = OUT_FRAME_SAMPLES * 2; // 2880

export interface OpusCodec {
  /** Encodes one 60 ms frame of 16-bit mono PCM at the codec's encode rate (exactly `frameBytesFor(encodeRate)` bytes). */
  encodeFrame(pcm: Buffer): Buffer;
  /** Decodes one Opus packet to 16-bit mono PCM at the codec's decode rate. */
  decode(packet: Buffer): Buffer;
  /** Release native/WASM resources; the codec must not be used afterwards. Safe to call twice. */
  dispose?(): void;
}

/** Sample rates for the two directions. Defaults match the robot: encode (to it) 24 kHz, decode (from it) 16 kHz. */
export interface CodecRates {
  encodeRate?: number;
  decodeRate?: number;
}

export function frameBytesFor(sampleRate: number): number {
  return ((sampleRate * FRAME_MS) / 1000) * 2;
}

const require = createRequire(import.meta.url);

// The native encoder hard-aborts the process (uncatchable) on a wrong-sized buffer.
function assertFrame(pcm: Buffer, frameBytes: number): void {
  if (pcm.length !== frameBytes) throw new RangeError(`encodeFrame expects ${frameBytes} bytes, got ${pcm.length}`);
}

function nativeCodec(encodeRate: number, decodeRate: number): OpusCodec {
  const { OpusEncoder } = require('@discordjs/opus') as { OpusEncoder: new (rate: number, ch: number) => any };
  const frameBytes = frameBytesFor(encodeRate);
  const enc = new OpusEncoder(encodeRate, CHANNELS);
  enc.setBitrate(24000);
  const dec = decodeRate === encodeRate ? enc : new OpusEncoder(decodeRate, CHANNELS);
  return {
    encodeFrame: (pcm) => {
      assertFrame(pcm, frameBytes);
      return Buffer.from(enc.encode(pcm));
    },
    decode: (packet) => Buffer.from(dec.decode(packet)),
    // The native encoder is freed by the garbage collector.
    dispose: () => {},
  };
}

function wasmCodec(encodeRate: number, decodeRate: number): OpusCodec {
  const OpusScript = require('opusscript') as any;
  const frameSamples = (encodeRate * FRAME_MS) / 1000;
  const frameBytes = frameSamples * 2;
  const enc = new OpusScript(encodeRate, CHANNELS, OpusScript.Application.VOIP);
  enc.setBitrate(24000);
  const dec = decodeRate === encodeRate ? enc : new OpusScript(decodeRate, CHANNELS, OpusScript.Application.VOIP);
  let disposed = false;
  // opusscript lives in a WASM heap that is never garbage collected: delete() frees it.
  // A late call (e.g. a TTS stream still unwinding after the socket closed) throws instead of using freed memory.
  const live = () => { if (disposed) throw new Error('opus codec disposed'); };
  return {
    encodeFrame: (pcm) => {
      live();
      assertFrame(pcm, frameBytes);
      return Buffer.from(enc.encode(pcm, frameSamples));
    },
    decode: (packet) => {
      live();
      return Buffer.from(dec.decode(packet));
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      enc.delete();
      if (dec !== enc) dec.delete();
    },
  };
}

let warnedNativeUnavailable = false;

export type CodecKind = 'auto' | 'native' | 'wasm';

/**
 * 'auto' resolves to the WASM codec (opusscript) unless OPUS_CODEC=native.
 * The native @discordjs/opus encoder is faster, but 0.10.0 segfaults the whole
 * Node process (uncatchable, exit 139) on quiet audio on macOS arm64, so it is
 * opt-in only. If native was requested via the env var and fails to load, we
 * warn once and fall back to WASM. Explicit 'native' / 'wasm' are honoured as is.
 */
export function createCodec(kind: CodecKind = 'auto', rates: CodecRates = {}): OpusCodec {
  const encodeRate = rates.encodeRate ?? OUTPUT_SAMPLE_RATE;
  const decodeRate = rates.decodeRate ?? INPUT_SAMPLE_RATE;
  if (kind === 'native') return nativeCodec(encodeRate, decodeRate);
  if (kind === 'wasm') return wasmCodec(encodeRate, decodeRate);
  if (process.env.OPUS_CODEC !== 'native') return wasmCodec(encodeRate, decodeRate);
  try {
    return nativeCodec(encodeRate, decodeRate);
  } catch (err) {
    if (!warnedNativeUnavailable) {
      warnedNativeUnavailable = true;
      console.warn('[opus] native @discordjs/opus unavailable, using opusscript:', (err as Error).message);
    }
    return wasmCodec(encodeRate, decodeRate);
  }
}

/** Returns `pcm` unchanged if it is already one frame of `frameBytes`, else a zero-padded copy. */
export function padFrame(pcm: Buffer, frameBytes: number = FRAME_BYTES): Buffer {
  if (pcm.length === frameBytes) return pcm;
  const padded = Buffer.alloc(frameBytes);
  pcm.copy(padded);
  return padded;
}

/** Splits 16 kHz input PCM into 60 ms frames, zero-padding the tail. */
export function pcmToFrames(pcm: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    frames.push(padFrame(pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length))));
  }
  return frames;
}

export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    acc += s * s;
  }
  return Math.sqrt(acc / n);
}
