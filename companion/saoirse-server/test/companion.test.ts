import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { CloudCompanion, type RelayCache } from '../src/cloud_companion.js';
import type { DirectionsHandoff } from '../src/directions_handoff.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Companion } from '../src/companion.js';
import { loadConfig } from '../src/config.js';
import { createAppServer } from '../src/server.js';

const deviceId = 'aa:bb:cc:dd:ee:ff';
const appToken = 'test-only-companion-token-for-vitest';
const config = loadConfig({
  LLM_API_KEY: 'primary', ELEVENLABS_API_KEY: 'voice', ELEVENLABS_VOICE_ID: 'default-voice',
  LLM_FALLBACK_API_KEY: 'fallback-key', LLM_FALLBACK_BASE_URL: 'https://fallback.example.com/v1',
  LLM_FALLBACK_MODEL: 'fallback-model', PUBLIC_WS_URL: 'wss://relay.example.com/api/ws',
  SAOIRSE_DEVICE_TOKEN: 'device-secret', OTA_SECRET: 'ota-secret',
});
const appAuth = { authorization: 'Bearer ' + appToken };
const robotAuth = { authorization: 'Bearer ' + config.deviceToken, 'device-id': deviceId };
let directory: string;
let companion: Companion;
let server: ReturnType<typeof createAppServer>;
let base: string;

function route(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers ?? appAuth);
  if (typeof options.body === 'string') headers.set('content-type', 'application/json');
  return fetch(base + '/api/companion/' + path, { ...options, headers });
}

function post(path: string, data: unknown, method = 'POST') {
  return route(path, { method, body: JSON.stringify(data) });
}

function connectRobot() {
  return route('robot/poll', { headers: robotAuth });
}

async function waitOnline() {
  const limit = Date.now() + 1500;
  while (Date.now() < limit) {
    if ((await (await route('status')).json()).online) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Robot did not check in');
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'saoirse-archive-'));
  companion = new Companion(config, appToken, deviceId, join(directory, 'archive.sqlite'));
  server = createAppServer(config, undefined, undefined, companion);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe('Saoirse companion relay', () => {
  it('separates app pairing, device credentials and device identity', async () => {
    expect((await route('status', { headers: robotAuth })).status).toBe(401);
    expect((await route('robot/poll')).status).toBe(401);
    expect((await route('robot/poll', { headers: { ...robotAuth, 'device-id': 'other' } })).status).toBe(401);
    expect((await post('command', { action: 'head', yaw: 0, pitch: 0 })).status).toBe(503);
    expect((await post('command', { action: 'head', yaw: 90, pitch: 0 })).status).toBe(400);
    const ota = async (id: string) => (await fetch(base + '/api/ota?k=ota-secret', {
      method: 'POST', headers: { 'device-id': id },
    })).json();
    expect(await ota(deviceId.toUpperCase())).toMatchObject({ companion_url: 'https://relay.example.com/api/companion/robot' });
    expect(await ota('other')).not.toHaveProperty('companion_url');
  });

  it('returns a private latest route independently of transcript archiving', async () => {
    expect(await (await route('directions')).json()).toEqual({ route: null });
    expect((await route('directions', { headers: robotAuth })).status).toBe(401);
    companion.publishDirections({
      origin: 'Trafalgar Square', destination: 'Covent Garden', mode: 'walk', durationMinutes: 12,
      distanceMeters: 900, steps: [{ instruction: 'Head north.' }], totalSteps: 1,
      originCoordinate: [51.5, -0.12], destinationCoordinate: [51.51, -0.12],
      geometry: [], source: 'OpenStreetMap',
    });
    const latest = (await (await route('directions')).json()).route;
    expect(latest).toMatchObject({ destination: 'Covent Garden', mode: 'walk', durationMinutes: 12 });
    expect(latest.expiresAt - latest.createdAt).toBe(15 * 60 * 1000);
    expect(await (await route('status')).json()).toMatchObject({ directionsId: latest.id });
  });

  it('hands a route from a voice instance to a separate app relay and hides it after expiry', async () => {
    const values = new Map<string, unknown>();
    const cache: RelayCache = {
      get: async key => values.get(key),
      set: async (key, value, options) => {
        if (key.endsWith(':directions')) expect(options.ttl).toBe(15 * 60);
        values.set(key, value);
      },
    };
    const connection = 'postgresql://example:fake@database.invalid/unused';
    const voice = new CloudCompanion(config, appToken, deviceId, connection, cache);
    const api = new CloudCompanion(config, appToken, deviceId, connection, cache);
    const routeCacheKey = 'saoirse-relay:' + deviceId + ':directions';
    values.set('saoirse-relay:' + deviceId + ':controls', { lastSeen: Date.now(), volume: 75 });
    const local = createServer((req, res) => void api.handle(req, res, req.url ?? '/'));
    await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + (local.address() as AddressInfo).port;
    try {
      await voice.publishDirections({
        origin: 'Waterloo', destination: 'Big Ben', mode: 'walk', durationMinutes: 24, totalSteps: 2,
        distanceMeters: 1979, steps: [{ instruction: 'Head out of the station.' }, { instruction: 'Cross the bridge.' }],
        geometry: [[51.5, -0.11], [51.5, -0.12]], source: 'Valhalla',
      });
      expect((await fetch(endpoint + '/directions', { headers: robotAuth })).status).toBe(401);
      const preview = (await (await fetch(endpoint + '/directions', { headers: appAuth })).json()).route;
      expect(preview).toMatchObject({ destination: 'Big Ben', mode: 'walk' });
      const status = await (await fetch(endpoint + '/status', { headers: appAuth })).json();
      expect(status).toMatchObject({ directionsId: preview.id, volume: 75 });
      expect(status).not.toHaveProperty('geometry');
      values.set(routeCacheKey, { ...(values.get(routeCacheKey) as DirectionsHandoff), expiresAt: Date.now() - 1 });
      expect(await (await fetch(endpoint + '/directions', { headers: appAuth })).json()).toEqual({ route: null });
    } finally {
      local.closeAllConnections();
      await new Promise<void>(resolve => local.close(() => resolve()));
    }
  });

  it('delivers position commands only once and returns the robot acknowledgement', async () => {
    const waiting = connectRobot();
    await waitOnline();
    const command = post('command', { action: 'head', yaw: -30, pitch: 20 });
    const issued = await (await waiting).json();
    expect(issued).toMatchObject({ action: 'head', yaw: -30, pitch: 20 });
    expect((await post('command', { action: 'volume', value: 20 })).status).toBe(409);
    const reply = () => route('robot/result', {
      method: 'POST', headers: { ...robotAuth, 'x-command-id': issued.id, 'x-command-result': 'ok' },
    });
    expect((await reply()).status).toBe(204);
    expect((await command).status).toBe(204);
    expect((await reply()).status).toBe(404);
  });

  it('reports measured controls from the robot and returns the readings from a command acknowledgement', async () => {
    const poll = route('robot/poll', { headers: { ...robotAuth, 'x-saoirse-volume': '0', 'x-saoirse-brightness': '100' } });
    await waitOnline();
    const status = await (await route('status')).json();
    expect(status).toMatchObject({ online: true, volume: 0, brightness: 100 });
    const command = post('command', { action: 'volume', value: 61 });
    const issued = await (await poll).json();
    expect((await route('robot/result', { method: 'POST', headers: { ...robotAuth, 'x-command-id': issued.id,
      'x-command-result': 'ok', 'x-saoirse-volume': '60', 'x-saoirse-brightness': '37' } })).status).toBe(204);
    const response = await command;
    expect(response.status).toBe(200);
    const reported = await response.json();
    expect(reported).toMatchObject({ online: true, volume: 60, brightness: 37 });
    expect(reported.lastSeen).toBeGreaterThanOrEqual(status.lastSeen);
    expect(await (await route('status')).json()).toEqual(reported);

    const partial = route('robot/poll', { headers: { ...robotAuth, 'x-saoirse-volume': '12.5', 'x-saoirse-brightness': '0' } });
    // The new poll resolves when the next poll or a command arrives.
    let current = reported;
    for (let i = 0; i < 30 && 'volume' in current; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      current = await (await route('status')).json();
    }
    expect(current).toMatchObject({ online: true, brightness: 0 });
    expect(current).not.toHaveProperty('volume');
    const legacy = connectRobot();
    expect((await partial).status).toBe(204);
    const after = await (await route('status')).json();
    expect(after).not.toHaveProperty('volume');
    expect(after).not.toHaveProperty('brightness');
    const finish = post('command', { action: 'brightness', value: 30 });
    const next = await (await legacy).json();
    await route('robot/result', { method: 'POST', headers: { ...robotAuth, 'x-command-id': next.id, 'x-command-result': 'ok' } });
    expect((await finish).status).toBe(204);
  });

  it('relays fresh JPEGs for a photo and successive live frames', async () => {
    for (const [index, action] of ['photo', 'streamStart', 'frame', 'frame'].entries()) {
      const waiting = connectRobot();
      await waitOnline();
      const capture = post('command', { action });
      const issued = await (await waiting).json();
      expect(issued.action).toBe(action);
      const jpeg = Uint8Array.of(0xff, 0xd8, index, 0xff, 0xd9);
      expect((await route('robot/result', {
        method: 'POST',
        headers: { ...robotAuth, 'x-command-id': issued.id, 'x-command-result': 'ok', 'content-type': 'image/jpeg' },
        body: jpeg,
      })).status).toBe(204);
      const response = await capture;
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    }
  });

  it('persists archived profiles, applies only trusted backend connections and restores the server default', async () => {
    const starting = await (await route('profiles')).json();
    const profile = {
      ...starting.defaults, name: 'Quiet focus', backend: 'fallback', model: 'selected-model',
      voiceId: 'quiet-voice', gain: 0.8, persona: 'Use plain language.',
    };
    expect((await post('profiles', { ...profile, backend: 'https://untrusted.example' })).status).toBe(400);
    const saved = await (await post('profiles', profile)).json();
    expect(companion.config().llm.model).toBe(config.llm.model);
    expect((await post('active-profile', { id: saved.id }, 'PUT')).status).toBe(204);
    const restarted = new Companion(config, appToken, deviceId, join(directory, 'archive.sqlite'));
    expect(restarted.profile()).toEqual(profile);
    expect(restarted.config().llm).toMatchObject({ model: 'selected-model', apiKey: 'fallback-key' });
    expect(restarted.config().elevenlabs.voiceId).toBe('quiet-voice');
    expect((await route('profiles?id=' + saved.id, { method: 'DELETE' })).status).toBe(409);
    expect((await post('active-profile', { id: null }, 'PUT')).status).toBe(204);
    expect(restarted.config()).toEqual(config);
    expect((await route('profiles?id=' + saved.id, { method: 'DELETE' })).status).toBe(204);
  });

  it('archives opt-in, paginates, survives restart and supports deletion', async () => {
    companion.archive('session', 1, 'First turn', 'Before opt-in');
    expect(await (await route('history')).json()).toEqual({ recording: false, turns: [], next: null });
    expect((await post('history', { recording: true }, 'PUT')).status).toBe(204);
    for (let n = 1; n <= 54; n++) companion.archive('session', n, 'Question ' + n, 'Reply ' + n);
    expect((await post('history', { recording: false }, 'PUT')).status).toBe(204);
    companion.archive('session', 55, 'Later', 'After opt-out');
    const first = await (await route('history')).json();
    expect(first.turns).toHaveLength(50);
    expect(first.turns[0].user).toBe('Question 54');
    const older = await (await route('history?before=' + first.next)).json();
    expect(older.next).toBeNull();
    expect(older.turns.map((turn: { user: string }) => turn.user)).toEqual([
      'Question 4', 'Question 3', 'Question 2', 'Question 1',
    ]);
    const restarted = new Companion(config, appToken, deviceId, join(directory, 'archive.sqlite'));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = createAppServer(config, undefined, undefined, restarted);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    expect((await (await route('history')).json()).turns[0].user).toBe('Question 54');
    expect((await route('history', { method: 'DELETE' })).status).toBe(204);
    expect((await (await route('history')).json()).turns).toHaveLength(0);
  });
});
