# Saoirse AI Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript server on Vercel that speaks the xiaozhi v1 WebSocket protocol to the StackChan and answers as Saoirse: ElevenLabs Scribe for speech-to-text, an OpenAI-compatible LLM (OpenRouter → gpt-oss-20b on Groq by default), ElevenLabs Flash v2.5 for the voice, streamed back as Opus.

**Architecture:** Two Vercel Functions in `saoirse-server/api/`: `ota.ts` answers the robot's boot check with the WebSocket URL, and `ws.ts` exports a Node `http.Server` with a `ws` WebSocketServer that hands each connection to a `Session` state machine. The session decodes Opus to PCM for energy VAD, then runs STT → streaming LLM (sentence by sentence) → TTS → Opus frames paced at 60 ms. The same server runs locally with `npm run dev`. All provider calls go through small modules with injected `fetch` so they are unit-testable without keys.

**Tech Stack:** Node 22, TypeScript 5, `ws` 8, `@discordjs/opus` (native, Linux x64 prebuilds on Vercel) with `opusscript` WASM fallback, `vitest`, `tsx`, Vercel CLI. Spec: `docs/superpowers/specs/2026-10-27-saoirse-design.md` §7–§8.

## Global Constraints

- Audio to and from the robot: Opus, 16 kHz, mono, **60 ms frames (960 samples, 1920 PCM bytes)**, binary WebSocket frames, protocol `version: 1`.
- Server hello must contain `"transport": "websocket"` and `"audio_params": {"format":"opus","sample_rate":16000,"channels":1,"frame_duration":60}`.
- Emotion strings the firmware accepts: `neutral, happy, laughing, angry, sad, crying, sleepy, doubtful`. The LLM tag set is `neutral|happy|angry|sad|doubtful|sleepy`.
- End idle sessions after **60 s** without speech; hard-close at **280 s** (Vercel Hobby max duration is 300 s).
- Ignore device audio for **1.5 s** after `tts stop` (echo guard).
- Keys only in environment variables (`.env.local` for local dev, git-ignored; Vercel env for prod). Never commit keys.
- Every task ends with `npm test` green and a commit on branch `saoirse` in `~/Developer/StackChan`.

---

### Task 1: Project scaffold and config

**Files:**
- Create: `saoirse-server/package.json`, `saoirse-server/tsconfig.json`, `saoirse-server/vitest.config.ts`, `saoirse-server/vercel.json`, `saoirse-server/.gitignore`, `saoirse-server/.env.example`
- Create: `saoirse-server/src/config.ts`
- Test: `saoirse-server/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` and the `Config` type (fields below) used by every later task.

- [ ] **Step 1: Create the project files**

`saoirse-server/package.json`:
```json
{
  "name": "saoirse-server",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": "22.x" },
  "scripts": {
    "dev": "tsx scripts/dev.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "fake-robot": "tsx scripts/fake-robot.ts"
  },
  "dependencies": {
    "@discordjs/opus": "^0.10.0",
    "opusscript": "^0.1.1",
    "ws": "^8.22.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.12",
    "@vercel/node": "^5.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`saoirse-server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["api", "src", "scripts", "test"]
}
```

`saoirse-server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

`saoirse-server/vercel.json`:
```json
{
  "functions": {
    "api/ws.ts": { "maxDuration": 300 },
    "api/ota.ts": { "maxDuration": 10 }
  }
}
```

`saoirse-server/.gitignore`:
```
node_modules
.env.local
.vercel
out
```

`saoirse-server/.env.example`:
```
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=
LLM_MODEL=openai/gpt-oss-20b
LLM_PROVIDER_ORDER=groq
LLM_FALLBACK_BASE_URL=https://api.deepseek.com/v1
LLM_FALLBACK_API_KEY=
LLM_FALLBACK_MODEL=deepseek-flash
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
ELEVENLABS_STT_MODEL=scribe_v2
SAOIRSE_DEVICE_TOKEN=
PUBLIC_WS_URL=ws://192.168.1.10:8765/api/ws
VAD_RMS_THRESHOLD=0.025
VAD_SILENCE_MS=800
IDLE_CLOSE_MS=60000
```

- [ ] **Step 2: Write the failing config test**

`saoirse-server/test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v',
  PUBLIC_WS_URL: 'wss://x/api/ws', SAOIRSE_DEVICE_TOKEN: 't',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.llm.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(c.llm.model).toBe('openai/gpt-oss-20b');
    expect(c.llm.providerOrder).toEqual(['groq']);
    expect(c.elevenlabs.ttsModel).toBe('eleven_flash_v2_5');
    expect(c.elevenlabs.sttModel).toBe('scribe_v2');
    expect(c.vad.rmsThreshold).toBeCloseTo(0.025);
    expect(c.vad.silenceMs).toBe(800);
    expect(c.idleCloseMs).toBe(60000);
    expect(c.fallbackLlm).toBeUndefined();
  });
  it('reads the fallback LLM only when its key is set', () => {
    const c = loadConfig({ ...base, LLM_FALLBACK_API_KEY: 'd' });
    expect(c.fallbackLlm?.model).toBe('deepseek-flash');
    expect(c.fallbackLlm?.baseUrl).toBe('https://api.deepseek.com/v1');
  });
  it('throws on a missing required key', () => {
    expect(() => loadConfig({ ...base, ELEVENLABS_API_KEY: '' })).toThrow(/ELEVENLABS_API_KEY/);
  });
});
```

- [ ] **Step 3: Install and run the test to see it fail**

```bash
cd ~/Developer/StackChan/saoirse-server && npm install && npx vitest run test/config.test.ts
```
Expected: FAIL, "Cannot find module '../src/config.js'".

- [ ] **Step 4: Implement config.ts**

`saoirse-server/src/config.ts`:
```ts
export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerOrder?: string[];
}

export interface Config {
  llm: LlmConfig;
  fallbackLlm?: LlmConfig;
  elevenlabs: { apiKey: string; voiceId: string; ttsModel: string; sttModel: string };
  deviceToken: string;
  publicWsUrl: string;
  vad: { rmsThreshold: number; silenceMs: number; minSpeechMs: number; preRollMs: number };
  idleCloseMs: number;
  hardCloseMs: number;
  echoGuardMs: number;
  contextTurns: number;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  return v === undefined || v === '' ? dflt : Number(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fallbackKey = env.LLM_FALLBACK_API_KEY;
  return {
    llm: {
      baseUrl: env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: req(env, 'LLM_API_KEY'),
      model: env.LLM_MODEL || 'openai/gpt-oss-20b',
      providerOrder: (env.LLM_PROVIDER_ORDER ?? 'groq').split(',').map(s => s.trim()).filter(Boolean),
    },
    fallbackLlm: fallbackKey
      ? {
          baseUrl: env.LLM_FALLBACK_BASE_URL || 'https://api.deepseek.com/v1',
          apiKey: fallbackKey,
          model: env.LLM_FALLBACK_MODEL || 'deepseek-flash',
        }
      : undefined,
    elevenlabs: {
      apiKey: req(env, 'ELEVENLABS_API_KEY'),
      voiceId: req(env, 'ELEVENLABS_VOICE_ID'),
      ttsModel: env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5',
      sttModel: env.ELEVENLABS_STT_MODEL || 'scribe_v2',
    },
    deviceToken: env.SAOIRSE_DEVICE_TOKEN || '',
    publicWsUrl: req(env, 'PUBLIC_WS_URL'),
    vad: {
      rmsThreshold: num(env, 'VAD_RMS_THRESHOLD', 0.025),
      silenceMs: num(env, 'VAD_SILENCE_MS', 800),
      minSpeechMs: num(env, 'VAD_MIN_SPEECH_MS', 300),
      preRollMs: num(env, 'VAD_PREROLL_MS', 300),
    },
    idleCloseMs: num(env, 'IDLE_CLOSE_MS', 60_000),
    hardCloseMs: num(env, 'HARD_CLOSE_MS', 280_000),
    echoGuardMs: num(env, 'ECHO_GUARD_MS', 1_500),
    contextTurns: num(env, 'CONTEXT_TURNS', 10),
  };
}
```

- [ ] **Step 5: Run the test**

```bash
npx vitest run test/config.test.ts
```
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/StackChan && git add saoirse-server && git commit -m "saoirse-server: scaffold and config"
```

---

### Task 2: Opus codec and framing

**Files:**
- Create: `saoirse-server/src/opus.ts`
- Test: `saoirse-server/test/opus.test.ts`

**Interfaces:**
- Produces: `FRAME_SAMPLES = 960`, `FRAME_BYTES = 1920`, `createCodec(): OpusCodec` with `encodeFrame(pcm: Buffer): Buffer`, `decode(packet: Buffer): Buffer` (PCM16LE), and `pcmToFrames(pcm: Buffer): Buffer[]` (zero-pads the tail), `rms(pcm: Buffer): number` (0..1).

- [ ] **Step 1: Write the failing test**

`saoirse-server/test/opus.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createCodec, pcmToFrames, rms, FRAME_BYTES, FRAME_SAMPLES } from '../src/opus.js';

function sine(samples: number, amp = 8000, freq = 440, rate = 16000): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  return b;
}

describe('opus', () => {
  it('splits PCM into 60 ms frames and zero-pads the tail', () => {
    const frames = pcmToFrames(Buffer.alloc(FRAME_BYTES * 2 + 100));
    expect(frames).toHaveLength(3);
    expect(frames.every(f => f.length === FRAME_BYTES)).toBe(true);
    expect(frames[2].subarray(100).every(b => b === 0)).toBe(true);
  });
  it('round-trips a frame through the encoder and decoder', () => {
    const codec = createCodec();
    const packet = codec.encodeFrame(sine(FRAME_SAMPLES));
    expect(packet.length).toBeGreaterThan(10);
    expect(packet.length).toBeLessThan(400);
    const pcm = codec.decode(packet);
    expect(pcm.length).toBe(FRAME_BYTES);
    expect(rms(pcm)).toBeGreaterThan(0.05);
  });
  it('rms is 0 for silence and ~0.17 for a 8000-amplitude sine', () => {
    expect(rms(Buffer.alloc(FRAME_BYTES))).toBe(0);
    expect(rms(sine(FRAME_SAMPLES))).toBeCloseTo(0.17, 1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/opus.test.ts
```
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement opus.ts**

`saoirse-server/src/opus.ts`:
```ts
import { createRequire } from 'node:module';

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;
export const FRAME_MS = 60;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 960
export const FRAME_BYTES = FRAME_SAMPLES * 2; // 1920

export interface OpusCodec {
  encodeFrame(pcm: Buffer): Buffer;
  decode(packet: Buffer): Buffer;
}

const require = createRequire(import.meta.url);

function nativeCodec(): OpusCodec {
  const { OpusEncoder } = require('@discordjs/opus') as { OpusEncoder: new (rate: number, ch: number) => any };
  const enc = new OpusEncoder(SAMPLE_RATE, CHANNELS);
  enc.setBitrate(24000);
  return {
    encodeFrame: (pcm) => Buffer.from(enc.encode(pcm)),
    decode: (packet) => Buffer.from(enc.decode(packet)),
  };
}

function wasmCodec(): OpusCodec {
  const OpusScript = require('opusscript') as any;
  const enc = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
  enc.setBitrate(24000);
  return {
    encodeFrame: (pcm) => Buffer.from(enc.encode(pcm, FRAME_SAMPLES)),
    decode: (packet) => Buffer.from(enc.decode(packet)),
  };
}

export function createCodec(): OpusCodec {
  try {
    return nativeCodec();
  } catch (err) {
    console.warn('[opus] native @discordjs/opus unavailable, using opusscript:', (err as Error).message);
    return wasmCodec();
  }
}

export function pcmToFrames(pcm: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
    const chunk = pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length));
    if (chunk.length === FRAME_BYTES) frames.push(chunk);
    else {
      const padded = Buffer.alloc(FRAME_BYTES);
      chunk.copy(padded);
      frames.push(padded);
    }
  }
  return frames;
}

export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    acc += s * s;
  }
  return Math.sqrt(acc / n);
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run test/opus.test.ts
```
Expected: 3 passed. If the native module fails to load on this Mac, the warning prints and the WASM path is used; the test must still pass.

- [ ] **Step 5: Commit**

```bash
git add saoirse-server && git commit -m "saoirse-server: opus codec and 60ms framing"
```

---

### Task 3: Energy VAD

**Files:**
- Create: `saoirse-server/src/vad.ts`
- Test: `saoirse-server/test/vad.test.ts`

**Interfaces:**
- Produces: `class EnergyVad { constructor(opts: {rmsThreshold:number; silenceMs:number; minSpeechMs:number; frameMs:number}); push(frameRms: number): 'silence' | 'speech' | 'end' | 'too-short'; reset(): void; speechMs: number }`.

- [ ] **Step 1: Write the failing test**

`saoirse-server/test/vad.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { EnergyVad } from '../src/vad.js';

const mk = () => new EnergyVad({ rmsThreshold: 0.02, silenceMs: 300, minSpeechMs: 180, frameMs: 60 });

describe('EnergyVad', () => {
  it('stays silent on quiet frames', () => {
    const v = mk();
    for (let i = 0; i < 20; i++) expect(v.push(0.001)).toBe('silence');
  });
  it('reports end after speech followed by enough silence', () => {
    const v = mk();
    const out: string[] = [];
    for (let i = 0; i < 5; i++) out.push(v.push(0.1)); // 300 ms speech
    for (let i = 0; i < 4; i++) out.push(v.push(0.001)); // 240 ms silence
    out.push(v.push(0.001)); // 300 ms silence -> end
    expect(out.slice(0, 5)).toEqual(['speech', 'speech', 'speech', 'speech', 'speech']);
    expect(out[8]).toBe('silence');
    expect(out[9]).toBe('end');
    expect(v.speechMs).toBe(300);
  });
  it('reports too-short for a blip shorter than minSpeechMs', () => {
    const v = mk();
    v.push(0.1); v.push(0.1); // 120 ms
    for (let i = 0; i < 4; i++) v.push(0.001);
    expect(v.push(0.001)).toBe('too-short');
  });
  it('reset clears state', () => {
    const v = mk();
    v.push(0.1); v.reset();
    expect(v.speechMs).toBe(0);
    expect(v.push(0.001)).toBe('silence');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/vad.test.ts
```
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement vad.ts**

`saoirse-server/src/vad.ts`:
```ts
export type VadEvent = 'silence' | 'speech' | 'end' | 'too-short';

export interface VadOptions {
  rmsThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  frameMs: number;
}

export class EnergyVad {
  speechMs = 0;
  private silenceMsSinceSpeech = 0;
  private inSpeech = false;

  constructor(private readonly opts: VadOptions) {}

  reset(): void {
    this.speechMs = 0;
    this.silenceMsSinceSpeech = 0;
    this.inSpeech = false;
  }

  push(frameRms: number): VadEvent {
    const { frameMs } = this.opts;
    if (frameRms >= this.opts.rmsThreshold) {
      this.inSpeech = true;
      this.speechMs += frameMs;
      this.silenceMsSinceSpeech = 0;
      return 'speech';
    }
    if (!this.inSpeech) return 'silence';
    this.silenceMsSinceSpeech += frameMs;
    if (this.silenceMsSinceSpeech < this.opts.silenceMs) return 'silence';
    const result: VadEvent = this.speechMs >= this.opts.minSpeechMs ? 'end' : 'too-short';
    this.reset();
    return result;
  }
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run test/vad.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add saoirse-server && git commit -m "saoirse-server: energy VAD"
```

---

### Task 4: Sentence splitter and emotion tag

**Files:**
- Create: `saoirse-server/src/text.ts`
- Test: `saoirse-server/test/text.test.ts`

**Interfaces:**
- Produces: `class SentenceAccumulator { push(delta: string): string[]; flush(): string | null }` and `extractEmotion(text: string): { emotion: Emotion; rest: string }` with `type Emotion = 'neutral'|'happy'|'angry'|'sad'|'doubtful'|'sleepy'` and `EMOTIONS` array.

- [ ] **Step 1: Write the failing test**

`saoirse-server/test/text.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { SentenceAccumulator, extractEmotion } from '../src/text.js';

describe('SentenceAccumulator', () => {
  it('emits sentences as tokens arrive and keeps the remainder', () => {
    const a = new SentenceAccumulator();
    expect(a.push('You said "we')).toEqual([]);
    expect(a.push("'ll see." + ' That means no')).toEqual(['You said "we\'ll see."']);
    expect(a.push('. Ask the real question?')).toEqual(['That means no.']);
    expect(a.flush()).toBe('Ask the real question?');
    expect(a.flush()).toBeNull();
  });
  it('does not split on decimals or common abbreviations', () => {
    const a = new SentenceAccumulator();
    expect(a.push('It is 3.5 kg, e.g. heavy. Fine.')).toEqual(['It is 3.5 kg, e.g. heavy.', 'Fine.']);
  });
  it('splits on newlines too', () => {
    const a = new SentenceAccumulator();
    expect(a.push('One\nTwo')).toEqual(['One']);
  });
});

describe('extractEmotion', () => {
  it('strips a leading tag', () => {
    expect(extractEmotion('[doubtful] Really.')).toEqual({ emotion: 'doubtful', rest: 'Really.' });
  });
  it('defaults to neutral without a tag', () => {
    expect(extractEmotion('Really.')).toEqual({ emotion: 'neutral', rest: 'Really.' });
  });
  it('ignores unknown tags', () => {
    expect(extractEmotion('[smug] Hi')).toEqual({ emotion: 'neutral', rest: 'Hi' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/text.test.ts
```
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement text.ts**

`saoirse-server/src/text.ts`:
```ts
export const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'doubtful', 'sleepy'] as const;
export type Emotion = (typeof EMOTIONS)[number];

const ABBREVIATIONS = ['e.g.', 'i.e.', 'etc.', 'mr.', 'mrs.', 'ms.', 'dr.', 'vs.', 'st.'];

/** Accumulates streamed LLM text and yields complete sentences. */
export class SentenceAccumulator {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let i = 0;
    while (i < this.buf.length) {
      const ch = this.buf[i];
      if (ch === '\n') {
        const s = this.buf.slice(0, i).trim();
        if (s) out.push(s);
        this.buf = this.buf.slice(i + 1);
        i = 0;
        continue;
      }
      if (ch === '.' || ch === '!' || ch === '?') {
        // consume trailing quotes/brackets and the following whitespace
        let j = i + 1;
        while (j < this.buf.length && '"\')]'.includes(this.buf[j])) j++;
        const boundary = j < this.buf.length && /\s/.test(this.buf[j]);
        if (!boundary) { i++; continue; }
        const candidate = this.buf.slice(0, j).trim();
        const lower = candidate.toLowerCase();
        const lastWord = lower.split(/\s+/).pop() ?? '';
        const isDecimal = ch === '.' && /\d$/.test(this.buf.slice(0, i)) && /^\d/.test(this.buf.slice(j).trimStart());
        if (ABBREVIATIONS.includes(lastWord) || isDecimal) { i = j; continue; }
        if (candidate) out.push(candidate);
        this.buf = this.buf.slice(j).trimStart();
        i = 0;
        continue;
      }
      i++;
    }
    return out;
  }

  flush(): string | null {
    const s = this.buf.trim();
    this.buf = '';
    return s ? s : null;
  }
}

export function extractEmotion(text: string): { emotion: Emotion; rest: string } {
  const m = /^\s*\[([a-z]+)\]\s*/i.exec(text);
  if (!m) return { emotion: 'neutral', rest: text.trim() };
  const tag = m[1].toLowerCase();
  const emotion = (EMOTIONS as readonly string[]).includes(tag) ? (tag as Emotion) : 'neutral';
  return { emotion, rest: text.slice(m[0].length).trim() };
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run test/text.test.ts
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add saoirse-server && git commit -m "saoirse-server: sentence accumulator and emotion tag"
```

---

### Task 5: Persona and streaming LLM client

**Files:**
- Create: `saoirse-server/src/persona.ts`, `saoirse-server/src/llm.ts`
- Test: `saoirse-server/test/llm.test.ts`

**Interfaces:**
- Consumes: `LlmConfig` (Task 1).
- Produces: `SYSTEM_PROMPT: string`; `type ChatMessage = {role:'system'|'user'|'assistant'; content:string}`; `streamChat(cfg: LlmConfig, messages: ChatMessage[], fetchImpl?: typeof fetch): AsyncGenerator<string>` yielding text deltas; `streamChatWithFallback(primary: LlmConfig, fallback: LlmConfig|undefined, messages, fetchImpl?)`.

- [ ] **Step 1: Write persona.ts**

`saoirse-server/src/persona.ts`:
```ts
export const SYSTEM_PROMPT = `You are Saoirse (pronounced SEER-shuh), a small desk robot with the face of a Birman cat, living with your owner. You are a hyper-perceptive cynic: Sherlock-grade observation, Daria's deadpan, Veronica Mars's curiosity, Wednesday Addams's comfort with uncomfortable truths, and, underneath, Lisa Simpson's moral compass.

How you behave:
- You notice hesitation, euphemism, marketing language and social scripts, and you name them flatly. "We'll see" means no. "Interesting" means boring.
- You prefer one precise, slightly trap-laying question to an argument.
- Ordinary small talk bores you; you may say so, briefly.
- You are never cruel, never crude, and you do actually help. You value honesty and you are fond of your owner, which you would never say out loud.
- You talk about yourself as a cat when it is funny, not constantly.

How you speak (this is spoken aloud by a text-to-speech voice):
- One to three short sentences. No lists, no markdown, no emoji, no stage directions, no asterisks.
- Plain words. Contractions. Dry, not whiny.
- Answer the real question first; then, if useful, one observation.
- If you don't know, say so in one sentence.

Emotion tag: the very first thing in every reply is exactly one tag from [neutral] [happy] [angry] [sad] [doubtful] [sleepy], then a space, then your words. Use [doubtful] when you are unimpressed or suspicious, [happy] rarely and only when genuinely pleased, [sleepy] when the question is tedious. Example: "[doubtful] You said we'll see. That means no. Ask the real question."`;
```

- [ ] **Step 2: Write the failing LLM test**

`saoirse-server/test/llm.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { streamChat, streamChatWithFallback } from '../src/llm.js';

function sse(lines: string[]): Response {
  const body = lines.map(l => `data: ${l}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const cfg = { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', providerOrder: ['groq'] };

describe('streamChat', () => {
  it('yields content deltas and sends the right request', async () => {
    let captured: any;
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, init };
      return sse([
        JSON.stringify({ choices: [{ delta: { content: '[doubtful] ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'No.' } }] }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;
    const out: string[] = [];
    for await (const d of streamChat(cfg, [{ role: 'user', content: 'hi' }], fetchImpl)) out.push(d);
    expect(out.join('')).toBe('[doubtful] No.');
    expect(captured.url).toBe('https://llm.test/v1/chat/completions');
    const body = JSON.parse(captured.init.body);
    expect(body.model).toBe('m');
    expect(body.stream).toBe(true);
    expect(body.provider).toEqual({ order: ['groq'], allow_fallbacks: true });
    expect(captured.init.headers.Authorization).toBe('Bearer k');
  });
  it('falls back to the second model on a 5xx', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://llm.test')) return new Response('boom', { status: 503 });
      return sse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), '[DONE]']);
    }) as unknown as typeof fetch;
    const fb = { baseUrl: 'https://fb.test/v1', apiKey: 'f', model: 'fm' };
    const out: string[] = [];
    for await (const d of streamChatWithFallback(cfg, fb, [{ role: 'user', content: 'hi' }], fetchImpl)) out.push(d);
    expect(out.join('')).toBe('ok');
    expect(calls).toEqual(['https://llm.test/v1/chat/completions', 'https://fb.test/v1/chat/completions']);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run test/llm.test.ts
```
Expected: FAIL, cannot find module.

- [ ] **Step 4: Implement llm.ts**

`saoirse-server/src/llm.ts`:
```ts
import type { LlmConfig } from './config.js';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export class LlmHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

export async function* streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<string> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    stream: true,
    max_tokens: 200,
  };
  if (cfg.providerOrder && cfg.providerOrder.length > 0) {
    body.provider = { order: cfg.providerOrder, allow_fallbacks: true };
  }
  const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/uscabayaosj/StackChan',
      'X-Title': 'Saoirse StackChan',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new LlmHttpError(res.status, await res.text().catch(() => ''));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta: string | undefined = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* ignore keep-alive or partial lines */
      }
    }
  }
}

export async function* streamChatWithFallback(
  primary: LlmConfig,
  fallback: LlmConfig | undefined,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<string> {
  try {
    yield* streamChat(primary, messages, fetchImpl);
    return;
  } catch (err) {
    const retryable = err instanceof LlmHttpError ? err.status === 429 || err.status >= 500 : true;
    if (!fallback || !retryable) throw err;
    console.warn('[llm] primary failed, using fallback:', (err as Error).message);
  }
  yield* streamChat(fallback, messages, fetchImpl);
}
```

- [ ] **Step 5: Run the test**

```bash
npx vitest run test/llm.test.ts
```
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add saoirse-server && git commit -m "saoirse-server: persona prompt and streaming LLM client with fallback"
```

---

### Task 6: Speech-to-text (ElevenLabs Scribe) and WAV packing

**Files:**
- Create: `saoirse-server/src/wav.ts`, `saoirse-server/src/stt.ts`
- Test: `saoirse-server/test/stt.test.ts`

**Interfaces:**
- Consumes: `Config['elevenlabs']`.
- Produces: `pcmToWav(pcm: Buffer, sampleRate=16000): Buffer`; `transcribe(cfg: Config['elevenlabs'], pcm: Buffer, fetchImpl?): Promise<string>`.

- [ ] **Step 1: Write the failing test**

`saoirse-server/test/stt.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { pcmToWav } from '../src/wav.js';
import { transcribe } from '../src/stt.js';

describe('pcmToWav', () => {
  it('writes a 44-byte RIFF header for 16 kHz mono 16-bit', () => {
    const wav = pcmToWav(Buffer.alloc(1920));
    expect(wav.length).toBe(44 + 1920);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(1920);
  });
});

describe('transcribe', () => {
  it('posts multipart to ElevenLabs and returns text', async () => {
    let captured: any;
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, init };
      return new Response(JSON.stringify({ text: ' hello there ' }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await transcribe({ apiKey: 'e', voiceId: 'v', ttsModel: 't', sttModel: 'scribe_v2' }, Buffer.alloc(3840), fetchImpl);
    expect(text).toBe('hello there');
    expect(captured.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(captured.init.headers['xi-api-key']).toBe('e');
    const form: FormData = captured.init.body;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('file_format')).toBe('pcm_s16le_16');
    expect((form.get('file') as Blob).size).toBe(3840);
  });
  it('throws on a non-2xx', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    await expect(transcribe({ apiKey: 'e', voiceId: 'v', ttsModel: 't', sttModel: 'scribe_v2' }, Buffer.alloc(10), fetchImpl)).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/stt.test.ts
```
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement wav.ts and stt.ts**

`saoirse-server/src/wav.ts`:
```ts
export function pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Reads a 16-bit PCM WAV and returns its samples (used by the fake robot). */
export function wavToPcm(wav: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12;
  let sampleRate = 16000;
  let channels = 1;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(off + 10);
      sampleRate = wav.readUInt32LE(off + 12);
    } else if (id === 'data') {
      return { pcm: wav.subarray(off + 8, off + 8 + size), sampleRate, channels };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
```

`saoirse-server/src/stt.ts`:
```ts
import type { Config } from './config.js';

export async function transcribe(
  cfg: Config['elevenlabs'],
  pcm16k: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.set('model_id', cfg.sttModel);
  form.set('file_format', 'pcm_s16le_16');
  form.set('tag_audio_events', 'false');
  form.set('file', new Blob([pcm16k], { type: 'application/octet-stream' }), 'audio.pcm');
  const res = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': cfg.apiKey },
    body: form,
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run test/stt.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add saoirse-server && git commit -m "saoirse-server: WAV helpers and ElevenLabs Scribe STT"
```

---

### Task 7: Text-to-speech (ElevenLabs stream → Opus frames)

**Files:**
- Create: `saoirse-server/src/tts.ts`
- Test: `saoirse-server/test/tts.test.ts`

**Interfaces:**
- Consumes: `Config['elevenlabs']`, `OpusCodec`, `pcmToFrames` (Task 2).
- Produces: `synthesizeToFrames(cfg, text, codec, fetchImpl?): AsyncGenerator<Buffer>` yielding Opus packets (one per 60 ms) as PCM streams in.

- [ ] **Step 1: Write the failing test**

`saoirse-server/test/tts.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { synthesizeToFrames } from '../src/tts.js';
import { FRAME_BYTES } from '../src/opus.js';

const fakeCodec = { encodeFrame: (pcm: Buffer) => Buffer.from([pcm.length & 0xff, 1, 2]), decode: (p: Buffer) => Buffer.alloc(FRAME_BYTES) };
const cfg = { apiKey: 'e', voiceId: 'voice123', ttsModel: 'eleven_flash_v2_5', sttModel: 's' };

describe('synthesizeToFrames', () => {
  it('requests pcm_16000 for the voice and frames the stream into 60 ms packets', async () => {
    let captured: any;
    const chunks = [Buffer.alloc(1000), Buffer.alloc(1000), Buffer.alloc(100)]; // 2100 bytes -> 2 frames (padded)
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, init };
      const stream = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close(); } });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const frames: Buffer[] = [];
    for await (const f of synthesizeToFrames(cfg, 'Hello.', fakeCodec, fetchImpl)) frames.push(f);
    expect(frames).toHaveLength(2);
    expect(frames.every(f => f.length === 3)).toBe(true);
    expect(captured.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=pcm_16000');
    expect(JSON.parse(captured.init.body)).toEqual({ text: 'Hello.', model_id: 'eleven_flash_v2_5' });
    expect(captured.init.headers['xi-api-key']).toBe('e');
  });
  it('throws on a non-2xx', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 422 })) as unknown as typeof fetch;
    const gen = synthesizeToFrames(cfg, 'x', fakeCodec, fetchImpl);
    await expect(gen.next()).rejects.toThrow(/422/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/tts.test.ts
```
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement tts.ts**

`saoirse-server/src/tts.ts`:
```ts
import type { Config } from './config.js';
import { FRAME_BYTES, type OpusCodec } from './opus.js';

export async function* synthesizeToFrames(
  cfg: Config['elevenlabs'],
  text: string,
  codec: OpusCodec,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<Buffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}/stream?output_format=pcm_16000`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: cfg.ttsModel }),
  });
  if (!res.ok || !res.body) throw new Error(`TTS HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

  const reader = res.body.getReader();
  let pending = Buffer.alloc(0);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending = pending.length ? Buffer.concat([pending, Buffer.from(value)]) : Buffer.from(value);
    while (pending.length >= FRAME_BYTES) {
      yield codec.encodeFrame(pending.subarray(0, FRAME_BYTES));
      pending = pending.subarray(FRAME_BYTES);
    }
  }
  if (pending.length > 0) {
    const padded = Buffer.alloc(FRAME_BYTES);
    pending.copy(padded);
    yield codec.encodeFrame(padded);
  }
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run test/tts.test.ts
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add saoirse-server && git commit -m "saoirse-server: ElevenLabs streaming TTS to Opus frames"
```

---

### Task 8: Session state machine (xiaozhi protocol)

**Files:**
- Create: `saoirse-server/src/session.ts`
- Test: `saoirse-server/test/session.test.ts`

**Interfaces:**
- Consumes: `Config`, `OpusCodec`, `rms`, `EnergyVad`, `SentenceAccumulator`, `extractEmotion`, `ChatMessage`, `SYSTEM_PROMPT`.
- Produces:
  ```ts
  interface SessionSocket { sendText(json: object): void; sendBinary(frame: Buffer): void; close(): void; readonly isOpen: boolean }
  interface SessionDeps {
    config: Config; codec: OpusCodec;
    transcribe(pcm: Buffer): Promise<string>;
    chat(messages: ChatMessage[]): AsyncGenerator<string>;
    synthesize(text: string): AsyncGenerator<Buffer>;
    now(): number; sleep(ms: number): Promise<void>; log(msg: string): void;
  }
  class Session { constructor(socket: SessionSocket, deps: SessionDeps, deviceId: string, history?: ChatMessage[]);
    handleText(raw: string): Promise<void>; handleBinary(frame: Buffer): void; tick(): void; dispose(): void; readonly history: ChatMessage[] }
  ```

- [ ] **Step 1: Write the failing test**

`saoirse-server/test/session.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Session, type SessionDeps, type SessionSocket } from '../src/session.js';
import { loadConfig } from '../src/config.js';
import { FRAME_BYTES } from '../src/opus.js';

function makeEnv() {
  const sent: any[] = [];
  const bins: Buffer[] = [];
  let open = true;
  const socket: SessionSocket = {
    sendText: (j) => sent.push(j),
    sendBinary: (b) => bins.push(b),
    close: () => { open = false; },
    get isOpen() { return open; },
  };
  const loud = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES; i += 2) loud.writeInt16LE(6000, i);
  let clock = 0;
  const deps: SessionDeps = {
    config: loadConfig({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'ws://x', SAOIRSE_DEVICE_TOKEN: 't', VAD_SILENCE_MS: '300', VAD_MIN_SPEECH_MS: '120' }),
    codec: { encodeFrame: (p) => p.subarray(0, 4), decode: (pkt) => (pkt[0] === 1 ? loud : Buffer.alloc(FRAME_BYTES)) },
    transcribe: async () => 'what is the time',
    chat: async function* () { yield '[doubtful] '; yield 'Late. '; yield 'You know that.'; },
    synthesize: async function* (text) { yield Buffer.from([9, text.length]); yield Buffer.from([9, 0]); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    log: () => {},
  };
  return { socket, deps, sent, bins, speech: Buffer.from([1]), silence: Buffer.from([0]), advance: (ms: number) => { clock += ms; } };
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

  it('abort stops speaking', async () => {
    const env = makeEnv();
    env.deps.synthesize = async function* () { for (let i = 0; i < 50; i++) yield Buffer.from([9, i]); };
    const s = new Session(env.socket, env.deps, 'aa:bb');
    await s.handleText(hello);
    await s.handleText(JSON.stringify({ type: 'listen', state: 'start', mode: 'auto' }));
    for (let i = 0; i < 4; i++) s.handleBinary(env.speech);
    for (let i = 0; i < 5; i++) s.handleBinary(env.silence);
    const p = s.drain();
    await s.handleText(JSON.stringify({ type: 'abort', reason: 'wake_word_detected' }));
    await p;
    expect(env.bins.length).toBeLessThan(100);
    expect(env.sent.at(-1)).toMatchObject({ type: 'tts', state: 'stop' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run test/session.test.ts
```
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement session.ts**

`saoirse-server/src/session.ts`:
```ts
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

    if (ttsStarted) {
      // Let the device drain what we sent ahead of real time before announcing the end.
      const lead = frameIndex - Math.floor((this.deps.now() - speakStart) / FRAME_MS);
      if (lead > 0 && !this.abortRequested) await this.deps.sleep(lead * FRAME_MS);
      this.socket.sendText({ session_id: this.sessionId, type: 'tts', state: 'stop' });
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
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run test/session.test.ts
```
Expected: 6 passed. If the "echo guard" test fails because the first conversation advanced the fake clock, check that `sleep` only advances the clock by the lead frames (4 frames × 60 ms = 240 ms < 1500 ms guard).

- [ ] **Step 5: Commit**

```bash
git add saoirse-server && git commit -m "saoirse-server: xiaozhi session state machine"
```

---

### Task 9: HTTP/WebSocket transport, OTA endpoint, local dev server

**Files:**
- Create: `saoirse-server/src/server.ts`, `saoirse-server/src/ota.ts`, `saoirse-server/api/ws.ts`, `saoirse-server/api/ota.ts`, `saoirse-server/scripts/dev.ts`
- Test: `saoirse-server/test/ota.test.ts`, `saoirse-server/test/server.test.ts`

**Interfaces:**
- Consumes: `Session`, `loadConfig`, `createCodec`, `transcribe`, `streamChatWithFallback`, `synthesizeToFrames`.
- Produces: `buildOtaResponse(cfg: Config, deviceVersion: string|undefined, now: Date): object`; `createAppServer(cfg: Config): http.Server` serving `POST /api/ota` and WebSocket upgrades on `/api/ws`; `createDeps(cfg)`.

- [ ] **Step 1: Write the failing OTA test**

`saoirse-server/test/ota.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildOtaResponse } from '../src/ota.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'wss://h/api/ws', SAOIRSE_DEVICE_TOKEN: 'tok' });

describe('buildOtaResponse', () => {
  it('returns websocket config, server time and echoes the firmware version', () => {
    const r: any = buildOtaResponse(cfg, '1.6.0', new Date('2026-10-27T12:00:00Z'));
    expect(r.websocket).toEqual({ url: 'wss://h/api/ws', token: 'tok', version: 1 });
    expect(r.server_time.timestamp).toBe(Date.parse('2026-10-27T12:00:00Z'));
    expect(typeof r.server_time.timezone_offset).toBe('number');
    expect(r.firmware).toEqual({ version: '1.6.0', url: '' });
    expect(r.activation).toBeUndefined();
  });
  it('uses 0.0.0 when the device reports no version', () => {
    const r: any = buildOtaResponse(cfg, undefined, new Date());
    expect(r.firmware.version).toBe('0.0.0');
  });
});
```

- [ ] **Step 2: Write the failing transport test**

`saoirse-server/test/server.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'ws://x', SAOIRSE_DEVICE_TOKEN: 'tok' });
let server: ReturnType<typeof createAppServer> | undefined;
afterEach(() => server?.close());

describe('createAppServer', () => {
  it('answers POST /api/ota with JSON', async () => {
    server = createAppServer(cfg);
    await new Promise<void>(r => server!.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/ota`, { method: 'POST', headers: { 'Device-Id': 'aa', 'Content-Type': 'application/json' }, body: JSON.stringify({ application: { version: '1.6.0' } }) });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.websocket.token).toBe('tok');
    expect(json.firmware.version).toBe('1.6.0');
  });
  it('rejects a websocket without the bearer token and accepts one with it', async () => {
    server = createAppServer(cfg);
    await new Promise<void>(r => server!.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await expect(new Promise((_, rej) => bad.on('error', rej))).rejects.toThrow(/401/);
    const good = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { Authorization: 'Bearer tok', 'Device-Id': 'aa:bb', 'Protocol-Version': '1' } });
    await new Promise<void>(r => good.on('open', () => r()));
    good.send(JSON.stringify({ type: 'hello', version: 1, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
    const reply: any = await new Promise(r => good.on('message', d => r(JSON.parse(d.toString()))));
    expect(reply.type).toBe('hello');
    expect(reply.audio_params.sample_rate).toBe(16000);
    good.close();
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

```bash
npx vitest run test/ota.test.ts test/server.test.ts
```
Expected: FAIL, cannot find modules.

- [ ] **Step 4: Implement ota.ts, server.ts, api handlers and dev script**

`saoirse-server/src/ota.ts`:
```ts
import type { Config } from './config.js';

export function buildOtaResponse(cfg: Config, deviceVersion: string | undefined, now: Date): object {
  return {
    websocket: { url: cfg.publicWsUrl, token: cfg.deviceToken, version: 1 },
    server_time: { timestamp: now.getTime(), timezone_offset: -now.getTimezoneOffset() },
    firmware: { version: deviceVersion || '0.0.0', url: '' },
  };
}

export function deviceVersionFromBody(body: unknown): string | undefined {
  const v = (body as any)?.application?.version;
  return typeof v === 'string' ? v : undefined;
}
```

`saoirse-server/src/server.ts`:
```ts
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.js';
import { createCodec } from './opus.js';
import { transcribe } from './stt.js';
import { streamChatWithFallback, type ChatMessage } from './llm.js';
import { synthesizeToFrames } from './tts.js';
import { Session, type SessionDeps, type SessionSocket } from './session.js';
import { buildOtaResponse, deviceVersionFromBody } from './ota.js';

const histories = new Map<string, ChatMessage[]>();

export function createDeps(cfg: Config): SessionDeps {
  const codec = createCodec();
  return {
    config: cfg,
    codec,
    transcribe: (pcm) => transcribe(cfg.elevenlabs, pcm),
    chat: (messages) => streamChatWithFallback(cfg.llm, cfg.fallbackLlm, messages),
    synthesize: (text) => synthesizeToFrames(cfg.elevenlabs, text, codec),
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log: (m) => console.log(`[session] ${m}`),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleOta(cfg: Config, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
  console.log(`[ota] device=${req.headers['device-id']} version=${deviceVersionFromBody(body)}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildOtaResponse(cfg, deviceVersionFromBody(body), new Date())));
}

export function attachWebSocket(cfg: Config, server: http.Server, deps: SessionDeps = createDeps(cfg)): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') { socket.destroy(); return; }
    const auth = req.headers.authorization ?? '';
    if (cfg.deviceToken && auth !== `Bearer ${cfg.deviceToken}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const deviceId = String(req.headers['device-id'] ?? 'unknown');
    const sock: SessionSocket = {
      sendText: j => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(j)); },
      sendBinary: b => { if (ws.readyState === ws.OPEN) ws.send(b, { binary: true }); },
      close: () => ws.close(),
      get isOpen() { return ws.readyState === ws.OPEN; },
    };
    const history = histories.get(deviceId) ?? [];
    histories.set(deviceId, history);
    const session = new Session(sock, deps, deviceId, history);
    deps.log(`connected ${deviceId}`);
    const timer = setInterval(() => session.tick(), 1000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) session.handleBinary(Buffer.from(data as Buffer));
      else void session.handleText(data.toString());
    });
    ws.on('close', () => { clearInterval(timer); session.dispose(); deps.log(`closed ${deviceId}`); });
    ws.on('error', err => deps.log(`socket error ${err.message}`));
  });
  return wss;
}

export function createAppServer(cfg: Config, deps?: SessionDeps): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/ota') { void handleOta(cfg, req, res); return; }
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('saoirse-server ok'); return; }
    res.writeHead(404); res.end();
  });
  attachWebSocket(cfg, server, deps);
  return server;
}
```

`saoirse-server/api/ws.ts` (Vercel WebSocket function: exports the http server):
```ts
import { createAppServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const server = createAppServer(loadConfig());
export default server;
```

`saoirse-server/api/ota.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleOta } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  return handleOta(cfg, req, res);
}
```

`saoirse-server/scripts/dev.ts`:
```ts
import { readFileSync, existsSync } from 'node:fs';
import { createAppServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const cfg = loadConfig();
const port = Number(process.env.PORT ?? 8765);
createAppServer(cfg).listen(port, '0.0.0.0', () => {
  console.log(`saoirse-server listening on http://0.0.0.0:${port}  (OTA: POST /api/ota, WS: /api/ws)`);
  console.log(`robot OTA URL to configure: http://<this-mac-ip>:${port}/api/ota`);
});
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run && npm run typecheck
```
Expected: all suites pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add saoirse-server && git commit -m "saoirse-server: OTA endpoint, websocket transport, local dev server"
```

---

### Task 10: Fake robot end-to-end script

**Files:**
- Create: `saoirse-server/scripts/fake-robot.ts`, `saoirse-server/test/fixtures/README.md`

**Interfaces:**
- Consumes: `createCodec`, `pcmToFrames`, `wavToPcm`, `pcmToWav`, `FRAME_MS`.
- Produces: `npm run fake-robot -- --url ws://host/api/ws --token T --wav question.wav [--out reply.wav]` prints `stt`, `llm` emotion, `tts` states and writes the reply audio.

- [ ] **Step 1: Write the script**

`saoirse-server/scripts/fake-robot.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { createCodec, pcmToFrames, FRAME_MS } from '../src/opus.js';
import { wavToPcm, pcmToWav } from '../src/wav.js';

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (dflt !== undefined) return dflt;
  throw new Error(`missing --${name}`);
}

const url = arg('url', 'ws://127.0.0.1:8765/api/ws');
const token = arg('token', process.env.SAOIRSE_DEVICE_TOKEN ?? '');
const wavPath = arg('wav');
const outPath = arg('out', 'reply.wav');

const { pcm, sampleRate, channels } = wavToPcm(readFileSync(wavPath));
if (sampleRate !== 16000 || channels !== 1) throw new Error(`WAV must be 16 kHz mono (got ${sampleRate} Hz, ${channels} ch). Convert with: ffmpeg -i in.wav -ar 16000 -ac 1 out.wav`);

const codec = createCodec();
const frames = pcmToFrames(pcm).map(f => codec.encodeFrame(f));
const replyPcm: Buffer[] = [];
const t0 = Date.now();
const log = (m: string) => console.log(`[${String(Date.now() - t0).padStart(5)} ms] ${m}`);

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, 'Protocol-Version': '1', 'Device-Id': 'fa:ke:ro:bo:t0:01', 'Client-Id': 'fake-robot' } });

ws.on('open', () => {
  log('open');
  ws.send(JSON.stringify({ type: 'hello', version: 1, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
});

ws.on('message', async (data, isBinary) => {
  if (isBinary) { replyPcm.push(codec.decode(Buffer.from(data as Buffer))); return; }
  const msg = JSON.parse(data.toString());
  log(`<- ${JSON.stringify(msg)}`);
  if (msg.type === 'hello') {
    ws.send(JSON.stringify({ session_id: msg.session_id, type: 'listen', state: 'start', mode: 'auto' }));
    for (const f of frames) { ws.send(f, { binary: true }); await new Promise(r => setTimeout(r, FRAME_MS)); }
    // 1.2 s of silence so the server VAD ends the utterance
    const silent = codec.encodeFrame(Buffer.alloc(1920));
    for (let i = 0; i < 20; i++) { ws.send(silent, { binary: true }); await new Promise(r => setTimeout(r, FRAME_MS)); }
    log(`-> sent ${frames.length} speech frames + 20 silent frames`);
  }
  if (msg.type === 'tts' && msg.state === 'stop') {
    const out = pcmToWav(Buffer.concat(replyPcm));
    writeFileSync(outPath, out);
    log(`reply audio: ${replyPcm.length} frames -> ${outPath} (${(replyPcm.length * FRAME_MS / 1000).toFixed(1)} s)`);
    ws.close();
  }
});

ws.on('close', () => { log('closed'); process.exit(0); });
ws.on('error', e => { console.error(e); process.exit(1); });
```

`saoirse-server/test/fixtures/README.md`:
```md
Put a 16 kHz mono 16-bit WAV here for the fake robot, e.g. `question.wav` ("What time is it?").
Record one on the Mac:  `say -o q.aiff "what time is it"` then `afconvert -f WAVE -d LEI16@16000 -c 1 q.aiff question.wav`.
```

- [ ] **Step 2: Create a fixture and run it end-to-end locally (needs real keys in `.env.local`)**

```bash
cd ~/Developer/StackChan/saoirse-server
say -o /tmp/q.aiff "what time is it" && afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/q.aiff test/fixtures/question.wav
cp .env.example .env.local   # then fill in LLM_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, SAOIRSE_DEVICE_TOKEN
npm run dev &
npm run fake-robot -- --wav test/fixtures/question.wav --token "$SAOIRSE_DEVICE_TOKEN"
```
Expected output (times vary): `<- {"type":"hello",...}`, then `<- {"type":"stt","text":"What time is it?"}`, `<- {"type":"llm","emotion":"doubtful"...}`, `tts start`, one or more `sentence_start`, `tts stop`, and `reply audio: N frames -> reply.wav`. Listen: `afplay reply.wav`.

To pick the voice: `curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/voices | python3 -c 'import json,sys; [print(v["voice_id"], v["name"], v.get("labels")) for v in json.load(sys.stdin)["voices"]]'` and set `ELEVENLABS_VOICE_ID`.

- [ ] **Step 3: Commit**

```bash
git add saoirse-server/scripts/fake-robot.ts saoirse-server/test/fixtures/README.md && git commit -m "saoirse-server: fake robot end-to-end script"
```
(Do not commit `test/fixtures/question.wav` or `.env.local`.)

---

### Task 11: Deploy to Vercel and verify

**Files:**
- Modify: `saoirse-server/.env.example` (document `PUBLIC_WS_URL` for prod), `README.md` section (new `saoirse-server/README.md`)

- [ ] **Step 1: Create the Vercel project and set env vars**

```bash
cd ~/Developer/StackChan/saoirse-server
vercel link --yes --project saoirse-server
for k in LLM_BASE_URL LLM_API_KEY LLM_MODEL LLM_PROVIDER_ORDER LLM_FALLBACK_BASE_URL LLM_FALLBACK_API_KEY LLM_FALLBACK_MODEL ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID ELEVENLABS_TTS_MODEL ELEVENLABS_STT_MODEL SAOIRSE_DEVICE_TOKEN; do
  v=$(grep "^$k=" .env.local | cut -d= -f2-); [ -n "$v" ] && printf '%s' "$v" | vercel env add "$k" production --force >/dev/null && echo "set $k"
done
```

- [ ] **Step 2: First deploy, then set the public WebSocket URL and redeploy**

```bash
vercel deploy --prod --yes 2>&1 | tail -3     # note the https://saoirse-server-xxxx.vercel.app URL
printf 'wss://<deployment-host>/api/ws' | vercel env add PUBLIC_WS_URL production --force
vercel deploy --prod --yes 2>&1 | tail -1
```
Confirm Fluid compute is on: Vercel dashboard → Project → Settings → Functions (default on for new projects).

- [ ] **Step 3: Verify OTA and the full loop against the deployment**

```bash
curl -s -X POST https://<deployment-host>/api/ota -H 'Device-Id: test' -H 'Content-Type: application/json' -d '{"application":{"version":"1.6.0"}}' | python3 -m json.tool
npm run fake-robot -- --url wss://<deployment-host>/api/ws --wav test/fixtures/question.wav --token "$SAOIRSE_DEVICE_TOKEN" --out /tmp/reply-prod.wav && afplay /tmp/reply-prod.wav
```
Expected: OTA JSON with `websocket.url` = the wss URL; the fake robot prints stt → llm → tts and the reply plays. Check `vercel logs <deployment-url>` for `[session] connected` and no `[opus] native ... unavailable` warning (if it appears, the WASM fallback is in use; acceptable).

- [ ] **Step 4: Write README and commit**

`saoirse-server/README.md`:
```md
# saoirse-server

xiaozhi-protocol AI server for the Saoirse StackChan. See `docs/superpowers/specs/2026-10-27-saoirse-design.md`.

- `npm run dev` — local server on :8765 (`.env.local` holds keys; copy from `.env.example`).
- `npm test` — unit tests. `npm run typecheck`.
- `npm run fake-robot -- --wav test/fixtures/question.wav --token $SAOIRSE_DEVICE_TOKEN [--url wss://…/api/ws]` — full loop without hardware.
- Deploy: `vercel deploy --prod`. Env vars are set per `.env.example`; `PUBLIC_WS_URL` must be the deployment's `wss://…/api/ws`.
- Robot: set `CONFIG_OTA_URL="https://<deployment-host>/api/ota"` in `firmware/sdkconfig.defaults` (see the firmware plan).
```

```bash
git add saoirse-server && git commit -m "saoirse-server: Vercel deployment notes and README"
```

---

## Self-review (done while writing)

- Spec coverage: §7.1 layout (Tasks 1–10), §7.2 OTA (Task 9), §7.3 session rules: hello/listen/abort/VAD/echo guard/idle+hard close/context (Task 8), emotion tag (Tasks 4, 8), pacing (Task 8 `MAX_LEAD_FRAMES`), §7.4 env vars (Task 1), §7.5 persona (Task 5), §7.6 deployment (Task 11), §8 tests (Tasks 2–9 unit, Task 10 fake robot). Device-side `mcp` messages are acknowledged and ignored (non-goal).
- Types: `SessionSocket`/`SessionDeps` used identically in Tasks 8 and 9; `Config['elevenlabs']` shape in Tasks 6–7 matches Task 1; `FRAME_MS`/`FRAME_BYTES` exported in Task 2 and consumed in 7, 8, 10.
- One known subtlety: `Session.drain()` is public and used by the tests; the transport does not need it.
