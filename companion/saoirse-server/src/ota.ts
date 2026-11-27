import type { Config } from './config.js';
import { timezoneOffsetMinutes } from './clock.js';

export function buildOtaResponse(cfg: Config, deviceVersion: string | undefined, now: Date): object {
  return {
    websocket: { url: cfg.publicWsUrl, token: cfg.deviceToken, version: 1 },
    server_time: { timestamp: now.getTime(), timezone_offset: timezoneOffsetMinutes(cfg.deviceTz, now) },
    firmware: { version: deviceVersion || '0.0.0', url: '' },
  };
}

export function deviceVersionFromBody(body: unknown): string | undefined {
  const v = (body as any)?.application?.version;
  return typeof v === 'string' ? v : undefined;
}
