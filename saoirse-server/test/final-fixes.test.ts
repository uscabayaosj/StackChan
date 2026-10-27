import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Session, MAX_TOOL_ROUNDS, LOOP_FILLER, type SessionDeps, type SessionSocket } from '../src/session.js';
import { createAppServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { FRAME_BYTES } from '../src/opus.js';
import { parseMultipart } from '../src/vision.js';

const baseEnv = { LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'wss://x/api/ws', SAOIRSE_DEVICE_TOKEN: 't', VAD_SILENCE_MS: '300', VAD_MIN_SPEECH_MS: '120' };

function makeEnv(extra: Record<string, string> = {}) {
  const sent: any[] = [];
  const logs: string[] = [];
  let open = true;
  let clock = 0;
  const socket: SessionSocket = { sendText: (j) => { sent.push(j); }, sendBinary: () => {}, close: () => { open = false; }, get isOpen() { return open; } };
  const loud = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES; i += 2) loud.writeInt16LE(6000, i);
  const deps: SessionDeps = {
    config: loadConfig({ ...baseEnv, ...extra }),
    codec: { encodeFrame: (p) => p.subarray(0, 4), decode: (pkt) => (pkt[0] === 1 ? loud : Buffer.alloc(FRAME_BYTES)) },
    transcribe: async () => 'hello there',
    chat: async function* () { yield '[neutral] Yes. '; },
    synthesize: async function* () { yield Buffer.from([9, 1]); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: (m) => { logs.push(m); },
  };
  return { socket, deps, sent, logs, speech: Buffer.from([1]), silence: Buffer.from([0]), advance: (ms: number) => { clock += ms; } };
}
const hello = JSON.stringify({ type: 'hello', version: 1, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } });
const listenStart = JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' });
function utter(s: Session, env: ReturnType<typeof makeEnv>) { for (let i = 0; i < 4; i++) s.handleBinary(env.speech); for (let i = 0; i < 5; i++) s.handleBinary(env.silence); }
const stts = (env: ReturnType<typeof makeEnv>) => env.sent.filter(m => m.type === 'stt').length;

describe('wake guard', () => {
  const detect = JSON.stringify({ type: 'listen', state: 'detect', text: 'Hi,Stack Chan' });
  const wakeAbort = JSON.stringify({ type: 'abort', reason: 'wake_word_detected' });
  const tapAbort = JSON.stringify({ type: 'abort' });

  it('arms after detect + start, not on the start after a reply, and again on a second start in one listening period', async () => {
    const env = makeEnv();
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(detect);
    await s.handleText(listenStart);
    expect(env.logs.at(-1)).toBe('listening (mode=auto, wake guard 800 ms)');
    utter(s, env); await s.drain();            // inside the guard: the chime, nothing heard
    expect(stts(env)).toBe(0);
    env.advance(900);
    utter(s, env); await s.drain();            // a real utterance: turn 1 (short: ends well inside 5 s of the wake word)
    expect(stts(env)).toBe(1);
    await s.handleText(listenStart);           // the robot re-enters listening after tts stop: no chime, no guard
    expect(env.logs.at(-1)).toBe('listening (mode=auto)');
    env.advance(300);                          // past the echo guard
    utter(s, env); await s.drain();
    expect(stts(env)).toBe(2);
    await s.handleText(listenStart);           // post-reply start (no guard) ...
    expect(env.logs.at(-1)).toBe('listening (mode=auto)');
    await s.handleText(listenStart);           // ... then a second start in the same period: wake word heard while listening, the robot chimes
    expect(env.logs.at(-1)).toBe('listening (mode=auto, wake guard 800 ms)');
  });

  it('a tap on the face (listen start with no detect, abort with no reason) never arms the guard', async () => {
    const env = makeEnv();
    let s!: Session;
    env.deps.synthesize = async function* () { yield Buffer.from([9, 1]); await s.handleText(tapAbort); await s.handleText(listenStart); yield Buffer.from([9, 2]); };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(listenStart);           // tapped: no chime
    expect(env.logs.at(-1)).toBe('listening (mode=auto)');
    utter(s, env); await s.drain();            // heard at once
    expect(stts(env)).toBe(1);
    expect(env.logs.at(-1)).toBe('listening (mode=auto)'); // the start queued during the tap-abort: still no guard
  });

  it('a wake-word barge-in queues the listen start and arms the guard from the start\'s arrival time', async () => {
    const env = makeEnv();
    let s!: Session;
    let startAt = -1;
    env.deps.synthesize = async function* () {
      yield Buffer.from([9, 1]);
      await s.handleText(wakeAbort);
      startAt = env.deps.now();
      await s.handleText(listenStart);         // the robot is already listening again while we unwind
      yield Buffer.from([9, 2]);
    };
    s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(listenStart);
    utter(s, env); await s.drain();
    expect(env.logs.at(-1)).toBe('listening (mode=auto, wake guard 800 ms)');
    expect(startAt).toBeGreaterThanOrEqual(0);
    utter(s, env); await s.drain();            // chime inside the guard (clock has not moved past startAt + 800)
    expect(stts(env)).toBe(1);
    env.advance(900);
    utter(s, env); await s.drain();
    expect(stts(env)).toBe(2);
  });
});

describe('tool rounds', () => {
  const cameraTool = { name: 'self.camera.take_photo', description: 'photo', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } };
  async function withTools(env: ReturnType<typeof makeEnv>, s: Session, reply: (name: string, args: any) => object) {
    const orig = env.socket.sendText;
    env.socket.sendText = (j: any) => {
      orig(j);
      if (j.type !== 'mcp') return;
      const p = j.payload;
      if (p.method === 'initialize') setTimeout(() => void s.handleText(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: p.id, result: {} } })), 0);
      if (p.method === 'tools/list') setTimeout(() => void s.handleText(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: p.id, result: { tools: [cameraTool] } } })), 0);
      if (p.method === 'tools/call') setTimeout(() => void s.handleText(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: p.id, ...reply(p.params.name, p.params.arguments) } })), 0);
    };
    await s.handleText(hello);
    for (let i = 0; i < 6 && s.mcp.tools.length === 0; i++) await new Promise(r => setTimeout(r, 0));
    await s.handleText(listenStart);
    env.advance(900);
  }
  const ok = { result: { content: [{ type: 'text', text: JSON.stringify({ success: true, text: 'A cat.' }) }], isError: false } };

  it('an emotion tag opening a later round updates the face and is not spoken, even split across chunks', async () => {
    const env = makeEnv();
    env.deps.chat = async function* (messages) {
      if (!messages.some(m => m.role === 'tool')) { yield '[neutral] Fine. '; yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'self.camera.take_photo', arguments: '{"question":"q"}' }] }; }
      else { yield '[hap'; yield 'py] A cat. '; yield 'Obviously. '; }
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, () => ok);
    utter(s, env); await s.drain();
    expect(env.sent.filter(m => m.type === 'tts' && m.state === 'sentence_start').map(m => m.text)).toEqual(['Fine.', 'A cat.', 'Obviously.']);
    expect(env.sent.filter(m => m.type === 'llm').map(m => m.emotion)).toEqual(['neutral', 'happy']);
    expect(s.history.at(-1)).toEqual({ role: 'assistant', content: 'Fine. A cat. Obviously.' });
  });

  it('does not run tools on the last round: it just says it is going in circles', async () => {
    const env = makeEnv();
    let n = 0;
    env.deps.chat = async function* () { n++; yield { type: 'tool_calls', calls: [{ id: `c${n}`, name: 'self.camera.take_photo', arguments: '{"question":"q"}' }] }; };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, () => ok);
    utter(s, env); await s.drain();
    expect(n).toBe(MAX_TOOL_ROUNDS);
    expect(env.sent.filter(m => m.type === 'mcp' && m.payload.method === 'tools/call')).toHaveLength(MAX_TOOL_ROUNDS - 1);
    expect(env.sent.filter(m => m.type === 'tts' && m.state === 'sentence_start').map(m => m.text)).toEqual(['Let me look.', LOOP_FILLER]);
  });

  it('arguments that are valid JSON but not an object are rejected without calling the robot', async () => {
    const env = makeEnv();
    let second: any[] = [];
    env.deps.chat = async function* (messages) {
      if (!messages.some(m => m.role === 'tool')) yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'self.camera.take_photo', arguments: '[1,2]' }, { id: 'c2', name: 'self.camera.take_photo', arguments: '"5"' }] };
      else { second = messages; yield '[neutral] No. '; }
    };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await withTools(env, s, () => ok);
    utter(s, env); await s.drain();
    expect(second.filter(m => m.role === 'tool').map(m => m.content)).toEqual(['Error: tool arguments must be a JSON object', 'Error: tool arguments must be a JSON object']);
    expect(env.sent.filter(m => m.type === 'mcp' && m.payload.method === 'tools/call')).toHaveLength(0);
  });
});

describe('OTA secret', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));
  async function start(extra: Record<string, string>) {
    server = createAppServer(loadConfig({ ...baseEnv, ...extra }));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  it('refuses the OTA check without the secret and serves it with the right ?k=', async () => {
    const base = await start({ OTA_SECRET: 's3cret' });
    expect((await fetch(`${base}/api/ota`, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/api/ota?k=wrong`, { method: 'POST', body: '{}' })).status).toBe(403);
    const ok = await fetch(`${base}/api/ota?k=s3cret`, { method: 'POST', body: '{}' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).websocket.token).toBe('t');
  });
  it('stays open when no secret is configured', async () => {
    const base = await start({});
    expect((await fetch(`${base}/api/ota`, { method: 'POST', body: '{}' })).status).toBe(200);
  });
});

describe('hostile multipart', () => {
  const B = 'bnd';
  it('does not throw on LF-only, truncated, unterminated or boundary-containing bodies', () => {
    expect(() => parseMultipart(Buffer.from(`--${B}\nContent-Disposition: form-data; name="q"\n\nx\n--${B}--\n`), B)).not.toThrow();
    const truncated = parseMultipart(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="c.jpg"\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8\xff`, 'latin1'), B);
    expect(truncated.files).toHaveLength(0); // no closing delimiter: the part is incomplete, not a file
    const noClose = parseMultipart(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="q"\r\n\r\nhello\r\n`), B);
    expect(noClose.fields).toEqual({});
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`--${B}`), Buffer.from([0x00, 0xff, 0xd9])]);
    const inside = parseMultipart(Buffer.concat([Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="c.jpg"\r\n\r\n`), jpeg, Buffer.from(`\r\n--${B}--\r\n`)]), B);
    // A boundary byte sequence inside the JPEG ends the part early: the parser stays safe; the image is cut (the robot's encoder never emits it).
    expect(inside.files.length).toBeLessThanOrEqual(2);
    expect(() => parseMultipart(Buffer.alloc(0), B)).not.toThrow();
    expect(() => parseMultipart(Buffer.from('garbage'), B)).not.toThrow();
  });
});
