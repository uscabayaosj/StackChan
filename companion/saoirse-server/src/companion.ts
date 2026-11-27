import type { DirectionsRoute } from './directions.js';
import { activeDirections, makeDirectionsHandoff, type DirectionsHandoff } from './directions_handoff.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

const loadBuiltin = createRequire(import.meta.url);
import { bearerMatches } from './auth.js';
import type { Config } from './config.js';

export type Profile = {
  name: string; backend: 'primary' | 'fallback'; model: string;
  voiceId: string; voiceModel: string; gain: number; persona: string;
};
export type Command = { action: string; yaw?: number; pitch?: number; value?: number };
export type ControlReadings = { volume?: number; brightness?: number };
export type RobotPresence = ControlReadings & { lastSeen: number | null; online: boolean };

export function controlReadings(req: IncomingMessage): ControlReadings {
  const readings: ControlReadings = {};
  for (const key of ['volume', 'brightness'] as const) {
    const value = req.headers[`x-saoirse-${key}`];
    if (typeof value === 'string' && /^(?:0|[1-9]\d?|100)$/.test(value)) readings[key] = Number(value);
  }
  return readings;
}

export function controlAcknowledgement(command: Command, readings: ControlReadings, lastSeen: number): RobotPresence | undefined {
  if ((command.action === 'volume' || command.action === 'brightness') && readings[command.action] !== undefined) {
    return { online: true, lastSeen, ...readings };
  }
}
type Pending = {
  id: string; command: Command; sent: boolean; reply: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
};

export const prefix = '/api/companion';
export const maxJpeg = 768 * 1024;

export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function send(res: ServerResponse, status: number, value?: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
  res.end(value === undefined ? undefined : JSON.stringify(value));
}

export async function read(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Leave the connection open long enough to report a bounded-body error.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); throw new RequestError(413, 'Request is too large.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = (await read(req, 24 * 1024)).toString('utf8');
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* handled below */ }
  throw new RequestError(400, 'Expected a JSON object.');
}

function boundedString(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
    throw new RequestError(400, 'Check the profile fields and their length limits.');
  }
  return value.trim();
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RequestError(400, 'The control value is out of range.');
  }
  return value;
}


export interface CompanionService {
  readonly robotURL: string;
  owns(id: string): boolean;
  voiceConfiguration(): { config: Config; persona: string } | Promise<{ config: Config; persona: string }>;
  archive(session: string, at: number, user: string, reply: string): void | Promise<void>;
  publishDirections?(route: DirectionsRoute): void | Promise<void>;
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void>;
}

export function defaultProfile(cfg: Config): Profile {
  return {
      name: 'Server default', backend: 'primary', model: cfg.llm.model, voiceId: cfg.elevenlabs.voiceId,
      voiceModel: cfg.elevenlabs.ttsModel, gain: cfg.speechGain ?? 1, persona: '',
    };
}

export function configuredProfile(cfg: Config, profile: Profile): Config {
  const backend = profile.backend === 'fallback' ? cfg.fallbackLlm : cfg.llm;
  if (!backend) return cfg;
  return {
    ...cfg, llm: { ...backend, model: profile.model },
    fallbackLlm: profile.backend === 'fallback' ? undefined : cfg.fallbackLlm,
    elevenlabs: { ...cfg.elevenlabs, voiceId: profile.voiceId, ttsModel: profile.voiceModel },
    speechGain: profile.gain,
  };
}

export function validateProfile(data: Record<string, unknown>, cfg: Config): Profile {
    const { backend, gain } = data;
    if (backend !== 'primary' && (backend !== 'fallback' || !cfg.fallbackLlm)) {
      throw new RequestError(400, 'Choose a backend configured on the relay.');
    }
    if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0.5 || gain > 2) {
      throw new RequestError(400, 'Speech gain must be between 0.5 and 2.');
    }
    return {
      name: boundedString(data.name, 64), backend,
      model: boundedString(data.model, 160), voiceId: boundedString(data.voiceId, 100),
      voiceModel: boundedString(data.voiceModel, 100), gain, persona: boundedString(data.persona, 3000, true),
    };
  }

export function validateCommand(data: Record<string, unknown>): Command {
  switch (data.action) {
    case 'head':
      return { action: data.action, yaw: integer(data.yaw, -45, 45), pitch: integer(data.pitch, 0, 45) };
    case 'volume':
    case 'brightness':
      return { action: data.action, value: integer(data.value, 0, 100) };
    case 'photo':
    case 'streamStart':
    case 'frame':
      return { action: data.action };
    default: throw new RequestError(400, 'Unknown device command.');
  }
}

export class Companion implements CompanionService {
  private readonly db: DatabaseSync;
  private lastSeen = 0;
  private readings: ControlReadings = {};
  private pending?: Pending;
  private poll?: (pending?: Pending) => void;
  private readonly defaultProfile: Profile;

  constructor(private readonly cfg: Config, private readonly token: string,
              private readonly deviceId: string, storage: string) {
    if (!cfg.deviceToken || !cfg.otaSecret || cfg.deviceToken === token || cfg.otaSecret === token ||
        cfg.otaSecret === cfg.deviceToken || token.length < 32) {
      throw new Error('Companion needs a 32+ character app token and distinct device and OTA secrets.');
    }
    const sqlite: typeof import('node:sqlite') = loadBuiltin('node:sqlite');
    this.db = new sqlite.DatabaseSync(storage);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, savedAt INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, at INTEGER NOT NULL,
        user TEXT NOT NULL, reply TEXT NOT NULL
      );
    `);
    this.defaultProfile = defaultProfile(cfg);
  }

  static fromEnvironment(cfg: Config): Companion | undefined {
    const { COMPANION_TOKEN, COMPANION_DEVICE_ID, COMPANION_DB } = process.env;
    if (!COMPANION_TOKEN && !COMPANION_DEVICE_ID && !COMPANION_DB) return;
    if (!COMPANION_TOKEN || !COMPANION_DEVICE_ID || !COMPANION_DB ||
        !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(COMPANION_DEVICE_ID)) {
      throw new Error('Set COMPANION_TOKEN, COMPANION_DEVICE_ID (MAC address) and COMPANION_DB together.');
    }
    const url = new URL(cfg.publicWsUrl);
    if (url.protocol !== 'wss:' || url.pathname !== '/api/ws' || url.username || url.password) {
      throw new Error('Set PUBLIC_WS_URL to the relay’s public wss://…/api/ws URL.');
    }
    return new Companion(cfg, COMPANION_TOKEN, COMPANION_DEVICE_ID.toLowerCase(), COMPANION_DB);
  }

  get robotURL(): string {
    const url = new URL(this.cfg.publicWsUrl);
    url.protocol = 'https:';
    return new URL(prefix + '/robot', url).href;
  }

  owns(id: string): boolean { return id.toLowerCase() === this.deviceId; }

  private setting(key: string): string | undefined {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value as string | undefined;
  }

  private set(key: string, value: string) {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  profile(): Profile {
    const row = this.db.prepare('SELECT data FROM profiles WHERE id = ?').get(this.setting('active') ?? '');
    return row ? JSON.parse(row.data as string) : this.defaultProfile;
  }

  config(): Config {
    if (!this.setting('active')) return this.cfg;
    const profile = this.profile();
    return configuredProfile(this.cfg, profile);
  }

  voiceConfiguration() {
    return { config: this.config(), persona: this.profile().persona };
  }

  archive(session: string, at: number, user: string, reply: string) {
    if (this.setting('recording') !== 'true') return;
    this.db.prepare('INSERT INTO turns (session, at, user, reply) VALUES (?, ?, ?, ?)')
      .run(session, at, user.slice(0, 8000), reply.slice(0, 16000));
  }

  private directions?: DirectionsHandoff;

  publishDirections(route: DirectionsRoute) {
    this.directions = makeDirectionsHandoff(route);
  }

  private latestDirections(): DirectionsHandoff | null {
    const latest = activeDirections(this.directions);
    if (!latest) this.directions = undefined;
    return latest;
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string) {
    try {
      const route = path.slice(prefix.length);
      const robot = route === '/robot/poll' || route === '/robot/result';
      const auth = req.headers.authorization ?? '';
      if (!bearerMatches(auth, robot ? this.cfg.deviceToken : this.token) ||
          (robot && !this.owns(String(req.headers['device-id'] ?? '')))) {
        send(res, 401, { error: 'Check the pairing credentials.' });
        return;
      }
      switch (req.method + ' ' + route) {
        case 'GET /status':
          send(res, 200, { online: this.online(), lastSeen: this.lastSeen || null, ...this.readings,
            directionsId: this.latestDirections()?.id });
          break;
        case 'GET /directions':
          send(res, 200, { route: this.latestDirections() });
          break;
        case 'POST /command':
          this.command(await json(req), res);
          break;
        case 'GET /robot/poll':
          this.readings = controlReadings(req);
          this.waitForCommand(res);
          break;
        case 'POST /robot/result':
          await this.receiveResult(req, res);
          break;
        case 'GET /profiles':
          send(res, 200, {
            defaults: this.defaultProfile,
            active: this.setting('active') || null,
            profiles: this.db.prepare('SELECT id, savedAt, data FROM profiles ORDER BY savedAt DESC').all()
              .map(row => ({ id: row.id, savedAt: row.savedAt, profile: JSON.parse(row.data as string) })),
            backends: this.cfg.fallbackLlm ? ['primary', 'fallback'] : ['primary'],
          });
          break;
        case 'POST /profiles': {
          const data = await json(req);
          const profile = validateProfile(data, this.cfg);
          const count = this.db.prepare('SELECT COUNT(*) AS count FROM profiles').get()!.count as number;
          if (count >= 100) {
            throw new RequestError(409, 'The profile archive is full. Remove a saved version first.');
          }
          const id = randomUUID();
          this.db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run(id, Date.now(), JSON.stringify(profile));
          send(res, 201, { id });
          break;
        }
        case 'PUT /active-profile': {
          const { id } = await json(req);
          if (id !== null && (typeof id !== 'string' || !this.db.prepare('SELECT id FROM profiles WHERE id = ?').get(id))) {
            throw new RequestError(404, 'That profile is no longer available.');
          }
          if (typeof id === 'string') {
            const row = this.db.prepare('SELECT data FROM profiles WHERE id = ?').get(id)!;
            validateProfile(JSON.parse(row.data as string), this.cfg);
          }
          this.set('active', id ?? '');
          send(res, 204);
          break;
        }
        case 'DELETE /profiles': {
          const id = new URL(req.url!, 'http://localhost').searchParams.get('id');
          if (!id) throw new RequestError(400, 'Choose a profile to remove.');
          if (this.setting('active') === id) throw new RequestError(409, 'Switch profiles before removing the active one.');
          this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
          send(res, 204);
          break;
        }
        case 'GET /history': {
          const raw = new URL(req.url!, 'http://localhost').searchParams.get('before');
          const before = raw === null ? Number.MAX_SAFE_INTEGER : integer(Number(raw), 1, Number.MAX_SAFE_INTEGER);
          const turns = this.db.prepare('SELECT * FROM turns WHERE id < ? ORDER BY id DESC LIMIT 51').all(before);
          if (turns.length === 51) {
            turns.pop();
            send(res, 200, { recording: this.setting('recording') === 'true', turns, next: turns.at(-1)!.id });
          } else {
            send(res, 200, { recording: this.setting('recording') === 'true', turns, next: null });
          }
          break;
        }
        case 'PUT /history': {
          const { recording } = await json(req);
          if (typeof recording !== 'boolean') throw new RequestError(400, 'Choose whether to archive conversations.');
          this.set('recording', String(recording));
          send(res, 204);
          break;
        }
        case 'DELETE /history':
          this.db.prepare('DELETE FROM turns').run();
          send(res, 204);
          break;
        default:
          send(res, 404, { error: 'Companion endpoint not found.' });
      }
    } catch (error) {
      if (error instanceof RequestError) send(res, error.status, { error: error.message });
      else {
        console.error('[companion] request failed', error instanceof Error ? error.name : 'unknown');
        send(res, 500, { error: 'The relay could not complete the request.' });
      }
    }
  }

  private online(): boolean { return Date.now() - this.lastSeen < 18_000; }

  private command(data: Record<string, unknown>, reply: ServerResponse) {
    const command = validateCommand(data);
    if (!this.online()) throw new RequestError(503, 'Saoirse is offline. Check her power and Wi-Fi.');
    if (this.pending) throw new RequestError(409, 'Saoirse is finishing another command. Try again.');
    if (reply.destroyed) return;

    const pending: Pending = {
      id: randomUUID(), command, reply, sent: false,
      timer: setTimeout(() => {
        this.finish(pending);
        send(reply, 504, { error: 'Saoirse did not confirm the command.' });
      }, 12_000),
    };
    this.pending = pending;
    // Keep the slot occupied for dispatched commands until the device finishes or times out.
    reply.once('close', () => { if (!pending.sent) this.finish(pending); });
    this.poll?.(pending);
  }

  private finish(pending: Pending) {
    clearTimeout(pending.timer);
    if (this.pending === pending) this.pending = undefined;
  }

  private waitForCommand(res: ServerResponse) {
    this.lastSeen = Date.now();
    this.poll?.();
    const done = (pending?: Pending) => {
      if (this.poll === done) this.poll = undefined;
      clearTimeout(timer);
      if (res.destroyed) return;
      if (pending && !pending.sent) {
        pending.sent = true;
        send(res, 200, { id: pending.id, ...pending.command });
      } else send(res, 204);
    };
    const timer = setTimeout(done, 7500);
    this.poll = done;
    res.once('close', () => { clearTimeout(timer); if (this.poll === done) this.poll = undefined; });
    if (this.pending && !this.pending.sent) done(this.pending);
  }

  private async receiveResult(req: IncomingMessage, res: ServerResponse) {
    const id = req.headers['x-command-id'];
    const pending = this.pending;
    if (!pending?.sent || id !== pending.id) throw new RequestError(404, 'Command expired.');
    const body = await read(req, maxJpeg);
    if (this.pending !== pending) throw new RequestError(404, 'Command expired.');
    this.lastSeen = Date.now();
    this.readings = controlReadings(req);
    this.finish(pending);
    const camera = ['photo', 'frame', 'streamStart'].includes(pending.command.action);
    if (req.headers['x-command-result'] !== 'ok') {
      send(pending.reply, 422, { error: camera
        ? 'The camera is busy or unavailable. Try again when Saoirse is idle.'
        : 'Saoirse could not apply the control. Check her position and try again.' });
    } else if (camera) {
      if (req.headers['content-type'] !== 'image/jpeg' || body.length < 4 ||
          body.readUInt16BE(0) !== 0xffd8 || body.readUInt16BE(body.length - 2) !== 0xffd9) {
        send(pending.reply, 502, { error: 'Saoirse returned an unreadable camera frame.' });
      } else if (!pending.reply.destroyed) {
        pending.reply.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'image/jpeg' });
        pending.reply.end(body);
      }
    } else {
      const ack = controlAcknowledgement(pending.command, this.readings, this.lastSeen);
      send(pending.reply, ack ? 200 : 204, ack);
    }
    send(res, 204);
  }
}
