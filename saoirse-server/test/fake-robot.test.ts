import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createCodec, FRAME_BYTES } from '../src/opus.js';
import { pcmToWav } from '../src/wav.js';
import { runFakeRobot } from '../src/fake_robot.js';
import type { SessionDeps } from '../src/session.js';

const cfg = loadConfig({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'ws://x', SAOIRSE_DEVICE_TOKEN: 'tok' });

let server: ReturnType<typeof createAppServer> | undefined;
let dir: string | undefined;
afterEach(async () => {
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** 0.6 s of a loud 440 Hz tone: enough for the energy VAD to count as speech. */
function toneWav(): Buffer {
  const n = 16000 * 0.6;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  return pcmToWav(pcm);
}

describe('runFakeRobot', () => {
  it('drives a full conversation against the server with fake STT/LLM/TTS', async () => {
    const codec = createCodec();
    const deps: SessionDeps = {
      config: cfg,
      codec,
      transcribe: async () => 'what time is it',
      chat: async function* () { yield '[doubtful] Late. You know that.'; },
      synthesize: async function* () {
        yield codec.encodeFrame(Buffer.alloc(FRAME_BYTES));
        yield codec.encodeFrame(Buffer.alloc(FRAME_BYTES));
      },
      now: () => Date.now(),
      sleep: async () => {},
      log: () => {},
    };
    server = createAppServer(cfg, deps);
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    dir = mkdtempSync(join(tmpdir(), 'fake-robot-'));
    const wavPath = join(dir, 'question.wav');
    const outPath = join(dir, 'reply.wav');
    writeFileSync(wavPath, toneWav());

    const result = await runFakeRobot({ url: `ws://127.0.0.1:${port}/api/ws`, token: 'tok', wavPath, outPath, log: () => {} });

    expect(result.stt).toBe('what time is it');
    expect(result.emotion).toBe('doubtful');
    expect(result.sentences).toEqual(['Late.', 'You know that.']);
    expect(result.replyFrames).toBe(4);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).length).toBe(44 + 4 * FRAME_BYTES);
  }, 15_000);

  it('rejects a WAV that is not 16 kHz mono', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fake-robot-'));
    const wavPath = join(dir, 'stereo.wav');
    writeFileSync(wavPath, pcmToWav(Buffer.alloc(3840), 44100, 2));
    await expect(runFakeRobot({ url: 'ws://127.0.0.1:1/api/ws', token: '', wavPath, outPath: join(dir, 'o.wav'), log: () => {} })).rejects.toThrow(/16 kHz mono/);
  });
});
