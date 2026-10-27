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
  contextTurns: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fallbackKey = env.LLM_FALLBACK_API_KEY;
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
