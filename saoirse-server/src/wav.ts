export function pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Reads a 16-bit PCM WAV and returns its samples (used by the fake robot). */
export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12;
  let sampleRate = 16000;
  let channels = 1;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(off + 10);
      sampleRate = wav.readUInt32LE(off + 12);
    } else if (id === 'data') {
      return { pcm: wav.subarray(off + 8, off + 8 + size), sampleRate, channels };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
