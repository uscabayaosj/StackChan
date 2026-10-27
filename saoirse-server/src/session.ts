import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { FRAME_MS, OUTPUT_SAMPLE_RATE, rms, type OpusCodec } from './opus.js';
import { EnergyVad } from './vad.js';
import { SentenceAccumulator, extractEmotion, speechText } from './text.js';
import { SYSTEM_PROMPT } from './persona.js';
import { formatLocalTime } from './clock.js';
import type { ChatMessage, ChatEvent, ToolCall, ToolSpec } from './llm.js';
import { DeviceMcp } from './mcp.js';

export interface SessionSocket {
  sendText(json: object): void;
  sendBinary(frame: Buffer): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface SessionDeps {
  config: Config;
  codec: OpusCodec;
  /** Each call gets the turn's signal: aborted on barge-in (`abort`) and when the socket closes. */
  transcribe(pcm: Buffer, signal: AbortSignal): Promise<string>;
  /** Yields text (plain strings or text events) and, when `tools` are offered and the model wants them, one `tool_calls` event. */
  chat(messages: ChatMessage[], signal: AbortSignal, tools?: ToolSpec[]): AsyncGenerator<string | ChatEvent>;
  synthesize(text: string, signal: AbortSignal): AsyncGenerator<Buffer>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
  /** Timers for robot tool-call deadlines (defaults to the globals). */
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
}

type State = 'idle' | 'listening' | 'processing' | 'speaking';

/**
 * The robot's decode queue holds 2400 ms of audio (xiaozhi audio_service.h:
 * MAX_DECODE_PACKETS_IN_QUEUE = 2400 / 60 = 40 frames) and PushPacketToDecodeQueue
 * drops anything beyond that silently (wait = false). Running ahead of it clips speech.
 */
export const DEVICE_DECODE_QUEUE_FRAMES = 40;
/** How many frames we may run ahead of real time when streaming TTS: well inside the device queue, leaving room for jitter. */
export const MAX_LEAD_FRAMES = 30;
/**
 * Hold `tts stop` back this long after our send-time model says playback ended. The robot's
 * speaker runs behind that model (network, decode queue, two playback slots, I2S buffers), and on
 * `stop` the firmware switches to listening and clears its audio queues after waiting only for the
 * two-slot playback queue, so a stop that lands early clips the end of the reply.
 */
export const TTS_STOP_MARGIN_MS = 500;
/** How many LLM rounds a turn may take (each tool round is one more LLM call). */
export const MAX_TOOL_ROUNDS = 3;
export const CAMERA_TOOL = 'self.camera.take_photo';
/** Spoken before a photo when the model said nothing first, so the robot is not silent for the capture. */
export const CAMERA_FILLER = 'Let me look.';
/** Spoken when the model is still asking for tools after the last round. */
export const LOOP_FILLER = "I'm going in circles. Ask again.";

/** The robot returns the vision service's HTTP body verbatim; unwrap `{success, text}` for the model. */
export function cameraResultText(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      if (obj.success === false) return `Error: ${typeof obj.message === 'string' ? obj.message : 'photo failed'}`;
      if (typeof obj.text === 'string') return obj.text;
    }
  } catch { /* not JSON: use as is */ }
  return raw;
}

/** Leading `[emotion]` tag plus the whitespace after it (same shape `extractEmotion` accepts). */
const TAG_PREFIX = /^\s*\[[a-z]+\]\s*/i;

/** Drop the tag prefix only, keeping trailing whitespace so streamed words do not merge. */
function stripTag(text: string): string {
  const m = TAG_PREFIX.exec(text);
  return m ? text.slice(m[0].length) : text.trimStart();
}

export class Session {
  readonly history: ChatMessage[];
  private state: State = 'idle';
  private sessionId = randomUUID();
  /** Listening mode the device asked for; informational (logged), capture logic is the same. */
  private mode: 'auto' | 'manual' | 'realtime' = 'auto';
  /** Decoded PCM of the current utterance (pre-roll included); empty until speech starts. */
  private pcmChunks: Buffer[] = [];
  private vad: EnergyVad;
  /** Decoded PCM of the most recent non-speech frames, prepended when speech starts. */
  private preRoll: Buffer[] = [];
  private lastSpeechAt: number;
  private startedAt: number;
  private ttsEndedAt = -Infinity;
  /** When the robot last reported its wake word (`listen detect`). */
  private wakeDetectedAt = -Infinity;
  /** Microphone audio is ignored until this time (the robot's popup chime after a wake word). */
  private listenGuardUntil = -Infinity;
  /** Loudest frame of the utterance being captured, for the log. */
  private utterPeakRms = 0;
  /**
   * The robot plays its popup chime into the open microphone when it starts listening after a wake
   * word: the first `listen start` after hello, the one after a barge-in, and a `listen start` that
   * arrives while we are already listening (wake word heard while listening). Not the one after a
   * reply that played out.
   */
  private guardNextListen = false;
  /** A `listen start` has been applied for the current listening period. */
  private listenStarted = false;
  /** A `listen start` that arrived mid-turn, applied (with its own arrival time) when the turn ends. */
  private listenPending: { afterWake: boolean; at: number } | null = null;
  private abortRequested = false;
  /** Cancels the in-flight turn's STT/LLM/TTS calls. */
  private turnAbort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private disposed = false;
  private closed = false;
  /** MCP client for the robot's tools (camera, head, lights). */
  readonly mcp: DeviceMcp;

  constructor(
    private readonly socket: SessionSocket,
    private readonly deps: SessionDeps,
    readonly deviceId: string,
    history: ChatMessage[] = [],
  ) {
    this.history = history;
    const v = deps.config.vad;
    this.vad = new EnergyVad({ rmsThreshold: v.rmsThreshold, silenceMs: v.silenceMs, minSpeechMs: v.minSpeechMs, frameMs: FRAME_MS });
    this.lastSpeechAt = deps.now();
    this.startedAt = deps.now();
    const timers = deps.timers ?? {
      setTimeout: (fn: () => void, ms: number) => { const h = setTimeout(fn, ms); (h as any).unref?.(); return h; },
      clearTimeout: (h: unknown) => clearTimeout(h as any),
    };
    this.mcp = new DeviceMcp({
      sendMcp: payload => this.socket.sendText({ session_id: this.sessionId, type: 'mcp', payload }),
      log: m => deps.log(m),
      now: () => deps.now(),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    }, deps.config.deviceTools);
  }

  /** Wait for any in-flight processing (used by tests and by the socket close handler). */
  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.requestAbort();
    this.mcp.dispose();
  }

  private requestAbort(chimeFollows = false): void {
    this.abortRequested = true;
    this.turnAbort?.abort();
    if (chimeFollows) this.guardNextListen = true;
  }

  /** Called periodically (every second) by the transport. */
  tick(): void {
    if (this.closed || !this.socket.isOpen) return;
    const now = this.deps.now();
    const { idleCloseMs, hardCloseMs } = this.deps.config;
    const busy = this.state === 'processing' || this.state === 'speaking';
    let reason: string | null = null;
    if (!busy && now - this.lastSpeechAt > idleCloseMs) reason = 'idle';
    else if (now - this.startedAt > hardCloseMs) reason = 'hard';
    if (!reason) return;
    this.closed = true;
    this.deps.log(`${reason} timeout, closing`);
    this.socket.close();
  }

  async handleText(raw: string): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { this.deps.log(`bad json: ${raw.slice(0, 80)}`); return; }
    switch (msg.type) {
      case 'hello':
        this.socket.sendText({
          type: 'hello', transport: 'websocket', session_id: this.sessionId,
          audio_params: { format: 'opus', sample_rate: OUTPUT_SAMPLE_RATE, channels: 1, frame_duration: FRAME_MS },
        });
        // Tell the robot where photos go and learn its tools; replies arrive as `mcp` messages.
        void this.mcp.start({ url: this.deps.config.publicVisionUrl, token: this.deps.config.deviceToken });
        break;
      case 'listen':
        if (msg.mode === 'auto' || msg.mode === 'manual' || msg.mode === 'realtime') this.mode = msg.mode;
        if (msg.state === 'detect') {
          // Wake word: the robot already streamed the wake-word audio (dropped while idle, discarded here otherwise).
          this.wakeDetectedAt = this.deps.now();
          this.guardNextListen = true;
          if (this.state === 'idle' || this.state === 'listening') { this.state = 'listening'; this.resetCapture(); }
        } else if (msg.state === 'start') {
          const now = this.deps.now();
          // Chime cases: after `listen detect`, after a wake-word barge-in, or a second start in one listening
          // period (wake word heard while listening). A tap on the face starts listening without a chime.
          const afterWake = this.guardNextListen || (this.state === 'listening' && this.listenStarted);
          this.listenStarted = true;
          if (this.state === 'idle' || this.state === 'listening') this.startListening(afterWake, now);
          else this.listenPending = { afterWake, at: now }; // mid-turn (right after a barge-in): applied when the turn unwinds
        } else if (msg.state === 'stop') {
          if (this.state === 'listening' && this.pcmChunks.length > 0) this.startProcessing();
        }
        break;
      case 'abort':
        // Only a wake-word barge-in makes the robot chime when it listens again; a tap does not.
        this.requestAbort(msg.reason === 'wake_word_detected');
        break;
      case 'mcp':
        this.mcp.handle(msg.payload);
        break;
      default:
        this.deps.log(`unhandled message type ${msg.type}`);
    }
  }

  handleBinary(frame: Buffer): void {
    if (this.disposed || this.state !== 'listening') return;
    const now = this.deps.now();
    if (now - this.ttsEndedAt < this.deps.config.echoGuardMs) return;
    if (now < this.listenGuardUntil) return;
    let pcm: Buffer;
    try { pcm = this.deps.codec.decode(frame); } catch { return; }
    const level = rms(pcm);
    if (level > this.utterPeakRms) this.utterPeakRms = level;
    const ev = this.vad.push(level);
    const capturing = this.pcmChunks.length > 0;
    if (ev === 'speech') {
      if (!capturing) { this.pcmChunks.push(...this.preRoll); this.preRoll = []; }
      this.pcmChunks.push(pcm);
      this.lastSpeechAt = now;
      return;
    }
    if (capturing) this.pcmChunks.push(pcm);
    else {
      const preRollFrames = Math.ceil(this.deps.config.vad.preRollMs / FRAME_MS);
      this.preRoll.push(pcm);
      if (this.preRoll.length > preRollFrames) this.preRoll.shift();
    }
    if (ev === 'end') this.startProcessing();
    else if (ev === 'too-short') this.resetCapture();
  }

  private startListening(afterWake = false, at = this.deps.now()): void {
    this.state = 'listening';
    this.guardNextListen = false;
    // After a wake word the robot plays its popup chime into an open microphone; don't transcribe it.
    // `at` is when the robot said it started listening (a queued start keeps its arrival time).
    this.listenGuardUntil = afterWake ? at + this.deps.config.wakeGuardMs : -Infinity;
    this.deps.log(`listening (mode=${this.mode}${afterWake ? `, wake guard ${this.deps.config.wakeGuardMs} ms` : ''})`);
    this.resetCapture();
  }

  private resetCapture(): void {
    this.pcmChunks = [];
    this.preRoll = [];
    this.utterPeakRms = 0;
    this.vad.reset();
  }

  private startProcessing(): void {
    if (this.disposed) return;
    const pcm = Buffer.concat(this.pcmChunks);
    const stats = { ms: this.pcmChunks.length * FRAME_MS, peak: this.utterPeakRms };
    this.resetCapture();
    this.state = 'processing';
    this.abortRequested = false;
    const turn = new AbortController();
    this.turnAbort = turn;
    this.running = this.process(pcm, turn.signal, stats).catch(err => {
      const msg = (err as Error).message;
      // A barge-in cancels the turn's fetches on purpose; anything else (incl. timeouts, close) is an error.
      this.deps.log(turn.signal.aborted && !this.disposed ? `turn aborted (${msg})` : `process error: ${msg}`);
    }).finally(() => {
      this.running = null;
      if (this.turnAbort === turn) this.turnAbort = null;
      this.listenStarted = false;
      // After a reply that played out the robot re-enters listening without a chime; after a barge-in it chimes.
      if (!this.abortRequested) this.guardNextListen = false;
      if (this.disposed || this.state === 'idle') return;
      const pending = this.listenPending;
      this.listenPending = null;
      if (pending) { this.listenStarted = true; this.startListening(pending.afterWake, pending.at); }
      else this.state = 'listening';
    });
  }

  private async process(pcm: Buffer, signal: AbortSignal, stats: { ms: number; peak: number }): Promise<void> {
    const text = await this.deps.transcribe(pcm, signal);
    if (this.abortRequested || !this.socket.isOpen) return;
    const heard = `utterance ${stats.ms} ms, peak rms ${stats.peak.toFixed(3)}`;
    if (!text) { this.deps.log(`${heard}: empty transcript`); return; }
    this.deps.log(`${heard}: "${text}"`);
    this.socket.sendText({ session_id: this.sessionId, type: 'stt', text });
    this.history.push({ role: 'user', content: text });
    this.trimHistory();

    const localTime = formatLocalTime(new Date(this.deps.now()), this.deps.config.deviceTz);
    const system = `${SYSTEM_PROMPT}\n\nCurrent local time: ${localTime}`;
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...this.history];
    const acc = new SentenceAccumulator();
    let emotionSent = false;
    let ttsStarted = false;
    let completed = false;
    let full = '';
    const spoken: string[] = [];
    /** Playback cursor: when (deps.now() time base) the device finishes the audio sent so far. */
    let playEnd = -Infinity;

    const sendEmotion = () => {
      const { emotion } = extractEmotion(full);
      this.socket.sendText({ session_id: this.sessionId, type: 'llm', emotion, text: '' });
      emotionSent = true;
      full = stripTag(full);
      return full;
    };

    const speak = async (sentence: string) => {
      if (this.abortRequested || !this.socket.isOpen) return;
      if (!ttsStarted) { this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'start' }); ttsStarted = true; this.state = 'speaking'; }
      this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'sentence_start', text: sentence });
      spoken.push(sentence);
      for await (const frame of this.deps.synthesize(speechText(sentence), signal)) {
        if (this.abortRequested || !this.socket.isOpen) return;
        const lead = (playEnd - this.deps.now()) / FRAME_MS;
        if (lead > MAX_LEAD_FRAMES) {
          await this.deps.sleep((lead - MAX_LEAD_FRAMES) * FRAME_MS);
          if (this.abortRequested || !this.socket.isOpen) return;
        }
        playEnd = Math.max(playEnd, this.deps.now()) + FRAME_MS;
        this.socket.sendBinary(frame);
      }
    };

    const handleChunk = async (chunk: string) => {
      full += chunk;
      let delta = chunk;
      if (!emotionSent) {
        // Wait until we can decide whether the reply starts with a tag (leading whitespace decides nothing).
        if (!full.trim()) return;
        if (/^\s*\[/.test(full) && !/\]/.test(full)) return;
        delta = sendEmotion();
      }
      for (const s of acc.push(delta)) await speak(s);
    };

    /** Speak everything buffered so far (handles a reply that never got past the emotion tag). */
    const flushText = async () => {
      if (!emotionSent && full.trim()) {
        for (const s of acc.push(sendEmotion())) await speak(s);
      }
      const tail = acc.flush();
      if (tail) await speak(tail);
    };

    try {
      const working: ChatMessage[] = [...messages];
      let calls: ToolCall[] | null = null;
      for (let round = 1; round <= MAX_TOOL_ROUNDS && !this.abortRequested; round++) {
        calls = null;
        const tools = this.mcp.toolSpecs();
        let roundText = '';
        // Later rounds may start with their own emotion tag (the persona asks for one per reply): it updates
        // the face and is never spoken. The tag can be split across chunks, so hold text until it is decided.
        let roundHold = '';
        let roundTagDecided = round === 1;
        for await (const ev of this.deps.chat(working, signal, tools.length > 0 ? tools : undefined)) {
          if (this.abortRequested) break;
          const event: ChatEvent = typeof ev === 'string' ? { type: 'text', text: ev } : ev;
          if (event.type !== 'text') { calls = event.calls; continue; }
          let text = event.text;
          if (!roundTagDecided) {
            roundHold += text;
            if (!roundHold.trim()) continue;
            if (/^\s*\[/.test(roundHold) && !/\]/.test(roundHold)) continue;
            roundTagDecided = true;
            if (TAG_PREFIX.test(roundHold)) {
              const { emotion } = extractEmotion(roundHold);
              this.socket.sendText({ session_id: this.sessionId, type: 'llm', emotion, text: '' });
              emotionSent = true;
            }
            text = stripTag(roundHold);
            if (!text) continue;
          }
          roundText += text;
          await handleChunk(text);
        }
        if (this.abortRequested || !calls) break;
        // Nothing to feed the results back into: don't run the robot for a reply that cannot follow.
        if (round === MAX_TOOL_ROUNDS) break;
        // What the model said before asking for tools is heard first; a photo gets a filler if it said nothing.
        await flushText();
        if (!/\s$/.test(full)) full += ' ';
        if (calls.some(c => c.name === CAMERA_TOOL) && spoken.length === 0) await speak(CAMERA_FILLER);
        const results = await this.runTools(calls, signal);
        working.push({
          role: 'assistant', content: stripTag(roundText).trim() || null,
          tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });
        for (const r of results) working.push({ role: 'tool', tool_call_id: r.id, content: r.text });
      }
      if (!this.abortRequested) {
        if (calls) { await flushText(); await speak(LOOP_FILLER); full += ` ${LOOP_FILLER}`; }
        else await flushText();
        completed = !this.abortRequested;
      }
    } finally {
      if (ttsStarted && this.socket.isOpen) {
        // Let the device play out what we sent ahead of real time, plus its own pipeline latency,
        // before announcing the end; one frame at a time so a barge-in during the drain stops it within a frame.
        let remaining: number;
        while (!this.abortRequested && this.socket.isOpen && (remaining = playEnd + TTS_STOP_MARGIN_MS - this.deps.now()) > 0) {
          await this.deps.sleep(Math.min(FRAME_MS, remaining));
        }
        if (this.socket.isOpen) {
          this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'stop' });
          // Echo guard only after a reply that played out; after an abort the device already
          // stopped playing, and the utterance that interrupted it must not be dropped.
          if (!this.abortRequested) this.ttsEndedAt = this.deps.now();
        }
      }
      // A finished reply is stored whole; an aborted or failed one only as far as it was spoken.
      const reply = completed ? full.trim() : spoken.join(' ');
      if (reply) this.history.push({ role: 'assistant', content: reply });
      this.trimHistory();
      this.lastSpeechAt = this.deps.now();
    }
  }

  /** Runs the model's tool calls on the robot, in order; every failure becomes an `Error: …` tool result. */
  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<{ id: string; text: string }[]> {
    const out: { id: string; text: string }[] = [];
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = call.arguments.trim() ? JSON.parse(call.arguments) : {}; } catch { out.push({ id: call.id, text: 'Error: tool arguments were not valid JSON' }); continue; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) { out.push({ id: call.id, text: 'Error: tool arguments must be a JSON object' }); continue; }
      const isCamera = call.name === CAMERA_TOOL;
      const timeoutMs = isCamera ? this.deps.config.toolTimeoutMs.camera : this.deps.config.toolTimeoutMs.other;
      let text: string;
      try {
        text = await this.mcp.callTool(call.name, args, { timeoutMs, signal });
        if (isCamera) text = cameraResultText(text);
      } catch (err) {
        text = `Error: ${(err as Error).message}`;
      }
      this.deps.log(`tool ${call.name} ${call.arguments.slice(0, 80)} -> ${text.replace(/\s+/g, ' ').slice(0, 100)}`);
      out.push({ id: call.id, text });
    }
    return out;
  }

  /** Keep at most contextTurns exchanges, dropping whole user/assistant pairs from the front. */
  private trimHistory(): void {
    const max = this.deps.config.contextTurns * 2;
    while (this.history.length > max) {
      this.history.shift();
      while (this.history.length > 0 && this.history[0].role !== 'user') this.history.shift();
    }
    while (this.history.length > 0 && this.history[0].role !== 'user') this.history.shift();
  }
}
