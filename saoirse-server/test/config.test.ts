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
    expect(c.llm.maxTokens).toBe(400);
    expect(c.llm.reasoningEffort).toBe('low');
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
    expect(c.fallbackLlm?.maxTokens).toBe(400);
    expect(c.fallbackLlm?.reasoningEffort).toBe('low');
  });
  it('overrides max tokens and reasoning effort for primary and fallback', () => {
    const c = loadConfig({
      ...base,
      LLM_MAX_TOKENS: '600',
      LLM_REASONING_EFFORT: 'high',
      LLM_FALLBACK_API_KEY: 'd',
      LLM_FALLBACK_MAX_TOKENS: '250',
      LLM_FALLBACK_REASONING_EFFORT: 'none',
    });
    expect(c.llm.maxTokens).toBe(600);
    expect(c.llm.reasoningEffort).toBe('high');
    expect(c.fallbackLlm?.maxTokens).toBe(250);
    expect(c.fallbackLlm?.reasoningEffort).toBe('none');
  });
  it('throws on a missing required key', () => {
    expect(() => loadConfig({ ...base, ELEVENLABS_API_KEY: '' })).toThrow(/ELEVENLABS_API_KEY/);
  });
});
