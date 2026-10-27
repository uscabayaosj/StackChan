import { createRequire } from 'node:module';

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const FRAME_MS = 60;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 960
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 1920

export interface OpusCodec {
  encodeFrame(pcm: Buffer): Buffer;
  decode(packet: Buffer): Buffer;
}

const require = createRequire(import.meta.url);

function nativeCodec(): OpusCodec {
  const { OpusEncoder } = require('@discordjs/opus') as { OpusEncoder: new (rate: number, ch: number) => any };
  const enc = new OpusEncoder(SAMPLE_RATE, CHANNELS);
  enc.setBitrate(24000);
  return {
    encodeFrame: (pcm) => Buffer.from(enc.encode(pcm)),
    decode: (packet) => Buffer.from(enc.decode(packet)),
  };
}

function wasmCodec(): OpusCodec {
  const OpusScript = require('opusscript') as any;
  const enc = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
  enc.setBitrate(24000);
  return {
    encodeFrame: (pcm) => Buffer.from(enc.encode(pcm, FRAME_SAMPLES)),
    decode: (packet) => Buffer.from(enc.decode(packet)),
  };
}

export function createCodec(): OpusCodec {
  try {
    return nativeCodec();
  } catch (err) {
    console.warn('[opus] native @discordjs/opus unavailable, using opusscript:', (err as Error).message);
    return wasmCodec();
  }
}

export function pcmToFrames(pcm: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    const chunk = pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length));
    if (chunk.length === FRAME_BYTES) frames.push(chunk);
    else {
      const padded = Buffer.alloc(FRAME_BYTES);
      chunk.copy(padded);
      frames.push(padded);
    }
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
