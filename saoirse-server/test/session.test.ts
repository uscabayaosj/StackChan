import { describe, it, expect } from 'vitest';
import { Session, MAX_LEAD_FRAMES, type SessionDeps, type SessionSocket } from '../src/session.js';
import { loadConfig } from '../src/config.js';
import { FRAME_BYTES } from '../src/opus.js';

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
  it('answers hello with transport, session_id and 16 kHz opus params', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    expect(env.sent[0].type).toBe('hello');
    expect(env.sent[0].transport).toBe('websocket');
    expect(typeof env.sent[0].session_id).toBe('string');
    expect(env.sent[0].audio_params).toEqual({ format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 });
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
    expect(env.sentAt[stopIdx] - env.binAt[0]).toBeGreaterThanOrEqual(60 * 60);
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

  it('trims history by whole user/assistant pairs', async () => {
    const env = makeEnv();
    env.deps.config = { ...env.deps.config, contextTurns: 1 };
    const seen: string[][] = [];
    const chat = env.deps.chat;
    env.deps.chat = (messages) => { seen.push(messages.map(m => m.role)); return chat(messages); };
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
