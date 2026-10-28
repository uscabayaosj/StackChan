import { describe, it, expect } from 'vitest';
import { Session, MAX_LEAD_FRAMES, DEVICE_DECODE_QUEUE_FRAMES, TTS_STOP_MARGIN_MS, MAX_TOOL_ROUNDS, LOOP_FILLER, type SessionDeps, type SessionSocket } from '../src/session.js';
import { loadConfig } from '../src/config.js';
import { FRAME_BYTES } from '../src/opus.js';
import { SYSTEM_PROMPT } from '../src/persona.js';

function makeEnv() {
  const sent: any[] = [];
  const sentAt: number[] = [];
  const bins: Buffer[] = [];
  const binAt: number[] = [];
  const sleeps: { ms: number; binsBefore: number }[] = [];
  const logs: string[] = [];
  let open = true;
  let clock = 0;
  const socket: SessionSocket = {
    sendText: (j) => { sent.push(j); sentAt.push(clock); },
    sendBinary: (b) => { bins.push(b); binAt.push(clock); },
    close: () => { open = false; },
    get isOpen() { return open; },
  };
  const loud = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES; i += 2) loud.writeInt16LE(6000, i);
  const deps: SessionDeps = {
    config: loadConfig({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'wss://x/api/ws', SAOIRSE_DEVICE_TOKEN: 't', VAD_SILENCE_MS: '300', VAD_MIN_SPEECH_MS: '120', WAKE_GUARD_MS: '0' }), // guard behaviour is covered in final-fixes.test.ts
    codec: { encodeFrame: (p) => p.subarray(0, 4), decode: (pkt) => (pkt[0] === 1 ? loud : Buffer.alloc(FRAME_BYTES)) },
    transcribe: async () => 'what is the time',
    chat: async function* () { yield '[doubtful] '; yield 'Late. '; yield 'You know that.'; },
    synthesize: async function* (text) { yield Buffer.from([9, text.length]); yield Buffer.from([9, 0]); },
    now: () => clock,
    sleep: async (ms) => { sleeps.push({ ms, binsBefore: bins.length }); clock += ms; },
    log: (m) => { logs.push(m); },
  };
  return {
    socket, deps, sent, sentAt, bins, binAt, sleeps, logs,
    speech: Buffer.from([1]), silence: Buffer.from([0]),
    advance: (ms: number) => { clock += ms; },
  };
}

/** 240 ms of speech then 300 ms of silence: one complete utterance. */
function utter(s: Session, env: ReturnType<typeof makeEnv>) {
  for (let i = 0; i < 4; i++) s.handleBinary(env.speech);
  for (let i = 0; i < 5; i++) s.handleBinary(env.silence);
}

const hello = JSON.stringify({ type: 'hello', version: 1, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } });

describe('Session', () => {
  it('answers hello with transport, session_id and 24 kHz opus params (the robot speaker rate)', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    expect(env.sent[0].type).toBe('hello');
    expect(env.sent[0].transport).toBe('websocket');
    expect(typeof env.sent[0].session_id).toBe('string');
    expect(env.sent[0].audio_params).toEqual({ format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60 });
  });

  it('runs stt → llm → tts after end of speech and emits the protocol messages in order', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    for (let i = 0; i < 4; i++) s.handleBinary(env.speech);   // 240 ms speech
    for (let i = 0; i < 5; i++) s.handleBinary(env.silence);  // 300 ms silence -> end
    await s.drain();
    const sent = env.sent.filter(m => m.type !== 'mcp'); // the mcp initialize after hello is not part of the turn
    const types = sent.slice(1).map(m => `${m.type}${m.state ? ':' + m.state : ''}${m.emotion ? ':' + m.emotion : ''}`);
    expect(types).toEqual(['stt', 'llm:doubtful', 'tts:start', 'tts:sentence_start', 'tts:sentence_start', 'tts:stop']);
    expect(sent[1].text).toBe('what is the time');
    expect(sent[4].text).toBe('Late.');
    expect(env.bins).toHaveLength(4); // 2 sentences x 2 frames
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'Late. You know that.' });
  });

  it('processes immediately on listen stop (manual mode)', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' }));
    for (let i = 0; i < 4; i++) s.handleBinary(env.speech);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'stop' }));
    await s.drain();
    expect(env.sent.some(m => m.type === 'stt')).toBe(true);
  });

  it('ignores audio during the echo guard after tts stop', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    for (let i = 0; i < 4; i++) s.handleBinary(env.speech);
    for (let i = 0; i < 5; i++) s.handleBinary(env.silence);
    await s.drain();
    const before = env.sent.length;
    for (let i = 0; i < 4; i++) s.handleBinary(env.speech);
    for (let i = 0; i < 5; i++) s.handleBinary(env.silence);
    await s.drain();
    expect(env.sent.length).toBe(before); // nothing new: guard active (clock did not advance past 1.5 s)
  });

  it('closes after idle timeout', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    env.advance(59_000); s.tick();
    expect(env.socket.isOpen).toBe(true);
    env.advance(2_000); s.tick();
    expect(env.socket.isOpen).toBe(false);
  });

  it('abort mid-stream stops audio, sends tts stop, no llm after, keeps only spoken text', async () => {
    const env = makeEnv();
    let s!: Session;
    let abortAt = -1;
    env.deps.synthesize = async function* () {
      for (let i = 0; i < 50; i++) {
        yield Buffer.from([9, i]);
        if (i === 0 && abortAt < 0) {
          abortAt = env.sent.length;
          await s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' }));
        }
      }
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(abortAt).toBeGreaterThan(0);
    expect(env.bins.length).toBeLessThan(10); // 2 sentences x 50 frames would be 100
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
    expect(env.sent.slice(abortAt).some(m => m.type === 'llm')).toBe(false);
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'Late.' });
  });

  it('abort while thinking (before tts start) sends no llm and no tts stop', async () => {
    const env = makeEnv();
    let s!: Session;
    env.deps.chat = async function* () {
      yield '[doub';
      await s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' }));
      yield 'tful] Late. ';
      yield 'You know that.';
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type !== 'mcp').slice(1).map(m => m.type)).toEqual(['stt']);
    expect(env.bins).toHaveLength(0);
    expect(s.history.at(-1)).toEqual({ role: 'user', content: 'what is the time' });
  });

  it('abort during transcription sends nothing and records no history', async () => {
    const env = makeEnv();
    let s!: Session;
    env.deps.transcribe = async () => {
      await s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' }));
      return 'what is the time';
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type !== 'mcp')).toHaveLength(1); // only the hello reply (plus the mcp initialize)
    expect(s.history).toHaveLength(0);
  });

  it('paces from the first frame, not from before the LLM call', async () => {
    const env = makeEnv();
    env.deps.chat = async function* () { env.advance(2000); yield '[happy] One long sentence. '; };
    env.deps.synthesize = async function* () { for (let i = 0; i < 60; i++) yield Buffer.from([9, i]); };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.bins).toHaveLength(60);
    expect(env.sleeps.length).toBeGreaterThan(0);
    expect(env.sleeps[0].binsBefore).toBeLessThanOrEqual(MAX_LEAD_FRAMES + 1);
    const stopIdx = env.sent.findIndex(m => m.type === 'tts' && m.state === 'stop');
    expect(stopIdx).toBeGreaterThan(0);
    // stop only after the last frame has played out on the robot, plus its pipeline latency margin
    expect(env.sentAt[stopIdx] - env.binAt[0]).toBeGreaterThanOrEqual(60 * 60 + TTS_STOP_MARGIN_MS);
  });

  it('speaks the respelled name to the TTS voice but shows the real spelling on the robot', async () => {
    const env = makeEnv();
    const spoken: string[] = [];
    env.deps.chat = async function* () { yield '[neutral] My name is Saoirse. '; };
    env.deps.synthesize = async function* (text) { spoken.push(text); yield Buffer.from([9, 1]); };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(spoken).toEqual(['My name is Seersha.']);
    expect(env.sent.find(m => m.type === 'tts' && m.state === 'sentence_start').text).toBe('My name is Saoirse.');
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'My name is Saoirse.' });
  });

  it('never has more frames outstanding than the robot can queue (excess is dropped silently on-device)', async () => {
    const env = makeEnv();
    env.deps.chat = async function* () { yield '[happy] One long sentence. '; };
    env.deps.synthesize = async function* () { for (let i = 0; i < 120; i++) yield Buffer.from([9, i]); };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.bins).toHaveLength(120);
    // The device plays one frame per 60 ms from the first arrival; whatever we sent beyond that sits in its queue.
    const outstanding = env.binAt.map((t, i) => i + 1 - Math.floor((t - env.binAt[0]) / 60));
    expect(Math.max(...outstanding)).toBeLessThanOrEqual(DEVICE_DECODE_QUEUE_FRAMES);
    expect(MAX_LEAD_FRAMES).toBeLessThan(DEVICE_DECODE_QUEUE_FRAMES);
  });

  it('sends tts stop and recovers when synthesize throws after tts start', async () => {
    const env = makeEnv();
    let calls = 0;
    env.deps.synthesize = async function* (text) {
      calls++;
      if (calls === 2) throw new Error('tts exploded');
      yield Buffer.from([9, text.length]);
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
    expect(env.logs.some(l => l.includes('tts exploded'))).toBe(true);
    const stts = env.sent.filter(m => m.type === 'stt').length;
    env.advance(1600);
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type === 'stt').length).toBe(stts + 1);
  });

  it('keeps the space between streamed chunks after the emotion tag', async () => {
    const env = makeEnv();
    env.deps.chat = async function* () { yield '[happy] Hi '; yield 'there. '; yield 'Bye.'; };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.state === 'sentence_start').map(m => m.text)).toEqual(['Hi there.', 'Bye.']);
    expect(env.sent.find(m => m.type === 'llm')).toMatchObject({ emotion: 'happy' });
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'Hi there. Bye.' });
  });

  it('ignores the popup chime: audio in the wake guard after detect + listen start is dropped, later audio is heard', async () => {
    const env = makeEnv();
    env.deps.config = { ...env.deps.config, wakeGuardMs: 800 };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'detect', text: 'Hi,Stack Chan' }));
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    expect(env.logs.at(-1)).toBe('listening (mode=auto, wake guard 800 ms)');
    utter(s, env); // the chime, inside the guard (clock has not advanced)
    await s.drain();
    expect(env.sent.filter(m => m.type === 'stt')).toHaveLength(0);
    env.advance(900);
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type === 'stt')).toHaveLength(1);
  });

  it('logs what it heard (length, level, text)', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type === 'stt')).toHaveLength(1);
    expect(env.logs.some(l => /^utterance \d+ ms, peak rms 0\.\d{3}: "what is the time"$/.test(l))).toBe(true);
  });

  it('logs an empty transcript with the utterance length and level', async () => {
    const env = makeEnv();
    env.deps.transcribe = async () => '';
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.logs.some(l => /^utterance \d+ ms, peak rms 0\.\d{3}: empty transcript$/.test(l))).toBe(true);
  });

  it('accepts audio again once the echo guard expires', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    env.advance(1600);
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type === 'stt')).toHaveLength(2);
  });

  it('does not idle-close while processing or speaking', async () => {
    const env = makeEnv();
    let s!: Session;
    const openDuring: boolean[] = [];
    env.deps.transcribe = async () => { env.advance(61_000); s.tick(); openDuring.push(env.socket.isOpen); return 'hi'; };
    env.deps.synthesize = async function* () { yield Buffer.from([9]); env.advance(61_000); s.tick(); openDuring.push(env.socket.isOpen); };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(openDuring).toEqual([true, true, true]); // transcribe + 2 sentences
    s.tick();
    expect(env.socket.isOpen).toBe(true); // reply just ended: idle timer restarted
  });

  it('hard-closes at 280 s even while busy, and only once', async () => {
    const env = makeEnv();
    let s!: Session;
    const states: boolean[] = [];
    env.deps.transcribe = async () => {
      env.advance(279_000); s.tick(); states.push(env.socket.isOpen);
      env.advance(2_000); s.tick(); states.push(env.socket.isOpen);
      s.tick(); s.tick();
      return 'hi';
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(states).toEqual([true, false]);
    expect(env.logs.filter(l => l.includes('timeout'))).toHaveLength(1);
  });

  it('idle close logs only once', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    env.advance(61_000); s.tick(); s.tick(); s.tick();
    expect(env.socket.isOpen).toBe(false);
    expect(env.logs.filter(l => l.includes('timeout'))).toHaveLength(1);
  });

  it('ignores audio after dispose', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    s.dispose();
    utter(s, env);
    await s.drain();
    expect(env.sent.some(m => m.type === 'stt')).toBe(false);
  });

  it('does not echo-guard the next utterance after a barge-in abort', async () => {
    const env = makeEnv();
    let s!: Session;
    let aborted = false;
    env.deps.synthesize = async function* () {
      for (let i = 0; i < 50; i++) {
        yield Buffer.from([9, i]);
        if (!aborted) { aborted = true; await s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' })); }
      }
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    env.advance(200); // inside the 250 ms echo guard
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type === 'stt')).toHaveLength(2);
  });

  it('an abort during the final playback drain sends tts stop within one frame step', async () => {
    const env = makeEnv();
    let s!: Session;
    let abortAt = -1;
    // 25 frames: below MAX_LEAD_FRAMES, so every sleep is the final drain (25 x 60 ms = 1.5 s ahead).
    env.deps.chat = async function* () { yield '[happy] One sentence. '; };
    env.deps.synthesize = async function* () { for (let i = 0; i < 25; i++) yield Buffer.from([9, i]); };
    const sleep = env.deps.sleep;
    env.deps.sleep = async (ms) => {
      if (env.sleeps.length === 2 && abortAt < 0) {
        abortAt = env.deps.now();
        await s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' }));
      }
      await sleep(ms);
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.bins).toHaveLength(25);
    expect(abortAt).toBeGreaterThanOrEqual(0);
    const stopIdx = env.sent.findIndex(m => m.type === 'tts' && m.state === 'stop');
    expect(stopIdx).toBeGreaterThan(0);
    expect(env.sentAt[stopIdx] - abortAt).toBeLessThanOrEqual(60);
  });

  it('a whitespace-only first chunk does not force neutral or speak the tag', async () => {
    const env = makeEnv();
    env.deps.chat = async function* () { yield '\n'; yield '[doubtful] '; yield 'No.'; };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type === 'llm')).toEqual([expect.objectContaining({ emotion: 'doubtful' })]);
    expect(env.sent.filter(m => m.state === 'sentence_start').map(m => m.text)).toEqual(['No.']);
  });

  it('dispose cancels an LLM call that only ends when its signal aborts, and logs the error', async () => {
    const env = makeEnv();
    let chatStarted!: () => void;
    const started = new Promise<void>(r => { chatStarted = r; });
    env.deps.chat = async function* (_messages, signal) {
      chatStarted();
      await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('chat cancelled')), { once: true }));
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await started;
    s.dispose();
    await s.drain();
    expect(env.logs).toContain('process error: chat cancelled');
  });

  it('passes the turn signal to transcribe, chat and synthesize, and aborts it on barge-in', async () => {
    const env = makeEnv();
    let s!: Session;
    const signals: AbortSignal[] = [];
    const transcribe = env.deps.transcribe;
    env.deps.transcribe = async (pcm, signal) => { signals.push(signal); return transcribe(pcm, signal); };
    const chat = env.deps.chat;
    env.deps.chat = (messages, signal) => { signals.push(signal); return chat(messages, signal); };
    env.deps.synthesize = async function* (_text, signal) {
      signals.push(signal);
      yield Buffer.from([9]);
      await s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' }));
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(1);
    expect(signals[0].aborted).toBe(true);
  });

  it('logs a fetch cancelled by barge-in as an aborted turn, not a process error', async () => {
    const env = makeEnv();
    let s!: Session;
    env.deps.synthesize = async function* (_text, signal) {
      yield Buffer.from([9]);
      await s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' }));
      throw signal.reason;
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.logs.some(l => l.startsWith('turn aborted ('))).toBe(true);
    expect(env.logs.some(l => l.startsWith('process error'))).toBe(false);
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
  });

  it('a timeout after tts start is logged as a process error and still sends tts stop', async () => {
    const env = makeEnv();
    env.deps.chat = async function* () { yield '[happy] Hi. '; throw new Error('LLM timed out after 15000 ms'); };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.logs).toContain('process error: LLM timed out after 15000 ms');
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
  });

  it('appends the current local time in DEVICE_TZ to the system prompt', async () => {
    const env = makeEnv();
    env.deps.config = { ...env.deps.config, deviceTz: 'Asia/Manila' };
    env.advance(Date.parse('2026-10-27T04:05:00Z'));
    let system = '';
    const chat = env.deps.chat;
    env.deps.chat = (messages, signal) => { system = String(messages[0].content); return chat(messages, signal); };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system.split('\n').at(-1)).toBe('Current local time: Tuesday, 27 October 2026, 12:05 GMT+8 (say it as: five past twelve in the afternoon)');
  });

  it('trims history by whole user/assistant pairs', async () => {
    const env = makeEnv();
    env.deps.config = { ...env.deps.config, contextTurns: 1 };
    const seen: string[][] = [];
    const chat = env.deps.chat;
    env.deps.chat = (messages, signal) => { seen.push(messages.map(m => m.role)); return chat(messages, signal); };
    const s = new Session(env.socket, env.deps, 'aa:bb', [{ role: 'user', content: 'old q' }, { role: 'assistant', content: 'old a' }]);
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(seen[0]).toEqual(['system', 'user']);
    expect(s.history).toEqual([
      { role: 'user', content: 'what is the time' },
      { role: 'assistant', content: 'Late. You know that.' },
    ]);
  });
});

describe('Session robot tools', () => {
  const cameraTool = { name: 'self.camera.take_photo', description: 'photo', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } };
  const headTool = { name: 'self.robot.set_head_angles', description: 'head', inputSchema: { type: 'object', properties: { yaw: { type: 'integer' }, pitch: { type: 'integer' }, speed: { type: 'integer' } }, required: [] } };
  const settle = () => new Promise<void>(r => setTimeout(r, 0));

  /** Answers the session's mcp initialize + tools/list so tools are known, and auto-replies to tools/call with `toolReply`. */
  async function withTools(env: ReturnType<typeof makeEnv>, s: Session, toolReply: (name: string, args: any) => object | 'none') {
    const origSend = env.socket.sendText;
    env.socket.sendText = (j: any) => {
      origSend(j);
      if (j.type !== 'mcp') return;
      const p = j.payload;
      if (p.method === 'initialize') setTimeout(() => void s.handleText(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: p.id, result: { protocolVersion: '2024-11-05' } } })), 0);
      if (p.method === 'tools/list') setTimeout(() => void s.handleText(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: p.id, result: { tools: [cameraTool, headTool, { name: 'self.reboot', description: 'r', inputSchema: {} }] } } })), 0);
      if (p.method === 'tools/call') {
        const reply = toolReply(p.params.name, p.params.arguments);
        if (reply !== 'none') setTimeout(() => void s.handleText(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: p.id, ...reply } })), 0);
      }
    };
    await s.handleText(hello);
    for (let i = 0; i < 6 && s.mcp.tools.length === 0; i++) await settle();
    expect(s.mcp.tools.map(t => t.name)).toEqual(['self.camera.take_photo', 'self.robot.set_head_angles']);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
  }
  const toolCalls = (calls: any[]) => ({ type: 'tool_calls' as const, calls });
  const sentences = (env: ReturnType<typeof makeEnv>) => env.sent.filter(m => m.type === 'tts' && m.state === 'sentence_start').map(m => m.text);

  it('a photo turn: speaks the filler, calls take_photo on the robot, feeds the description back, speaks the answer', async () => {
    const env = makeEnv();
    const rounds: any[][] = [];
    const toolsSeen: any[] = [];
    env.deps.chat = async function* (messages, _signal, tools) {
      rounds.push(messages); toolsSeen.push(tools);
      if (!messages.some(m => m.role === 'tool')) yield toolCalls([{ id: 'c1', name: 'self.camera.take_photo', arguments: '{"question":"what is on the desk?"}' }]);
      else { yield '[happy] A grey cat, judging '; yield 'me. '; }
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, (name, args) => {
      expect(name).toBe('self.camera.take_photo');
      expect(args).toEqual({ question: 'what is on the desk?' });
      return { result: { content: [{ type: 'text', text: JSON.stringify({ success: true, text: 'A grey cat sits on a desk, staring at the camera.' }) }], isError: false } };
    });
    utter(s, env);
    await s.drain();
    expect(sentences(env)).toEqual(['Let me look.', 'A grey cat, judging me.']);
    expect(toolsSeen[0].map((t: any) => t.function.name)).toEqual(['self.camera.take_photo', 'self.robot.set_head_angles']);
    const second = rounds[1];
    expect(second.at(-2)).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'self.camera.take_photo' } }] });
    expect(second.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'A grey cat sits on a desk, staring at the camera.' });
    expect(env.sent.some(m => m.type === 'llm' && m.emotion === 'happy')).toBe(true);
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'A grey cat, judging me.' });
    expect(env.logs.some(l => l.startsWith('tool self.camera.take_photo {"question":"what is on the desk?"} -> A grey cat sits'))).toBe(true);
  });

  it('a head turn: no filler, the text the model said first is spoken before the move, the robot reply is passed back', async () => {
    const env = makeEnv();
    const rounds: any[][] = [];
    env.deps.chat = async function* (messages) {
      rounds.push(messages);
      if (!messages.some(m => m.role === 'tool')) { yield '[neutral] Fine. '; yield toolCalls([{ id: 'h1', name: 'self.robot.set_head_angles', arguments: '{"yaw":-35,"speed":150}' }]); }
      else yield 'Happy now? ';
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, () => ({ result: { content: [{ type: 'text', text: 'true' }], isError: false } }));
    utter(s, env);
    await s.drain();
    expect(sentences(env)).toEqual(['Fine.', 'Happy now?']);
    expect(rounds[1].at(-2)).toMatchObject({ role: 'assistant', content: 'Fine.' });
    expect(rounds[1].at(-1)).toEqual({ role: 'tool', tool_call_id: 'h1', content: 'true' });
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'Fine. Happy now?' });
  });

  it('a failing tool becomes an Error tool result, a failed photo unwraps the message, bad JSON arguments are reported', async () => {
    const env = makeEnv();
    let second: any[] = [];
    env.deps.chat = async function* (messages) {
      if (!messages.some(m => m.role === 'tool')) yield toolCalls([
        { id: 'a', name: 'self.robot.set_head_angles', arguments: '{"yaw":' },
        { id: 'b', name: 'self.camera.take_photo', arguments: '{"question":"q"}' },
        { id: 'c', name: 'self.robot.set_head_angles', arguments: '{"yaw":1}' },
      ]);
      else { second = messages; yield '[sad] No luck. '; }
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, (name) => name === 'self.camera.take_photo'
      ? { result: { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'Failed to capture photo' }) }], isError: false } }
      : { error: { message: 'Unknown tool: self.robot.set_head_angles' } });
    utter(s, env);
    await s.drain();
    expect(second.filter(m => m.role === 'tool').map(m => m.content)).toEqual([
      'Error: tool arguments were not valid JSON', 'Error: Failed to capture photo', 'Error: Unknown tool: self.robot.set_head_angles']);
    expect(sentences(env)).toEqual(['Let me look.', 'No luck.']);
  });

  it('never sends the robot a tool it did not offer, and says why at once', async () => {
    const env = makeEnv();
    let second: any[] = [];
    env.deps.chat = async function* (messages) {
      if (!messages.some(m => m.role === 'tool')) yield toolCalls([
        { id: 'a', name: 'create_reminder', arguments: '{"duration_seconds":60}' },
        { id: 'b', name: 'self.reboot', arguments: '{}' },
      ]);
      else { second = messages; yield '[neutral] Cannot. '; }
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, () => ({ result: { content: [{ type: 'text', text: 'true' }], isError: false } }));
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type === 'mcp' && m.payload.method === 'tools/call')).toHaveLength(0);
    expect(second.filter(m => m.role === 'tool').map(m => m.content)).toEqual([
      "Error: there is no tool called create_reminder. You can't do that right now; say so briefly.",
      "Error: there is no tool called self.reboot. You can't do that right now; say so briefly."]);
  });

  it('while the robot is still listing its tools, a robot tool call is answered with "still starting up"', async () => {
    const env = makeEnv();
    let second: any[] = [];
    env.deps.chat = async function* (messages) {
      if (!messages.some(m => m.role === 'tool')) yield toolCalls([{ id: 'a', name: 'self.robot.create_reminder', arguments: '{}' }]);
      else { second = messages; yield '[neutral] Hold on. '; }
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(env.sent.filter(m => m.type === 'mcp' && m.payload.method === 'tools/call')).toHaveLength(0);
    expect(second.find(m => m.role === 'tool').content).toMatch(/still starting up/);
  });

  it('stops after MAX_TOOL_ROUNDS rounds of tool calls and says so', async () => {
    const env = makeEnv();
    let n = 0;
    env.deps.chat = async function* () { n++; yield toolCalls([{ id: `h${n}`, name: 'self.robot.set_head_angles', arguments: '{"yaw":0}' }]); };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, () => ({ result: { content: [{ type: 'text', text: 'true' }], isError: false } }));
    utter(s, env);
    await s.drain();
    expect(n).toBe(MAX_TOOL_ROUNDS);
    expect(env.sent.filter(m => m.type === 'mcp' && m.payload.method === 'tools/call')).toHaveLength(MAX_TOOL_ROUNDS - 1);
    expect(sentences(env)).toEqual([LOOP_FILLER]);
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
  });

  it('offers no tools to the model when the robot advertised none', async () => {
    const env = makeEnv();
    let toolsSeen: any = 'unset';
    env.deps.chat = async function* (_m, _s, tools) { toolsSeen = tools; yield '[neutral] Hi. '; };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    expect(env.sent[1]).toMatchObject({ type: 'mcp', payload: { method: 'initialize', params: { capabilities: { vision: { url: 'https://x/api/vision', token: 't' } } } } });
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(toolsSeen).toBeUndefined();
    expect(sentences(env)).toEqual(['Hi.']);
  });

  it('a barge-in while a tool call is pending ends the turn with tts stop', async () => {
    const env = makeEnv();
    let s!: Session;
    env.deps.chat = async function* (messages) {
      if (!messages.some(m => m.role === 'tool')) yield toolCalls([{ id: 'c1', name: 'self.camera.take_photo', arguments: '{"question":"q"}' }]);
      else yield 'never spoken';
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, () => { setTimeout(() => void s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' })), 0); return 'none'; });
    utter(s, env);
    await s.drain();
    expect(sentences(env)).toEqual(['Let me look.']);
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
    expect(env.logs.some(l => /tool self.camera.take_photo .* -> Error: aborted/.test(l))).toBe(true);
  });
});

describe('Session server tools', () => {
  it('runs a server tool on the server (no mcp call), alongside robot tools, and feeds the result back', async () => {
    const env = makeEnv();
    const ran: any[] = [];
    env.deps.serverTools = [{
      timeoutMs: 1000,
      spec: { type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } } },
      run: async (args) => { ran.push(args); return 'London now: 8°C, clear sky.'; },
    }];
    const rounds: any[][] = [];
    const offered: any[] = [];
    env.deps.chat = async function* (messages, _s, tools) {
      rounds.push(messages); offered.push(tools);
      if (!messages.some(m => m.role === 'tool')) yield { type: 'tool_calls' as const, calls: [{ id: 'w1', name: 'get_weather', arguments: '{"days":1}' }] };
      else yield '[neutral] Eight degrees and clear. ';
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(offered[0].map((t: any) => t.function.name)).toEqual(['get_weather']);
    expect(ran).toEqual([{ days: 1 }]);
    expect(rounds[1].at(-1)).toEqual({ role: 'tool', tool_call_id: 'w1', content: 'London now: 8°C, clear sky.' });
    expect(env.sent.filter(m => m.type === 'mcp' && m.payload.method === 'tools/call')).toHaveLength(0);
    expect(env.sent.filter(m => m.type === 'tts' && m.state === 'sentence_start').map(m => m.text)).toEqual(['Eight degrees and clear.']);
  });

  it('a failing or slow server tool becomes an Error tool result', async () => {
    const env = makeEnv();
    env.deps.serverTools = [
      { timeoutMs: 1000, spec: { type: 'function', function: { name: 'web_search', description: 's', parameters: {} } }, run: async () => { throw new Error('search HTTP 429'); } },
      { timeoutMs: 5, spec: { type: 'function', function: { name: 'get_weather', description: 'w', parameters: {} } }, run: (_a, s) => new Promise((_, rej) => s.addEventListener('abort', () => rej(s.reason))) },
    ];
    let toolMsgs: any[] = [];
    env.deps.chat = async function* (messages) {
      if (!messages.some(m => m.role === 'tool')) yield { type: 'tool_calls' as const, calls: [{ id: 'a', name: 'web_search', arguments: '{"query":"q"}' }, { id: 'b', name: 'get_weather', arguments: '{}' }] };
      else { toolMsgs = messages.filter(m => m.role === 'tool'); yield '[sad] No luck. '; }
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(toolMsgs.map(m => m.content)).toEqual(['Error: search HTTP 429', 'Error: get_weather timed out after 5 ms']);
  });
});

describe('Session tool-round keep-alive', () => {
  it('sends silent frames during a long tool round after speech started, and stops when it ends', async () => {
    const env = makeEnv();
    const timers: { fn: () => void; ms: number }[] = [];
    env.deps.timers = {
      setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimeout: (h) => { const i = timers.indexOf(h as any); if (i >= 0) timers.splice(i, 1); },
    };
    let release!: () => void;
    env.deps.serverTools = [{
      timeoutMs: 60_000,
      spec: { type: 'function', function: { name: 'web_search', description: 's', parameters: {} } },
      run: () => new Promise<string>(r => { release = () => r('found it'); }),
    }];
    env.deps.chat = async function* (messages) {
      if (!messages.some(m => m.role === 'tool')) { yield '[neutral] Checking. '; yield { type: 'tool_calls' as const, calls: [{ id: 's1', name: 'web_search', arguments: '{"query":"q"}' }] }; }
      else yield 'Done. ';
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    for (let i = 0; i < 20 && !release; i++) await new Promise(r => setTimeout(r, 0));
    const before = env.bins.length;
    const keep = () => timers.find(t => t.ms === 2000)!;
    const fire = () => { const t = keep(); timers.splice(timers.indexOf(t), 1); t.fn(); };
    fire(); fire(); fire(); // three keep-alive ticks while the search is pending
    expect(env.bins.length - before).toBe(3);
    release();
    await s.drain();
    expect(timers.some(t => t.ms === 2000)).toBe(false);
    expect(env.sent.filter(m => m.type === 'tts' && m.state === 'sentence_start').map(m => m.text)).toEqual(['Checking.', 'Done.']);
  });
});
