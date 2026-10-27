import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { createCodec, pcmToFrames, FRAME_MS, FRAME_BYTES, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, type OpusCodec } from './opus.js';
import { wavToPcm, pcmToWav } from './wav.js';

export interface FakeRobotOptions {
  url: string;
  token: string;
  wavPath: string;
  outPath: string;
  log: (msg: string) => void;
  /** Give up (and reject) if the conversation has not finished by then. Default 60 s. */
  timeoutMs?: number;
}

export interface FakeRobotResult {
  stt: string;
  emotion: string;
  sentences: string[];
  replyFrames: number;
}

const SILENT_FRAMES = 30; // 1.8 s of silence: the server VAD needs 1.2 s, and the decoder's overlap makes the first frame after speech read as speech
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Plays one WAV question at a xiaozhi websocket server like the robot would and records the reply. */
export async function runFakeRobot(opts: FakeRobotOptions): Promise<FakeRobotResult> {
  const { url, token, wavPath, outPath, log, timeoutMs = 60_000 } = opts;
  const { pcm, sampleRate, channels } = wavToPcm(readFileSync(wavPath));
  if (sampleRate !== 16000 || channels !== 1) {
    throw new Error(`WAV must be 16 kHz mono (got ${sampleRate} Hz, ${channels} ch). Convert with: ffmpeg -i in.wav -ar 16000 -ac 1 out.wav`);
  }

  // Like the robot: the microphone goes out at 16 kHz; replies are decoded at whatever rate the server's hello announces.
  const mic = createCodec('auto', { encodeRate: INPUT_SAMPLE_RATE, decodeRate: INPUT_SAMPLE_RATE });
  let speaker: OpusCodec | undefined;
  let replyRate = OUTPUT_SAMPLE_RATE;
  const frames = pcmToFrames(pcm).map(f => mic.encodeFrame(f));
  const replyPcm: Buffer[] = [];
  const result: FakeRobotResult = { stt: '', emotion: '', sentences: [], replyFrames: 0 };
  const t0 = Date.now();
  const stamp = (m: string) => log(`[${String(Date.now() - t0).padStart(5)} ms] ${m}`);

  return new Promise<FakeRobotResult>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, 'Protocol-Version': '1', 'Device-Id': 'fa:ke:ro:bo:t0:01', 'Client-Id': 'fake-robot' } });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      mic.dispose?.();
      speaker?.dispose?.();
      if (err) reject(err); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs} ms waiting for the reply`)), timeoutMs);

    const sendAudio = async (sessionId: string) => {
      ws.send(JSON.stringify({ session_id: sessionId, type: 'listen', state: 'start', mode: 'auto' }));
      for (const f of frames) { ws.send(f, { binary: true }); await sleep(FRAME_MS); }
      const silent = mic.encodeFrame(Buffer.alloc(FRAME_BYTES));
      for (let i = 0; i < SILENT_FRAMES; i++) { ws.send(silent, { binary: true }); await sleep(FRAME_MS); }
      stamp(`-> sent ${frames.length} speech frames + ${SILENT_FRAMES} silent frames`);
    };

    ws.on('open', () => {
      stamp('open');
      ws.send(JSON.stringify({ type: 'hello', version: 1, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
    });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) { if (speaker) replyPcm.push(speaker.decode(Buffer.from(data as Buffer))); return; }
        const msg = JSON.parse(data.toString());
        stamp(`<- ${JSON.stringify(msg)}`);
        if (msg.type === 'hello') {
          replyRate = msg.audio_params?.sample_rate ?? OUTPUT_SAMPLE_RATE;
          speaker = createCodec('auto', { encodeRate: replyRate, decodeRate: replyRate });
          sendAudio(msg.session_id).catch(e => finish(e as Error));
        } else if (msg.type === 'stt') {
          result.stt = msg.text;
        } else if (msg.type === 'llm') {
          result.emotion = msg.emotion;
        } else if (msg.type === 'tts' && msg.state === 'sentence_start') {
          result.sentences.push(msg.text);
        } else if (msg.type === 'tts' && msg.state === 'stop') {
          result.replyFrames = replyPcm.length;
          writeFileSync(outPath, pcmToWav(Buffer.concat(replyPcm), replyRate));
          stamp(`reply audio: ${replyPcm.length} frames at ${replyRate} Hz -> ${outPath} (${((replyPcm.length * FRAME_MS) / 1000).toFixed(1)} s)`);
          finish();
        }
      } catch (e) {
        finish(e as Error);
      }
    });

    ws.on('close', () => finish(new Error('connection closed before the reply finished')));
    ws.on('error', e => finish(e));
  });
}
