import type { DirectionsRoute } from './directions.js';
import { activeDirections, directionsLifetimeSeconds, makeDirectionsHandoff, type DirectionsHandoff } from './directions_handoff.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { bearerMatches } from './auth.js';
import type { Config } from './config.js';
import {
  configuredProfile, controlAcknowledgement, controlReadings, defaultProfile, integer, json, maxJpeg, prefix, read, RequestError,
  send, validateCommand, validateProfile, type Command, type CompanionService, type Profile,
  type ControlReadings, type RobotPresence,
} from './companion.js';

export interface RelayCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: number | RobotPresence | DirectionsHandoff, options: { ttl: number }): Promise<unknown>;
}

function keyPair() { return generateKeyPairSync('x25519'); }

function publicKey(key: KeyObject) {
  return key.export({ type: 'spki', format: 'der' }).toString('base64url');
}

function secret(privateKey: KeyObject, encodedPublicKey: string) {
  const publicKey = createPublicKey({ key: Buffer.from(encodedPublicKey, 'base64url'), format: 'der', type: 'spki' });
  return createHash('sha256').update(diffieHellman({ privateKey, publicKey })).digest();
}

function seal(frame: Buffer, recipient: string): string {
  const sender = keyPair();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(sender.privateKey, recipient), iv);
  const data = Buffer.concat([cipher.update(frame), cipher.final()]);
  return [publicKey(sender.publicKey), ...[iv, cipher.getAuthTag(), data].map(v => v.toString('base64url'))].join('.');
}

function openFrame(value: string, recipient: KeyObject): Buffer {
  const [sender, iv, tag, data] = value.split('.');
  const decipher = createDecipheriv('aes-256-gcm', secret(recipient, sender), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
}

export class CloudCompanion implements CompanionService {
  private readonly sql: NeonQueryFunction<false, false>;
  readonly robotURL: string;

  constructor(
    private readonly cfg: Config, private readonly token: string,
    private readonly deviceId: string, connection: string, private readonly cache?: RelayCache,
  ) {
    if (!cfg.deviceToken || !cfg.otaSecret || cfg.deviceToken === token || cfg.otaSecret === token ||
        cfg.otaSecret === cfg.deviceToken || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      throw new Error('Configure distinct companion, device and OTA secrets.');
    }
    const url = new URL(cfg.publicWsUrl);
    if (url.protocol !== 'wss:' || url.pathname !== '/api/ws' || url.username || url.password) {
      throw new Error('Configure a public wss://…/api/ws URL.');
    }
    url.protocol = 'https:';
    this.robotURL = new URL(prefix + '/robot', url).href;
    this.sql = neon(connection);
  }

  static fromEnvironment(cfg: Config, cache?: RelayCache): CloudCompanion | undefined {
    const { COMPANION_DATABASE_URL, COMPANION_TOKEN, COMPANION_DEVICE_ID } = process.env;
    if (!COMPANION_DATABASE_URL) return;
    if (!COMPANION_TOKEN || !COMPANION_DEVICE_ID || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(COMPANION_DEVICE_ID)) {
      throw new Error('Set COMPANION_TOKEN and COMPANION_DEVICE_ID (Wi-Fi MAC address).');
    }
    return new CloudCompanion(cfg, COMPANION_TOKEN, COMPANION_DEVICE_ID.toLowerCase(), COMPANION_DATABASE_URL, cache);
  }

  owns(id: string): boolean { return id.toLowerCase() === this.deviceId; }

  private get cacheKey() { return 'saoirse-relay:' + this.deviceId; }

  private async presence(): Promise<RobotPresence | undefined> {
    if (!this.cache) return undefined;
    try {
      const value = await this.cache.get(this.cacheKey + ':controls');
      const cached = value as RobotPresence | null;
      if (!cached || typeof cached.lastSeen !== 'number') return undefined;
      return { ...cached, online: Date.now() - cached.lastSeen < 30_000 };
    } catch {
      return undefined;
    }
  }

  private async cachePresence(snapshot: RobotPresence) {
    try { await this.cache?.set(this.cacheKey + ':controls', snapshot, { ttl: 31 }); }
    catch { /* The durable snapshot is available if the cache is down. */ }
  }

  private async wake() {
    try { await this.cache?.set(this.cacheKey + ':wake', 1, { ttl: 17 }); }
    catch { /* A cache outage may fall back to polling the database. */ }
  }

  async voiceConfiguration() {
    const sql = this.sql;
    const [row] = await sql`SELECT data FROM companion_profiles WHERE id =
        (SELECT active_profile FROM companion_settings WHERE slot)`;
    const profile = row?.data as Profile | undefined;
    return profile ? { config: configuredProfile(this.cfg, profile), persona: profile.persona } :
      { config: this.cfg, persona: '' };
  }

  async archive(session: string, at: number, user: string, reply: string) {
    const sql = this.sql;
    await sql`INSERT INTO companion_turns(session, at, user_text, reply)
      SELECT ${session}, ${at}, ${user.slice(0, 8000)}, ${reply.slice(0, 16000)}
      FROM companion_settings WHERE slot AND recording`;
  }

  async publishDirections(route: DirectionsRoute) {
    if (!this.cache) return;
    await this.cache.set(this.cacheKey + ':directions', makeDirectionsHandoff(route), { ttl: directionsLifetimeSeconds });
  }

  private async latestDirections(): Promise<DirectionsHandoff | null> {
    try { return activeDirections(await this.cache?.get(this.cacheKey + ':directions')); }
    catch { return null; }
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string) {
    const route = path.startsWith(prefix + '/') ? path.slice(prefix.length) : path;
    try {
      const target = new URL(req.url ?? '/', 'http://localhost');
      const robot = route === '/robot/poll' || route === '/robot/result';
      if (!bearerMatches(req.headers.authorization ?? '', robot ? this.cfg.deviceToken : this.token) ||
          (robot && !this.owns(String(req.headers['device-id'] ?? '')))) {
        return send(res, 401, { error: 'Check the pairing credentials.' });
      }
      const sql = this.sql;
      switch (req.method + ' ' + route) {
        case 'GET /status': {
          const [presence, directions] = await Promise.all([this.presence(), this.latestDirections()]);
          const directionsId = directions?.id;
          if (presence) return send(res, 200, { ...presence, directionsId });
          const [row] = await sql`SELECT last_seen::float8 AS "lastSeen", control_readings,
            COALESCE(last_seen > (EXTRACT(EPOCH FROM clock_timestamp()) * 1000 - 25000), false) AS online
            FROM companion_settings WHERE slot`;
          return send(res, 200, { online: row?.online ?? false, lastSeen: row?.lastSeen ?? null,
            ...row?.control_readings, directionsId });
        }
        case 'GET /directions':
          return send(res, 200, { route: await this.latestDirections() });
        case 'GET /robot/poll':
          return await this.poll(controlReadings(req), res);
        case 'POST /robot/result':
          return await this.result(req, res);
        case 'POST /command':
          return await this.command(validateCommand(await json(req)), res);
        case 'GET /profiles': {
          const [row] = await sql`SELECT active_profile AS active,
            COALESCE((SELECT json_agg(
              json_build_object('id', id, 'savedAt', saved_at, 'profile', data) ORDER BY saved_at DESC
            ) FROM companion_profiles), '[]'::json) AS profiles FROM companion_settings WHERE slot`;
          return send(res, 200, { ...row, defaults: defaultProfile(this.cfg),
            backends: this.cfg.fallbackLlm ? ['primary', 'fallback'] : ['primary'] });
        }
        case 'POST /profiles': {
          const profile = validateProfile(await json(req), this.cfg);
          const id = randomUUID();
          const inserted = await sql`INSERT INTO companion_profiles(id, saved_at, data)
            SELECT ${id}, ${Date.now()}, ${JSON.stringify(profile)}::jsonb
            WHERE (SELECT COUNT(*) FROM companion_profiles) < 100 RETURNING id`;
          if (!inserted.length) throw new RequestError(409, 'The profile archive is full.');
          return send(res, 201, { id });
        }
        case 'PUT /active-profile': {
          const { id } = await json(req);
          if (id !== null && typeof id !== 'string') throw new RequestError(400, 'Choose a profile to apply.');
          if (typeof id === 'string') {
            const [row] = await sql`SELECT data FROM companion_profiles WHERE id = ${id}`;
            if (!row) throw new RequestError(404, 'That profile is no longer available.');
            validateProfile(row.data, this.cfg);
          }
          await sql`UPDATE companion_settings SET active_profile = ${id} WHERE slot`;
          return send(res, 204);
        }
        case 'DELETE /profiles': {
          const id = target.searchParams.get('id');
          if (!id) throw new RequestError(400, 'Choose a profile to remove.');
          const [row] = await sql`SELECT active_profile FROM companion_settings WHERE slot`;
          if (row?.active_profile === id) throw new RequestError(409, 'Switch profiles before removing the active one.');
          await sql`DELETE FROM companion_profiles WHERE id = ${id}`;
          return send(res, 204);
        }
        case 'GET /history': {
          const raw = target.searchParams.get('before');
          const before = raw === null ? Number.MAX_SAFE_INTEGER : integer(Number(raw), 1, Number.MAX_SAFE_INTEGER);
          const [settings, turns] = await sql.transaction([
            sql`SELECT recording FROM companion_settings WHERE slot`,
            sql`SELECT id::float8 AS id, session, at::float8 AS at, user_text AS "user", reply
                FROM companion_turns WHERE id < ${before} ORDER BY id DESC LIMIT 51`,
          ]);
          const more = turns.length > 50;
          if (more) turns.pop();
          return send(res, 200, { recording: settings[0]?.recording ?? false, turns, next: more ? turns.at(-1)!.id : null });
        }
        case 'PUT /history': {
          const { recording } = await json(req);
          if (typeof recording !== 'boolean') throw new RequestError(400, 'Choose whether to archive conversations.');
          await sql`UPDATE companion_settings SET recording = ${recording} WHERE slot`;
          return send(res, 204);
        }
        case 'DELETE /history':
          await sql`DELETE FROM companion_turns`;
          return send(res, 204);
        default:
          return send(res, 404, { error: 'Companion endpoint not found.' });
      }
    } catch (error) {
      if (error instanceof RequestError) return send(res, error.status, { error: error.message });
      console.error('[companion] cloud operation failed', error instanceof Error ? error.name : 'unknown');
      return send(res, 500, { error: 'The relay could not complete the request.' });
    }
  }

  private async poll(readings: ControlReadings, res: ServerResponse) {
    res.setHeader('Retry-After', '6');
    const now = Date.now();
    const snapshot = { ...readings, lastSeen: now, online: true };
    if (this.cache) {
      try {
        const [seen, wake] = await Promise.all([
          this.presence(), this.cache.get(this.cacheKey + ':wake'),
        ]);
        if (seen?.lastSeen && readings.volume === seen.volume && readings.brightness === seen.brightness && wake !== 1) {
          if (now - seen.lastSeen >= 17_000) await this.cache.set(this.cacheKey + ':controls', snapshot, { ttl: 31 });
          return send(res, 204);
        }
      } catch {
        // The presence hint is an optimisation. Keep serving commands from Postgres.
      }
    }
    const sql = this.sql;
    const [row] = await sql`WITH heartbeat AS (
        UPDATE companion_settings SET last_seen = ${now}, control_readings = ${JSON.stringify(readings)}::jsonb
        WHERE slot AND (last_seen IS NULL OR last_seen <= ${now})
          AND (last_seen IS NULL OR last_seen < ${now - 17_000} OR control_readings IS DISTINCT FROM ${JSON.stringify(readings)}::jsonb)
      ), expired AS (
        DELETE FROM companion_command WHERE slot AND expires_at <= now()
      )
      UPDATE companion_command SET state = 'sent'
      WHERE slot AND state = 'queued' AND expires_at > now()
      RETURNING id, payload`;
    await this.cachePresence(snapshot);
    return row ? send(res, 200, { id: row.id, ...row.payload }) : send(res, 204);
  }

  private async command(command: Command, res: ServerResponse) {
    const sql = this.sql;
    const id = randomUUID();
    const camera = command.action === 'photo' || command.action === 'streamStart' || command.action === 'frame';
    const recipient = camera ? keyPair() : undefined;
    const pub = recipient ? publicKey(recipient.publicKey) : null;
    const presence = await this.presence();
    const [row] = await sql`WITH available AS (
        SELECT COALESCE(${presence?.online ?? null}::boolean, last_seen > ${Date.now() - 25000}) AS online
        FROM companion_settings WHERE slot
      ), inserted AS (
        INSERT INTO companion_command(slot, id, payload, state, recipient, expires_at)
        SELECT true, ${id}, ${JSON.stringify(command)}::jsonb, 'queued', ${pub}, now() + interval '13 seconds'
        FROM available WHERE online
        ON CONFLICT (slot) DO UPDATE
        SET id = excluded.id, payload = excluded.payload, state = 'queued',
            recipient = excluded.recipient, result = null, expires_at = excluded.expires_at
        WHERE companion_command.expires_at <= now()
        RETURNING id
      ) SELECT (SELECT online FROM available) AS online, (SELECT id FROM inserted) AS accepted`;
    if (!row?.online) throw new RequestError(503, 'Saoirse is offline. Check her power and Wi-Fi.');
    if (!row.accepted) throw new RequestError(409, 'Saoirse is finishing another command. Try again.');
    const until = Date.now() + 12500;
    let nextWake = 0;
    try {
      while (!res.destroyed && Date.now() < until) {
        if (this.cache && Date.now() >= nextWake) {
          nextWake = Date.now() + 5000;
          await this.wake();
        }
        const [answer] = await sql`DELETE FROM companion_command WHERE slot AND id = ${id}
          AND state IN ('ok', 'error') RETURNING state, result`;
        if (answer?.state === 'error') {
          throw new RequestError(422, camera ? 'The camera is busy or unavailable. Try again when Saoirse is idle.' :
            'Saoirse could not apply the control. Check her position and try again.');
        }
        if (answer && !res.destroyed) {
          if (!recipient) {
            const ack = answer.result ? JSON.parse(answer.result) : undefined;
            return send(res, ack ? 200 : 204, ack);
          }
          const frame = openFrame(answer.result, recipient.privateKey);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
          res.end(frame);
          return;
        }
        await delay(150);
      }
      throw new RequestError(504, 'Saoirse did not confirm the command.');
    } finally {
      if (res.destroyed) await sql`DELETE FROM companion_command WHERE slot AND id = ${id} AND state = 'queued'`;
    }
  }

  private async result(req: IncomingMessage, res: ServerResponse) {
    const sql = this.sql;
    const id = req.headers['x-command-id'];
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new RequestError(404, 'Command expired.');
    const body = await read(req, maxJpeg);
    const [job] = await sql`SELECT recipient, payload FROM companion_command
      WHERE slot AND id = ${id} AND state = 'sent' AND expires_at > now()`;
    if (!job) throw new RequestError(404, 'Command expired.');
    const ok = req.headers['x-command-result'] === 'ok' && (!job.recipient || (
      req.headers['content-type'] === 'image/jpeg' && body.length >= 4 &&
      body.readUInt16BE(0) === 0xffd8 && body.readUInt16BE(body.length - 2) === 0xffd9));
    const now = Date.now();
    const readings = controlReadings(req);
    const ack = controlAcknowledgement(job.payload as Command, readings, now);
    const result = ok && job.recipient ? seal(body, job.recipient) : ok && ack ? JSON.stringify(ack) : null;
    const saved = await sql`WITH accepted AS (
      UPDATE companion_command SET state = ${ok ? 'ok' : 'error'}, result = ${result}
      WHERE slot AND id = ${id} AND state = 'sent' AND expires_at > now() RETURNING id
    ), heartbeat AS (
      UPDATE companion_settings SET last_seen = ${now}, control_readings = ${JSON.stringify(readings)}::jsonb
      WHERE slot AND EXISTS (SELECT 1 FROM accepted) AND (last_seen IS NULL OR last_seen <= ${now})
        AND (last_seen IS NULL OR last_seen < ${now - 17_000} OR control_readings IS DISTINCT FROM ${JSON.stringify(readings)}::jsonb)
    ) SELECT id FROM accepted`;
    if (!saved.length) throw new RequestError(404, 'Command expired.');
    await this.cachePresence({ ...readings, lastSeen: now, online: true });
    return send(res, 204);
  }
}
