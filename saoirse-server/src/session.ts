import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { FRAME_MS, rms, type OpusCodec } from './opus.js';
import { EnergyVad } from './vad.js';
import { SentenceAccumulator, extractEmotion } from './text.js';
import { SYSTEM_PROMPT } from './persona.js';
import type { ChatMessage } from './llm.js';

export interface SessionSocket {
  sendText(json: object): void;
  sendBinary(frame: Buffer): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface SessionDeps {
  config: Config;
  codec: OpusCodec;
  transcribe(pcm: Buffer): Promise<string>;
  chat(messages: ChatMessage[]): AsyncGenerator<string>;
  synthesize(text: string): AsyncGenerator<Buffer>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}

type State = 'idle' | 'listening' | 'processing' | 'speaking';

/** How many frames we may run ahead of real time when streaming TTS (firmware buffers 80). */
export const MAX_LEAD_FRAMES = 50;

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
  private abortRequested = false;
  private running: Promise<void> | null = null;
  private disposed = false;
  private closed = false;

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
  }

  /** Wait for any in-flight processing (used by tests and by the socket close handler). */
  async drain(): Promise<void> {
    while (this.running) await this.running;
  }

  dispose(): void {
    this.disposed = true;
    this.abortRequested = true;
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
          audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: FRAME_MS },
        });
        break;
      case 'listen':
        if (msg.mode === 'auto' || msg.mode === 'manual' || msg.mode === 'realtime') this.mode = msg.mode;
        if (msg.state === 'start' || msg.state === 'detect') {
          if (this.state === 'idle' || this.state === 'listening') this.startListening();
        } else if (msg.state === 'stop') {
          if (this.state === 'listening' && this.pcmChunks.length > 0) this.startProcessing();
        }
        break;
      case 'abort':
        this.abortRequested = true;
        break;
      case 'mcp':
        // Tool results are not used in this round; acknowledged silently.
        break;
      default:
        this.deps.log(`unhandled message type ${msg.type}`);
    }
  }

  handleBinary(frame: Buffer): void {
    if (this.disposed || this.state !== 'listening') return;
    const now = this.deps.now();
    if (now - this.ttsEndedAt < this.deps.config.echoGuardMs) return;
    let pcm: Buffer;
    try { pcm = this.deps.codec.decode(frame); } catch { return; }
    const ev = this.vad.push(rms(pcm));
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

  private startListening(): void {
    this.state = 'listening';
    this.deps.log(`listening (mode=${this.mode})`);
    this.resetCapture();
  }

  private resetCapture(): void {
    this.pcmChunks = [];
    this.preRoll = [];
    this.vad.reset();
  }

  private startProcessing(): void {
    if (this.disposed) return;
    const pcm = Buffer.concat(this.pcmChunks);
    this.resetCapture();
    this.state = 'processing';
    this.abortRequested = false;
    this.running = this.process(pcm).catch(err => this.deps.log(`process error: ${(err as Error).message}`)).finally(() => {
      this.running = null;
      if (!this.disposed && this.state !== 'idle') this.state = 'listening';
    });
  }

  private async process(pcm: Buffer): Promise<void> {
    const text = await this.deps.transcribe(pcm);
    if (this.abortRequested || !this.socket.isOpen) return;
    if (!text) { this.deps.log('empty transcript'); return; }
    this.socket.sendText({ session_id: this.sessionId, type: 'stt', text });
    this.history.push({ role: 'user', content: text });
    this.trimHistory();

    const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history];
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
      for await (const frame of this.deps.synthesize(sentence)) {
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
        // Wait until we can decide whether the reply starts with a tag.
        if (/^\s*\[/.test(full) && !/\]/.test(full)) return;
        delta = sendEmotion();
      }
      for (const s of acc.push(delta)) await speak(s);
    };

    try {
      for await (const chunk of this.deps.chat(messages)) {
        if (this.abortRequested) break;
        await handleChunk(chunk);
      }
      if (!this.abortRequested) {
        if (!emotionSent && full.trim()) {
          for (const s of acc.push(sendEmotion())) await speak(s);
        }
        const tail = acc.flush();
        if (tail) await speak(tail);
        completed = !this.abortRequested;
      }
    } finally {
      if (ttsStarted && this.socket.isOpen) {
        // Let the device play out what we sent ahead of real time before announcing the end.
        const remaining = playEnd - this.deps.now();
        if (remaining > 0 && !this.abortRequested) await this.deps.sleep(remaining);
        if (this.socket.isOpen) {
          this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'stop' });
          this.ttsEndedAt = this.deps.now();
        }
      }
      // A finished reply is stored whole; an aborted or failed one only as far as it was spoken.
      const reply = completed ? full.trim() : spoken.join(' ');
      if (reply) this.history.push({ role: 'assistant', content: reply });
      this.trimHistory();
      this.lastSpeechAt = this.deps.now();
    }
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
