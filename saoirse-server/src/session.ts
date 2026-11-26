import { parseBusRequest, parseRailRequest } from './transport_request.js';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { FRAME_MS, OUTPUT_SAMPLE_RATE, OUT_FRAME_BYTES, rms, type OpusCodec } from './opus.js';
import { EnergyVad } from './vad.js';
import { SentenceAccumulator, extractEmotion, speechText } from './text.js';
import { SYSTEM_PROMPT } from './persona.js';
import { formatLocalTime, localHourMinute, spokenTime } from './clock.js';
import type { ChatMessage, ChatEvent, ToolCall, ToolSpec } from './llm.js';
import { DeviceMcp } from './mcp.js';
import { callWithDeadline } from './deadline.js';
import type { ServerTool } from './server_tools.js';
import { CalendarConversation } from './calendar_conversation.js';
import type { CalendarChange, ICloudCalendar } from './icloud_calendar.js';
import { makeLiveCard, type LiveCard, type LiveCardItem } from './live_cards.js';

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
  /** Tools that run on the server (weather, web search), offered alongside the robot's. */
  serverTools?: ServerTool[];
  calendar?: Pick<ICloudCalendar, 'list' | 'prepare'>;
}

type LiveLookup = {
  name: 'get_weather' | 'get_london_departures';
  outcome: 'returned' | 'failed' | 'returned no board or forecast';
  source?: 'Open-Meteo' | 'TfL' | 'National Rail';
};

// These facts travel with the user turn in the device's bounded conversation history.
export type ConversationMessage = ChatMessage & { liveLookups?: LiveLookup[] };

function liveLookupAnswer(question: string, history: ConversationMessage[]): string | undefined {
  const words = question.trim().replace(/[.?!]+$/, '');
  const asksAboutTool = /^(?:did you (?:actually |really )?(?:use (?:a |the |any )?tool|call (?:a |the |any )?tool|make (?:a |the |any )?tool call)|(?:which|what) (?:tool|source) did you (?:use|call)|where did you get)(?:\s+[^.!?]+)?$/i.test(words);
  if (!asksAboutTool) return;
  const weather = /\b(?:weather|forecast)\b/i.test(words);
  const rail = /\b(?:train|rail|waterloo)\b/i.test(words);
  const tfl = /\b(?:bus|tube|underground|tfl)\b/i.test(words);
  const transport = rail || tfl || /\b(?:departures?|arrivals?)\b/i.test(words);
  if (weather && transport) return;

  const previous = history.filter(message => message.role === 'user').at(-2);
  const lookups = previous?.liveLookups ?? [];
  const lookup = [...lookups].reverse().find(entry => weather ? entry.name === 'get_weather'
    : !transport || entry.name === 'get_london_departures' && !(rail && entry.source === 'TfL') && !(tfl && entry.source === 'National Rail'));
  if (!lookup) return;
  const isWeather = lookup.name === 'get_weather';
  const label = isWeather ? 'weather' : 'departure';
  if (lookup.outcome === 'failed') return `I tried the ${label} lookup, but it failed.`;
  if (!lookup.source) return `I used the ${label} lookup, but it returned no usable data.`;
  return `Yes, I checked ${lookup.source} for that ${isWeather ? 'forecast' : 'departure information'}.`;
}

type ToolResult = { id: string; text: string; summary?: string };

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
export const MAX_TOOL_ROUNDS = 4;
const DEVICE_WRITES = new Set(['self.robot.set_head_angles', 'self.robot.set_led_color',
  'self.robot.create_reminder', 'self.robot.start_timer', 'self.robot.stop_reminder', 'self.audio_speaker.set_volume',
  'self.screen.set_brightness', 'self.screen.set_theme']);
const WRITE_REQUESTS: Record<string, RegExp> = {
  'self.robot.set_led_color': /\b(?:lights?|leds?|light bars?)\b/i,
  'self.robot.create_reminder': /\b(?:remind|set (?:a |the )?reminder)\b/i,
  'self.robot.stop_reminder': /\b(?:cancel|stop|remove|delete)\b.*\b(?:timer|reminder)\b/i,
  'self.audio_speaker.set_volume': /\b(?:louder|quieter|mute|unmute|turn (?:it|your voice) (?:up|down)|(?:set|increase|decrease|raise|lower).*volume)\b/i,
  'self.screen.set_brightness': /\b(?:brightness|brighter|dim|dimmer)\b/i,
  'self.screen.set_theme': /\b(?:theme|dark mode|light mode)\b/i,
};
const UNTRUSTED_READS = new Set(['self.camera.take_photo', 'web_search', 'get_london_departures', 'self.robot.get_reminders']);
const TIMER_REQUEST = /\b(?:set|start|add|create|give me|make me|run)\b[^.!?]{0,45}\b(?:timer|countdown)\b|^(?:a\s+)?(?:\w+[- ]+(?:seconds?|minutes?|hours?)\s+timer|timer (?:for\s+)?\w+)\b/i;
const TIMER_NEGATION = /\b(?:don['’]t|do not|never|cancel|stop)\b[^.!?]{0,45}\b(?:timer|countdown)\b/i;

function dueLabel(remaining: unknown): string | undefined {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0) return undefined;
  const seconds = Math.ceil(remaining / 1000);
  if (seconds === 0) return 'Due now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export const CAMERA_TOOL = 'self.camera.take_photo';
/** Spoken before a photo when the model said nothing first, so the robot is not silent for the capture. */
export const CAMERA_FILLER = 'Let me look.';
/**
 * While tools run after speech has started, send one silent frame this often. The robot's speaking
 * watchdog leaves the speaking state (and then drops all audio) after a stretch with no audio packet;
 * a photo or search round can be that long.
 */
export const TOOL_KEEPALIVE_MS = 2_000;
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
  readonly history: ConversationMessage[];
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
  private lastTransport?: Record<string, unknown>;
  private readonly calendar?: CalendarConversation;
  private inputFrames = 0;
  private guardedFrames = 0;
  private rejectedSpeech = 0;
  private decodeErrors = 0;
  private inputPeak = 0;
  private lastInputReport = 0;
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
  private readonly timers: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };

  constructor(
    private readonly socket: SessionSocket,
    private readonly deps: SessionDeps,
    readonly deviceId: string,
    history: ConversationMessage[] = [],
  ) {
    this.history = history;
    if (deps.calendar) this.calendar = new CalendarConversation(
      deps.calendar, deps.config.deviceTz, deps.config.toolTimeoutMs.other, deps.config.iCloudCalendar?.name,
    );
    const v = deps.config.vad;
    this.vad = new EnergyVad({ rmsThreshold: v.rmsThreshold, silenceMs: v.silenceMs, minSpeechMs: v.minSpeechMs, frameMs: FRAME_MS });
    this.lastSpeechAt = deps.now();
    this.startedAt = deps.now();
    const timers = this.timers = deps.timers ?? {
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
    if (this.state === 'listening' && now - this.lastInputReport >= 5000) {
      this.deps.log(`mic window: frames=${this.inputFrames} guarded=${this.guardedFrames} decodeErrors=${this.decodeErrors} peak=${this.inputPeak.toFixed(4)} short=${this.rejectedSpeech} threshold=${this.deps.config.vad.rmsThreshold}`);
      this.resetInputReport(now);
    }
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
    try { msg = JSON.parse(raw); } catch { this.deps.log("bad protocol JSON"); return; }
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
    this.inputFrames++;
    if (now - this.ttsEndedAt < this.deps.config.echoGuardMs || now < this.listenGuardUntil) {
      this.guardedFrames++;
      return;
    }
    let pcm: Buffer;
    try { pcm = this.deps.codec.decode(frame); } catch { this.decodeErrors++; return; }
    const level = rms(pcm);
    this.inputPeak = Math.max(this.inputPeak, level);
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
    else if (ev === 'too-short') { this.rejectedSpeech++; this.resetCapture(); }
  }

  private startListening(afterWake = false, at = this.deps.now()): void {
    this.state = 'listening';
    this.guardNextListen = false;
    // After a wake word the robot plays its popup chime into an open microphone; don't transcribe it.
    // `at` is when the robot said it started listening (a queued start keeps its arrival time).
    this.resetInputReport(at);
    this.listenGuardUntil = afterWake ? at + this.deps.config.wakeGuardMs : -Infinity;
    this.deps.log(`listening (mode=${this.mode}${afterWake ? `, wake guard ${this.deps.config.wakeGuardMs} ms` : ''})`);
    this.resetCapture();
  }

  private resetInputReport(at: number): void {
    this.lastInputReport = at;
    this.inputFrames = this.guardedFrames = this.decodeErrors = this.rejectedSpeech = 0;
    this.inputPeak = 0;
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
    const now = this.deps.now();
    let calendar = this.calendar?.accepts(text, now) ? this.calendar : undefined;
    this.deps.log(calendar || !this.deps.config.logConversation ? heard : `${heard}: "${text}"`);
    this.socket.sendText({ session_id: this.sessionId, type: 'stt', text });
    const definitionRequest = /\b(?:define|definition of|meaning of|what (?:does|do|did)\b[^?]*\bmean)\b/i.test(text);
    const transport = parseRailRequest(text) ?? parseBusRequest(text, this.lastTransport);
    let busReply = transport?.mode === 'bus' || /\b(?:bus|buses)\b/i.test(text) ||
      (this.lastTransport?.mode === 'bus' && /^(?:(?:and|what about|how about)\s+)?(?:next\s+)?(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b/i.test(text.trim()));

    const localTime = formatLocalTime(new Date(this.deps.now()), this.deps.config.deviceTz);
    const { hour, minute } = localHourMinute(new Date(this.deps.now()), this.deps.config.deviceTz);
    const system = `${SYSTEM_PROMPT}\nRobot tools currently available: ${this.mcp.tools.map(tool => tool.name).join(', ') || 'none confirmed yet'}.\n\nCurrent local time: ${localTime} (say it as: ${spokenTime(hour, minute)})`;
    const acc = new SentenceAccumulator();
    let emotionSent = false;
    let ttsStarted = false;
    let completed = false;
    let full = '';
    const spoken: string[] = [];
    const replyStartedAt = this.deps.now();
    let firstAudioAt: number | undefined;
    let audioFrames = 0;
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
      if (this.abortRequested || !this.socket.isOpen || (busReply && spoken.length >= 2)) return;
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
        firstAudioAt ??= this.deps.now();
        audioFrames++;
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

    let replyRoute = 'model';
    let userMessage: ConversationMessage | undefined;
    const liveLookups: LiveLookup[] = [];
    let calendarChange: CalendarChange | undefined;
    try {
      if (calendar) {
        const reply = await calendar.respond(text, now, signal, this.deps.chat);
        if (this.abortRequested) return;
        if (reply) {
          replyRoute = 'iCloud Calendar';
          this.lastTransport = undefined;
          busReply = false;
          if (reply.card) this.sendCard(reply.card);
          sendEmotion();
          for (const line of reply.lines) await speak(line);
          calendarChange = reply.change;
          completed = !this.abortRequested;
          return;
        }
        calendar = undefined;
      }
      userMessage = { role: 'user', content: text };
      this.history.push(userMessage);
      this.trimHistory();
      const lookupAnswer = liveLookupAnswer(text, this.history);
      if (lookupAnswer) {
        replyRoute = 'lookup history';
        full = lookupAnswer;
        sendEmotion();
        await speak(full);
        completed = !this.abortRequested;
        return;
      }
      const lookupHistory = this.history.filter(message => message.role === 'user').flatMap((message, index) =>
        message.liveLookups?.map(({ name, outcome, source }) =>
          `User message ${index + 1}: ${name} ${outcome}${source ? ` data from ${source}` : ''}.`) ?? []);
      const lookupContext = lookupHistory.length ? `\n\nPast live lookup record (numbered by user message in this conversation context):\n${lookupHistory.join('\n')}` : '';
      const working: ChatMessage[] = [
        { role: 'system', content: system + lookupContext },
        ...this.history.map(({ liveLookups: _liveLookups, ...message }) => message),
      ];
      let calls: ToolCall[] | null = null;
      if (transport && this.deps.serverTools?.some(t => t.spec.function.name === 'get_london_departures')) {
        const call = { id: transport.mode === 'rail' ? 'rail' : 'bus', name: 'get_london_departures', arguments: JSON.stringify(transport) };
        const [result] = await this.runTools([call], signal, { writesAllowed: false, cameraAvailable: false, liveLookups });
        if (this.abortRequested) return;
        if (result.summary) {
          replyRoute = transport.mode === 'rail' ? 'direct National Rail' : 'direct TfL';
          full = result.summary;
          sendEmotion();
          await speak(full);
          completed = !this.abortRequested;
          return;
        }
        working.push({ role: 'assistant', content: null, tool_calls: [{
          id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
        }] }, { role: 'tool', tool_call_id: call.id, content: result.text });
      }
      if (!transport) this.lastTransport = undefined;
      const briefing = /^(?:please )?(?:brief me\b|what(?:'s| is) my day like\b)/i.test(text.trim());
      if (briefing) {
        const checks: ToolCall[] = [
          { id: 'brief_weather', name: 'get_weather', arguments: '{"days":1}' },
          { id: 'brief_reminders', name: 'self.robot.get_reminders', arguments: '{}' },
        ];
        const results = await this.runTools(checks, signal, { writesAllowed: false, cameraAvailable: false, hideReminders: true, liveLookups });
        working.push({ role: 'assistant', content: null, tool_calls: checks.map(call => ({
          id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
        })) });
        for (const result of results) working.push({ role: 'tool', tool_call_id: result.id, content: result.text });
      }
      const cameraAvailable = this.mcp.has(CAMERA_TOOL);
      const visionRequest = /\b(?:see|picture|photo|camera|look at|read the label)\b/i.test(text);
      const moveRequested = /\b(?:turn|move|look)\b[^.!?]{0,45}\b(?:left|right|up|down|straight ahead)\b/i.test(text);
      const permitted = new Set(Object.entries(WRITE_REQUESTS)
        .filter(([, pattern]) => pattern.test(text)).map(([name]) => name));
      if (TIMER_REQUEST.test(text) && !TIMER_NEGATION.test(text)) {
        if (this.mcp.has('self.robot.start_timer')) {
          permitted.delete('self.robot.create_reminder');
          permitted.add('self.robot.start_timer');
        } else {
          permitted.add('self.robot.create_reminder');
        }
      }
      if (moveRequested && (!visionRequest || cameraAvailable)) permitted.add('self.robot.set_head_angles');
      let writesAllowed = !briefing;
      for (let round = 1; round <= MAX_TOOL_ROUNDS && !this.abortRequested; round++) {
        calls = null;
        const tools = [...(this.deps.serverTools ?? []).map(t => t.spec), ...this.mcp.toolSpecs()]
          .filter(tool => !transport || tool.function.name !== 'get_london_departures')
          .filter(tool => (!DEVICE_WRITES.has(tool.function.name) || writesAllowed && permitted.has(tool.function.name)));
        const holdForCamera = tools.some(tool => tool.function.name === CAMERA_TOOL);
        const holdForDefinition = definitionRequest && tools.some(tool => tool.function.name === 'show_word_definition');
        const holdText = holdForCamera || holdForDefinition;
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
          // A camera call has a fixed announcement and a bus tool can supply its own summary.
          if (!busReply && !holdText) await handleChunk(text);
        }
        if (this.abortRequested) break;
        if (!calls) {
          if (busReply || holdText) await handleChunk(roundText);
          break;
        }
        if (briefing) break;
        // Nothing to feed the results back into: don't run the robot for a reply that cannot follow.
        if (round === MAX_TOOL_ROUNDS) break;
        const cameraCall = calls.some(call => call.name === CAMERA_TOOL);
        const definitionCall = calls.some(call => call.name === 'show_word_definition');
        const suppressPreamble = cameraCall || definitionCall || (holdForCamera && visionRequest);
        if (!suppressPreamble && holdText && !busReply) await handleChunk(roundText);
        await flushText();
        if (full && !/\s$/.test(full)) full += ' ';
        // Keep the robot in its speaking state through the tool round (silent frames, see TOOL_KEEPALIVE_MS).
        let keepAlive: unknown = null;
        const tick = () => {
          if (this.abortRequested || !this.socket.isOpen) return;
          if (ttsStarted) {
            this.socket.sendBinary(this.deps.codec.encodeFrame(Buffer.alloc(OUT_FRAME_BYTES)));
            playEnd = Math.max(playEnd, this.deps.now()) + FRAME_MS;
          }
          keepAlive = this.timers.setTimeout(tick, TOOL_KEEPALIVE_MS);
        };
        keepAlive = this.timers.setTimeout(tick, TOOL_KEEPALIVE_MS);
        let results: ToolResult[];
        try {
          results = await this.runTools(calls, signal, {
            writesAllowed, cameraAvailable: cameraAvailable || this.mcp.has(CAMERA_TOOL),
            permitted, liveLookups,
            hideReminders: permitted.has('self.robot.stop_reminder') || permitted.has('self.robot.start_timer'),
            beforePhoto: async () => {
              if (!this.abortRequested && !emotionSent && this.socket.isOpen) sendEmotion();
              await speak(CAMERA_FILLER);
              const remaining = playEnd + TTS_STOP_MARGIN_MS - this.deps.now();
              if (remaining > 0 && !signal.aborted) await this.deps.sleep(remaining);
            },
          });
          if (calls.some(call => UNTRUSTED_READS.has(call.name))) writesAllowed = false;
        } finally {
          this.timers.clearTimeout(keepAlive);
        }
        const summary = results.length === 1 ? results[0].summary : undefined;
        // A card can supply a concise spoken announcement.
        if (summary && !this.abortRequested) {
          busReply = true;
          full = summary;
          if (definitionCall) replyRoute = 'definition card';
          if (!emotionSent) sendEmotion();
          await speak(summary);
          calls = null;
          break;
        }
        working.push({
          role: 'assistant', content: suppressPreamble ? null : stripTag(roundText).trim() || null,
          tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        });
        for (const r of results) working.push({ role: 'tool', tool_call_id: r.id, content: r.text });
      }
      if (!this.abortRequested) {
        if (calls) { await flushText(); await speak(LOOP_FILLER); full += ` ${LOOP_FILLER}`; }
        else await flushText();
        if (!ttsStarted) throw new Error('Reply contained no speakable text');
        completed = !this.abortRequested;
      }
    } catch (err) {
      if (calendar && this.abortRequested) return;
      if (calendar) this.deps.log('iCloud Calendar reply failed');
      if (!ttsStarted && !this.abortRequested && this.socket.isOpen) {
        if (!calendar) this.deps.log(`reply failed before speech: ${(err as Error).message}`);
        this.socket.sendText({ session_id: this.sessionId, type: 'llm', emotion: 'neutral', text: '' });
        await speak("I couldn't finish that reply. Could you ask me again?");
      } else if (!calendar) {
        throw err;
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
          this.deps.log(`reply timing: route ${replyRoute}, first audio ${firstAudioAt === undefined ? 'none' : firstAudioAt - replyStartedAt + ' ms'}, voiced ${audioFrames * FRAME_MS} ms, stop ${this.deps.now() - replyStartedAt} ms`);
          this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'stop' });
          // Echo guard only after a reply that played out; after an abort the device already
          // stopped playing, and the utterance that interrupted it must not be dropped.
          if (!this.abortRequested) this.ttsEndedAt = this.deps.now();
        }
      }
      // A finished reply is stored whole; an aborted or failed one only as far as it was spoken.
      const reply = completed && !busReply ? full.trim() : spoken.join(' ');
      if (calendarChange && completed && !this.abortRequested && this.socket.isOpen) calendar?.stage(calendarChange, this.deps.now());
      if (userMessage && liveLookups.length) userMessage.liveLookups = liveLookups;
      if (reply && !calendar) this.history.push({ role: 'assistant', content: reply });
      this.trimHistory();
      this.lastSpeechAt = this.deps.now();
    }
  }

  private sendCard(card: LiveCard): void {
    if (this.socket.isOpen) this.socket.sendText({ type: 'info_card', session_id: this.sessionId, card });
  }

  /** Runs the model's tool calls on the robot, in order; every failure becomes an `Error: …` tool result. */
  private async runTools(calls: ToolCall[], signal: AbortSignal, policy: {
    writesAllowed: boolean;
    cameraAvailable: boolean;
    permitted?: Set<string>;
    hideReminders?: boolean;
    liveLookups: LiveLookup[];
    beforePhoto?: () => Promise<void>;
  }): Promise<ToolResult[]> {
    const out: ToolResult[] = [];
    let writesAllowed = policy.writesAllowed;
    let movementFailed = false;
    for (const call of calls) {
      if ((DEVICE_WRITES.has(call.name) && (!writesAllowed || !policy.permitted?.has(call.name))) ||
          (call.name === CAMERA_TOOL && movementFailed)) {
        out.push({ id: call.id, text: 'Error: the requested device action could not be performed safely.' });
        continue;
      }
      if (UNTRUSTED_READS.has(call.name)) writesAllowed = false;
      let args: Record<string, unknown> = {};
      try { args = call.arguments.trim() ? JSON.parse(call.arguments) : {}; } catch { out.push({ id: call.id, text: 'Error: tool arguments were not valid JSON' }); continue; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) { out.push({ id: call.id, text: 'Error: tool arguments must be a JSON object' }); continue; }
      if (call.name === 'self.robot.start_timer' && (typeof args.duration_seconds !== 'number' ||
          !Number.isInteger(args.duration_seconds) || args.duration_seconds < 1 || args.duration_seconds > 86400)) {
        out.push({ id: call.id, text: 'Error: provide a timer duration from 1 second to 24 hours.' });
        continue;
      }
      const isCamera = call.name === CAMERA_TOOL;
      const serverTool = this.deps.serverTools?.find(t => t.spec.function.name === call.name);
      const timeoutMs = serverTool ? serverTool.timeoutMs : isCamera ? this.deps.config.toolTimeoutMs.camera : this.deps.config.toolTimeoutMs.other;
      let text: string;
      let summary: string | undefined;
      let lookupStarted = false;
      let lookupSource: LiveLookup['source'];
      try {
        if (serverTool) {
          text = await callWithDeadline(call.name, timeoutMs, signal, s => {
            lookupStarted = true;
            return serverTool.run(args, s, (card, spokenSummary) => {
              if (s.aborted) return;
              summary = spokenSummary;
              if (call.name === 'get_london_departures') this.lastTransport = args;
              if (card.source === 'Open-Meteo' || card.source === 'TfL' || card.source === 'National Rail') lookupSource = card.source;
              this.sendCard(card);
            });
          });
        } else if (!this.mcp.has(call.name) || (isCamera && !policy.cameraAvailable)) {
          // Never send the robot a tool it didn't offer: it answers slowly, and only with an error.
          text = this.mcp.loading
            ? 'Error: your robot tools are still starting up. Say so briefly and ask them to try again in a moment.'
            : `Error: there is no tool called ${call.name}. You can't do that right now; say so briefly.`;
        } else {
          if (isCamera) await policy.beforePhoto?.();
          text = await this.mcp.callTool(call.name, args, { timeoutMs, signal });
          if (call.name === 'self.robot.start_timer' && !text.startsWith('Error:')) policy.permitted?.delete(call.name);
          if (isCamera) text = cameraResultText(text);
          if (call.name === 'self.robot.get_reminders') {
            try {
              const reminders = JSON.parse(text);
              if (Array.isArray(reminders)) {
                const entries = reminders.filter(entry => entry && typeof entry.message === 'string');
                text = JSON.stringify(entries.map(({ id, message, repeat, remaining_ms, timer }) => ({ id, message, repeat, remaining_ms, timer })));
                if (!policy.hideReminders && !signal.aborted) {
                  const items: LiveCardItem[] = entries.sort((a, b) => (a.remaining_ms ?? Infinity) - (b.remaining_ms ?? Infinity)).slice(0, 11)
                    .map(({ message, remaining_ms, timer, repeat }) => ({ title: message.slice(0, 160),
                      badge: dueLabel(remaining_ms), detail: timer ? 'Timer' : repeat ? 'Repeats' : undefined }));
                  if (!items.length) items.push({ title: 'No reminders or timers set' });
                  if (entries.length > 11) items.push({ title: `${entries.length - 11} more reminders` });
                  this.sendCard(makeLiveCard('reminders', 'Reminders & timers', '', items));
                }
              }
            } catch {
              text = 'Error: the robot returned an unreadable reminder list.';
            }
          }
        }
      } catch (err) {
        text = `Error: ${(err as Error).message}`;
      }
      if (lookupStarted && (call.name === 'get_weather' || call.name === 'get_london_departures')) {
        const outcome = text.startsWith('Error:') ? 'failed' : lookupSource ? 'returned' : 'returned no board or forecast';
        policy.liveLookups.push({ name: call.name, outcome, source: outcome === 'returned' ? lookupSource : undefined });
      }
      if (call.name === 'self.robot.set_head_angles') movementFailed = text.startsWith('Error:');
      this.deps.log(!this.deps.config.logConversation
        ? `tool ${call.name}: ${text.startsWith('Error:') ? 'failed' : 'returned'}`
        : `tool ${call.name} ${call.arguments.slice(0, 80)} -> ${text.replace(/\s+/g, ' ').slice(0, 100)}`);
      out.push({ id: call.id, text, summary });
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
