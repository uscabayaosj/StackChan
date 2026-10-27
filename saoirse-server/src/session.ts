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
const MAX_LEAD_FRAMES = 50;

export class Session {
  readonly history: ChatMessage[];
  private state: State = 'idle';
  private sessionId = randomUUID();
  private mode: 'auto' | 'manual' | 'realtime' = 'auto';
  private packets: Buffer[] = [];
  private pcmChunks: Buffer[] = [];
  private vad: EnergyVad;
  private preRoll: Buffer[] = [];
  private lastSpeechAt: number;
  private startedAt: number;
  private ttsEndedAt = -Infinity;
  private abortRequested = false;
  private running: Promise<void> | null = null;
  private disposed = false;

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
    const now = this.deps.now();
    const { idleCloseMs, hardCloseMs } = this.deps.config;
    if (this.state !== 'processing' && this.state !== 'speaking' && now - this.lastSpeechAt > idleCloseMs) {
      this.deps.log('idle timeout, closing');
      this.socket.close();
    } else if (now - this.startedAt > hardCloseMs) {
      this.deps.log('hard timeout, closing');
      this.socket.close();
    }
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
          if (this.state === 'listening' && this.packets.length > 0) this.startProcessing();
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
    if (this.state !== 'listening') return;
    const now = this.deps.now();
    if (now - this.ttsEndedAt < this.deps.config.echoGuardMs) return;
    let pcm: Buffer;
    try { pcm = this.deps.codec.decode(frame); } catch { return; }
    const ev = this.vad.push(rms(pcm));
    if (ev === 'speech') {
      if (this.packets.length === 0) { this.packets.push(...this.preRoll); this.pcmChunks.push(...this.preRoll.map(p => this.deps.codec.decode(p))); }
      this.packets.push(frame);
      this.pcmChunks.push(pcm);
      this.lastSpeechAt = now;
      return;
    }
    if (this.packets.length > 0) { this.packets.push(frame); this.pcmChunks.push(pcm); }
    else {
      const preRollFrames = Math.ceil(this.deps.config.vad.preRollMs / FRAME_MS);
      this.preRoll.push(frame);
      if (this.preRoll.length > preRollFrames) this.preRoll.shift();
    }
    if (ev === 'end') this.startProcessing();
    else if (ev === 'too-short') this.resetCapture();
  }

  private startListening(): void {
    this.state = 'listening';
    this.resetCapture();
  }

  private resetCapture(): void {
    this.packets = [];
    this.pcmChunks = [];
    this.preRoll = [];
    this.vad.reset();
  }

  private startProcessing(): void {
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
    if (!text) { this.deps.log('empty transcript'); return; }
    this.socket.sendText({ session_id: this.sessionId, type: 'stt', text });
    this.history.push({ role: 'user', content: text });
    this.trimHistory();

    const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history];
    const acc = new SentenceAccumulator();
    let emotionSent = false;
    let ttsStarted = false;
    let full = '';
    let frameIndex = 0;
    const speakStart = this.deps.now();

    const speak = async (sentence: string) => {
      if (this.abortRequested || !this.socket.isOpen) return;
      if (!ttsStarted) { this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'start' }); ttsStarted = true; this.state = 'speaking'; }
      this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'sentence_start', text: sentence });
      for await (const frame of this.deps.synthesize(sentence)) {
        if (this.abortRequested || !this.socket.isOpen) return;
        const lead = frameIndex - Math.floor((this.deps.now() - speakStart) / FRAME_MS);
        if (lead > MAX_LEAD_FRAMES) await this.deps.sleep((lead - MAX_LEAD_FRAMES) * FRAME_MS);
        this.socket.sendBinary(frame);
        frameIndex++;
      }
    };

    const handleChunk = async (chunk: string) => {
      full += chunk;
      let delta = chunk;
      if (!emotionSent) {
        // Wait until we can decide whether the reply starts with a tag.
        if (!/^\s*\[/.test(full) || /\]/.test(full)) {
          const { emotion, rest } = extractEmotion(full);
          this.socket.sendText({ session_id: this.sessionId, type: 'llm', emotion, text: '' });
          emotionSent = true;
          delta = rest;
          full = rest;
        } else return;
      }
      for (const s of acc.push(delta)) await speak(s);
    };

    for await (const chunk of this.deps.chat(messages)) {
      if (this.abortRequested) break;
      await handleChunk(chunk);
    }
    if (!emotionSent && full) {
      const { emotion, rest } = extractEmotion(full);
      this.socket.sendText({ session_id: this.sessionId, type: 'llm', emotion, text: '' });
      emotionSent = true;
      full = rest;
      for (const s of acc.push(rest)) await speak(s);
    }
    const tail = acc.flush();
    if (tail && !this.abortRequested) await speak(tail);

    // After an abort the device must still be told to stop speaking, even if no audio had started yet.
    const aborted = this.abortRequested && !this.disposed && this.socket.isOpen;
    if (ttsStarted || aborted) {
      // Let the device drain what we sent ahead of real time before announcing the end.
      const lead = frameIndex - Math.floor((this.deps.now() - speakStart) / FRAME_MS);
      if (lead > 0 && !this.abortRequested) await this.deps.sleep(lead * FRAME_MS);
      if (this.socket.isOpen) this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'stop' });
      this.ttsEndedAt = this.deps.now();
    }
    if (full.trim()) this.history.push({ role: 'assistant', content: full.trim() });
    this.trimHistory();
    this.lastSpeechAt = this.deps.now();
  }

  private trimHistory(): void {
    const max = this.deps.config.contextTurns * 2;
    while (this.history.length > max) this.history.shift();
  }
}
