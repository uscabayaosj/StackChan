import { assertTimeZone } from './clock.js';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerOrder?: string[];
  maxTokens: number;
  /** 'none' means do not send the reasoning field at all. */
  reasoningEffort?: ReasoningEffort;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'none';

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
  /** Ignore microphone audio this long after a `listen start` that follows a wake word: the robot plays its popup chime then. */
  wakeGuardMs: number;
  contextTurns: number;
  /** Per-call deadlines: STT request, the whole LLM stream, and each TTS sentence. */
  sttTimeoutMs: number;
  llmTimeoutMs: number;
  ttsTimeoutMs: number;
  /** IANA time zone of the robot (e.g. Asia/Manila): OTA clock offset and the prompt's local time. */
  deviceTz: string;
  /** Robot MCP tools offered to the LLM (names as the robot advertises them). */
  deviceTools: string[];
  /** Where the robot uploads photos (`/api/vision`); derived from PUBLIC_WS_URL unless PUBLIC_VISION_URL is set. */
  publicVisionUrl: string;
  vision: { baseUrl: string; apiKey: string; model: string; timeoutMs: number; maxBytes: number };
  /** Deadlines for a robot tool call: the camera (capture + upload + vision model) and everything else. */
  toolTimeoutMs: { camera: number; other: number };
}

export const DEFAULT_DEVICE_TOOLS = ['self.camera.take_photo', 'self.robot.set_head_angles', 'self.robot.get_head_angles', 'self.robot.set_led_color'];

/** `wss://host/api/ws` -> `https://host/api/vision` (ws -> http for local runs). */
export function deriveVisionUrl(publicWsUrl: string): string {
  const u = new URL(publicWsUrl);
  u.protocol = u.protocol === 'ws:' ? 'http:' : 'https:';
  u.pathname = u.pathname.replace(/\/api\/ws\/?$/, '/api/vision');
  if (!u.pathname.endsWith('/api/vision')) u.pathname = '/api/vision';
  u.search = '';
  return u.toString();
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required environment variable ${key}`);
  return v;
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${key}: ${v} (expected a number)`);
  return n;
}

function effort(env: NodeJS.ProcessEnv, key: string, dflt: ReasoningEffort): ReasoningEffort {
  const v = (env[key] ?? '').trim().toLowerCase();
  if (v === '') return dflt;
  if (v === 'low' || v === 'medium' || v === 'high' || v === 'none') return v;
  throw new Error(`Invalid ${key}: ${v} (expected low, medium, high or none)`);
}

function timeZone(env: NodeJS.ProcessEnv, key: string, dflt: string): string {
  const v = (env[key] ?? '').trim() || dflt;
  try { assertTimeZone(v); } catch { throw new Error(`Invalid ${key}: ${v} (expected an IANA time zone such as Asia/Manila)`); }
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fallbackKey = env.LLM_FALLBACK_API_KEY;
  const deviceToken = env.SAOIRSE_DEVICE_TOKEN || '';
  // Locally an empty token means "auth off"; a public deployment must never run open.
  if (env.VERCEL && !deviceToken) throw new Error('SAOIRSE_DEVICE_TOKEN must be set on Vercel (an empty token would leave /api/ws open)');
  return {
    llm: {
      baseUrl: env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: req(env, 'LLM_API_KEY'),
      model: env.LLM_MODEL || 'openai/gpt-oss-20b',
      providerOrder: (env.LLM_PROVIDER_ORDER ?? 'groq').split(',').map(s => s.trim()).filter(Boolean),
      maxTokens: num(env, 'LLM_MAX_TOKENS', 400),
      reasoningEffort: effort(env, 'LLM_REASONING_EFFORT', 'low'),
    },
    fallbackLlm: fallbackKey
      ? {
          baseUrl: env.LLM_FALLBACK_BASE_URL || 'https://api.deepseek.com/v1',
          apiKey: fallbackKey,
          model: env.LLM_FALLBACK_MODEL || 'deepseek-flash',
          maxTokens: num(env, 'LLM_FALLBACK_MAX_TOKENS', 400),
          reasoningEffort: effort(env, 'LLM_FALLBACK_REASONING_EFFORT', 'none'),
        }
      : undefined,
    elevenlabs: {
      apiKey: req(env, 'ELEVENLABS_API_KEY'),
      voiceId: req(env, 'ELEVENLABS_VOICE_ID'),
      ttsModel: env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5',
      sttModel: env.ELEVENLABS_STT_MODEL || 'scribe_v2',
    },
    deviceToken,
    publicWsUrl: req(env, 'PUBLIC_WS_URL'),
    vad: {
      rmsThreshold: num(env, 'VAD_RMS_THRESHOLD', 0.025),
      silenceMs: num(env, 'VAD_SILENCE_MS', 1_200),
      minSpeechMs: num(env, 'VAD_MIN_SPEECH_MS', 300),
      preRollMs: num(env, 'VAD_PREROLL_MS', 300),
    },
    idleCloseMs: num(env, 'IDLE_CLOSE_MS', 60_000),
    hardCloseMs: num(env, 'HARD_CLOSE_MS', 280_000),
    echoGuardMs: num(env, 'ECHO_GUARD_MS', 250),
    wakeGuardMs: num(env, 'WAKE_GUARD_MS', 800),
    contextTurns: num(env, 'CONTEXT_TURNS', 10),
    sttTimeoutMs: num(env, 'STT_TIMEOUT_MS', 10_000),
    llmTimeoutMs: num(env, 'LLM_TIMEOUT_MS', 15_000),
    ttsTimeoutMs: num(env, 'TTS_TIMEOUT_MS', 10_000),
    deviceTz: timeZone(env, 'DEVICE_TZ', 'UTC'),
    deviceTools: (env.DEVICE_TOOLS ?? DEFAULT_DEVICE_TOOLS.join(',')).split(',').map(s => s.trim()).filter(Boolean),
    publicVisionUrl: env.PUBLIC_VISION_URL || deriveVisionUrl(req(env, 'PUBLIC_WS_URL')),
    vision: {
      baseUrl: env.VISION_BASE_URL || env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: env.VISION_API_KEY || req(env, 'LLM_API_KEY'),
      model: env.VISION_MODEL || 'google/gemini-3.5-flash-lite',
      timeoutMs: num(env, 'VISION_TIMEOUT_MS', 15_000),
      maxBytes: num(env, 'VISION_MAX_BYTES', 3 * 1024 * 1024),
    },
    toolTimeoutMs: { camera: num(env, 'TOOL_TIMEOUT_CAMERA_MS', 25_000), other: num(env, 'TOOL_TIMEOUT_MS', 8_000) },
  };
}
