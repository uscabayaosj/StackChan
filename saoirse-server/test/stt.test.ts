import { describe, it, expect } from 'vitest';
import { pcmToWav } from '../src/wav.js';
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
});
