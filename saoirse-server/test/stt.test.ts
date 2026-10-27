import { describe, it, expect } from 'vitest';
import { pcmToWav, wavToPcm } from '../src/wav.js';
import { transcribe } from '../src/stt.js';

describe('pcmToWav', () => {
  it('writes a 44-byte RIFF header for 16 kHz mono 16-bit', () => {
    const wav = pcmToWav(Buffer.alloc(1920));
    expect(wav.length).toBe(44 + 1920);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(1920);
  });
});

describe('wavToPcm', () => {
  it('round-trips pcmToWav output', () => {
    const pcm = Buffer.from(Array.from({ length: 1920 }, (_, i) => (i * 7) & 0xff));
    const out = wavToPcm(pcmToWav(pcm));
    expect(out.pcm.equals(pcm)).toBe(true);
    expect(out.sampleRate).toBe(16000);
    expect(out.channels).toBe(1);
  });
  it('skips an odd-sized padded LIST chunk and tolerates a truncated data chunk', () => {
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(16000, 12);
    fmt.writeUInt32LE(32000, 16);
    fmt.writeUInt16LE(2, 20);
    fmt.writeUInt16LE(16, 22);
    // LIST chunk with an odd payload size (5) followed by one pad byte.
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([5, 0, 0, 0]), Buffer.from('abcde'), Buffer.from([0])]);
    const samples = Buffer.from([1, 2, 3, 4, 5, 6]);
    const dataHeader = Buffer.alloc(8);
    dataHeader.write('data', 0, 'ascii');
    dataHeader.writeUInt32LE(1000, 4); // claims far more than is present
    const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, dataHeader, samples]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(body.length, 4);
    const out = wavToPcm(Buffer.concat([riff, body]));
    expect(out.pcm.equals(samples)).toBe(true);
    expect(out.sampleRate).toBe(16000);
    expect(out.channels).toBe(1);
  });
});

describe('transcribe', () => {
  it('posts multipart to ElevenLabs and returns text', async () => {
    let captured: any;
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, init };
      return new Response(JSON.stringify({ text: ' hello there ' }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await transcribe({ apiKey: 'e', voiceId: 'v', ttsModel: 't', sttModel: 'scribe_v2' }, Buffer.alloc(3840), fetchImpl);
    expect(text).toBe('hello there');
    expect(captured.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(captured.init.headers['xi-api-key']).toBe('e');
    const form: FormData = captured.init.body;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('file_format')).toBe('pcm_s16le_16');
    expect((form.get('file') as Blob).size).toBe(3840);
  });
  it('throws on a non-2xx', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(transcribe({ apiKey: 'e', voiceId: 'v', ttsModel: 't', sttModel: 'scribe_v2' }, Buffer.alloc(10), fetchImpl)).rejects.toThrow(/401/);
  });
  it('passes the abort signal to fetch', async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_u: string, init: any) => {
      seen = init.signal;
      return new Response(JSON.stringify({ text: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    await transcribe({ apiKey: 'e', voiceId: 'v', ttsModel: 't', sttModel: 's' }, Buffer.alloc(10), fetchImpl, { signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });
});
