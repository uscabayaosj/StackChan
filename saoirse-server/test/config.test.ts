import { describe, it, expect } from 'vitest';
import { loadConfig, deriveVisionUrl, DEFAULT_DEVICE_TOOLS } from '../src/config.js';

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
    expect(c.vad.silenceMs).toBe(1200);
    expect(c.echoGuardMs).toBe(250);
    expect(c.wakeGuardMs).toBe(800);
    expect(c.deviceTools).toEqual(DEFAULT_DEVICE_TOOLS);
    expect(c.vision.model).toBe('google/gemini-3.5-flash-lite');
    expect(c.vision.apiKey).toBe(c.llm.apiKey);
    expect(c.vision.baseUrl).toBe(c.llm.baseUrl);
    expect(c.vision.timeoutMs).toBe(15000);
    expect(c.vision.maxBytes).toBe(3 * 1024 * 1024);
    expect(c.toolTimeoutMs).toEqual({ camera: 25000, other: 8000 });
    expect(c.idleCloseMs).toBe(60000);
    expect(c.fallbackLlm).toBeUndefined();
  });
  it('reads the fallback LLM only when its key is set', () => {
    const c = loadConfig({ ...base, LLM_FALLBACK_API_KEY: 'd' });
    expect(c.fallbackLlm?.model).toBe('deepseek-flash');
    expect(c.fallbackLlm?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(c.fallbackLlm?.maxTokens).toBe(400);
    expect(c.fallbackLlm?.reasoningEffort).toBe('none');
  });
  it('lets the fallback reasoning effort be overridden to low', () => {
    const c = loadConfig({ ...base, LLM_FALLBACK_API_KEY: 'd', LLM_FALLBACK_REASONING_EFFORT: 'low' });
    expect(c.fallbackLlm?.reasoningEffort).toBe('low');
  });
  it('overrides max tokens and reasoning effort for primary and fallback', () => {
    const c = loadConfig({
      ...base,
      LLM_MAX_TOKENS: '600',
      LLM_REASONING_EFFORT: 'high',
      LLM_FALLBACK_API_KEY: 'd',
      LLM_FALLBACK_MAX_TOKENS: '250',
      LLM_FALLBACK_REASONING_EFFORT: 'medium',
    });
    expect(c.llm.maxTokens).toBe(600);
    expect(c.llm.reasoningEffort).toBe('high');
    expect(c.fallbackLlm?.maxTokens).toBe(250);
    expect(c.fallbackLlm?.reasoningEffort).toBe('medium');
  });
  it('throws on a non-numeric number setting', () => {
    expect(() => loadConfig({ ...base, LLM_MAX_TOKENS: 'abc' })).toThrow(/LLM_MAX_TOKENS/);
    expect(() => loadConfig({ ...base, VAD_SILENCE_MS: 'Infinity' })).toThrow(/VAD_SILENCE_MS/);
  });
  it('defaults the per-stage timeouts and the device time zone, and reads overrides', () => {
    const c = loadConfig(base);
    expect(c.sttTimeoutMs).toBe(10_000);
    expect(c.llmTimeoutMs).toBe(15_000);
    expect(c.ttsTimeoutMs).toBe(10_000);
    expect(c.deviceTz).toBe('UTC');
    const o = loadConfig({ ...base, STT_TIMEOUT_MS: '1', LLM_TIMEOUT_MS: '2', TTS_TIMEOUT_MS: '3', DEVICE_TZ: 'Asia/Manila' });
    expect([o.sttTimeoutMs, o.llmTimeoutMs, o.ttsTimeoutMs, o.deviceTz]).toEqual([1, 2, 3, 'Asia/Manila']);
  });
  it('throws on an unknown DEVICE_TZ', () => {
    expect(() => loadConfig({ ...base, DEVICE_TZ: 'Mars/Olympus' })).toThrow(/DEVICE_TZ/);
  });
  it('requires SAOIRSE_DEVICE_TOKEN and OTA_SECRET on Vercel', () => {
    expect(() => loadConfig({ ...base, VERCEL: '1', SAOIRSE_DEVICE_TOKEN: '', OTA_SECRET: 's' })).toThrow(/SAOIRSE_DEVICE_TOKEN/);
    expect(() => loadConfig({ ...base, VERCEL: '1' })).toThrow(/OTA_SECRET/);
    const c = loadConfig({ ...base, VERCEL: '1', OTA_SECRET: 's' });
    expect(c.deviceToken).toBe('t');
    expect(c.otaSecret).toBe('s');
  });
  it('allows an empty OTA secret locally (check off)', () => {
    expect(loadConfig(base).otaSecret).toBe('');
  });
  it('allows an empty device token locally (auth off)', () => {
    expect(loadConfig({ ...base, SAOIRSE_DEVICE_TOKEN: '' }).deviceToken).toBe('');
  });
  it('throws on a missing required key', () => {
    expect(() => loadConfig({ ...base, ELEVENLABS_API_KEY: '' })).toThrow(/ELEVENLABS_API_KEY/);
  });
});

describe('vision url and tools', () => {
  it('derives the vision upload url from the public ws url', () => {
    expect(deriveVisionUrl('wss://saoirse.example/api/ws')).toBe('https://saoirse.example/api/vision');
    expect(deriveVisionUrl('ws://192.168.1.10:8765/api/ws')).toBe('http://192.168.1.10:8765/api/vision');
    expect(deriveVisionUrl('wss://h.example/')).toBe('https://h.example/api/vision');
  });
  it('PUBLIC_VISION_URL, VISION_* and DEVICE_TOOLS override the defaults', () => {
    const base = { LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'wss://h/api/ws', SAOIRSE_DEVICE_TOKEN: 't' };
    const c = loadConfig({ ...base, PUBLIC_VISION_URL: 'https://other/v', VISION_MODEL: 'x/y', VISION_API_KEY: 'vk', DEVICE_TOOLS: 'self.camera.take_photo, self.reboot' });
    expect(c.publicVisionUrl).toBe('https://other/v');
    expect(c.vision.model).toBe('x/y');
    expect(c.vision.apiKey).toBe('vk');
    expect(c.deviceTools).toEqual(['self.camera.take_photo', 'self.reboot']);
    expect(loadConfig(base).publicVisionUrl).toBe('https://h/api/vision');
  });
});
