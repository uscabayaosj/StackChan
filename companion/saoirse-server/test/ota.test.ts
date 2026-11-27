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
  it('reports the DEVICE_TZ offset in minutes, not the server zone', () => {
    const manila = loadConfig({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'wss://h/api/ws', DEVICE_TZ: 'Asia/Manila' });
    expect((buildOtaResponse(manila, '1', new Date('2026-10-27T12:00:00Z')) as any).server_time.timezone_offset).toBe(480);
    const ny = { ...manila, deviceTz: 'America/New_York' };
    expect((buildOtaResponse(ny, '1', new Date('2026-01-15T12:00:00Z')) as any).server_time.timezone_offset).toBe(-300);
    expect((buildOtaResponse(cfg, '1', new Date('2026-01-15T12:00:00Z')) as any).server_time.timezone_offset).toBe(0);
  });
});
