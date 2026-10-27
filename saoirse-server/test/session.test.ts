import { describe, it, expect } from 'vitest';
import { Session, MAX_LEAD_FRAMES, DEVICE_DECODE_QUEUE_FRAMES, TTS_STOP_MARGIN_MS, type SessionDeps, type SessionSocket } from '../src/session.js';
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
    config: loadConfig({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'ws://x', SAOIRSE_DEVICE_TOKEN: 't', VAD_SILENCE_MS: '300', VAD_MIN_SPEECH_MS: '120' }),
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
    const types = env.sent.slice(1).map(m => `${m.type}${m.state ? ':' + m.state : ''}${m.emotion ? ':' + m.emotion : ''}`);
    expect(types).toEqual(['stt', 'llm:doubtful', 'tts:start', 'tts:sentence_start', 'tts:sentence_start', 'tts:stop']);
    expect(env.sent[1].text).toBe('what is the time');
    expect(env.sent[4].text).toBe('Late.');
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
    expect(env.sent.slice(1).map(m => m.type)).toEqual(['stt']);
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
    expect(env.sent).toHaveLength(1); // only the hello reply
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
    env.advance(200); // well inside the 1.5 s echo guard
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
    env.deps.chat = (messages, signal) => { system = messages[0].content; return chat(messages, signal); };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    utter(s, env);
    await s.drain();
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system.split('\n').at(-1)).toBe('Current local time: Tuesday, 27 October 2026, 12:05 GMT+8');
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
