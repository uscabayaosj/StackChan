import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import net, { type AddressInfo } from 'node:net';
import { createAppServer } from '../src/server.js';
import { createCodec, type OpusCodec } from '../src/opus.js';
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

  async function start(codecFactory?: () => OpusCodec): Promise<number> {
    server = createAppServer(cfg, undefined, codecFactory);
    await new Promise<void>(r => server!.listen(0, r));
    return (server.address() as AddressInfo).port;
  }

  function rawExchange(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(payload));
      let out = '';
      sock.on('data', d => { out += d.toString(); });
      sock.on('close', () => resolve(out));
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); resolve(out); }, 2000).unref();
    });
  }

  async function postOta(port: number): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/api/ota`, { method: 'POST', body: '{}' });
    return res.status;
  }

  const hello = JSON.stringify({ type: 'hello', version: 1, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } });

  async function connectAndHello(port: number, id: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { Authorization: 'Bearer tok', 'Device-Id': id } });
    await new Promise<void>(r => ws.on('open', () => r()));
    const reply = new Promise(r => ws.once('message', () => r(null)));
    ws.send(hello);
    await reply;
    return ws;
  }

  it('creates a distinct Opus codec for every connection', async () => {
    const created: OpusCodec[] = [];
    const port = await start(() => { const c = createCodec(); created.push(c); return c; });
    const a = await connectAndHello(port, 'aa:01');
    const b = await connectAndHello(port, 'aa:02');
    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
    a.close(); b.close();
  });

  it('closes a connection with 1011 when per-connection setup throws, and keeps serving', async () => {
    const port = await start(() => { throw new Error('boom'); });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { Authorization: 'Bearer tok', 'Device-Id': 'aa:09' } });
    const closed = await new Promise<{ code: number; reason: string }>(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    expect(closed.code).toBe(1011);
    expect(closed.reason).toBe('server setup failed');
    expect(await postOta(port)).toBe(200);
  });

  it('rejects a websocket with a wrong bearer token (401)', async () => {
    const port = await start();
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: { Authorization: 'Bearer nope' } });
    await expect(new Promise((_, rej) => bad.on('error', rej))).rejects.toThrow(/401/);
  });

  it('refuses a websocket upgrade on the wrong path', async () => {
    const port = await start();
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/other`, { headers: { Authorization: 'Bearer tok' } });
    await expect(new Promise((_, rej) => bad.on('error', rej))).rejects.toThrow();
  });

  it('answers a malformed OTA body with 200 and firmware 0.0.0', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/ota`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.firmware.version).toBe('0.0.0');
  });

  it('answers 413 to an oversized OTA body', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/ota`, { method: 'POST', body: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(await postOta(port)).toBe(200);
  });

  it('survives a hostile absolute-form request line and keeps serving', async () => {
    const port = await start();
    const out = await rawExchange(port, 'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect(out).toMatch(/^HTTP\/1\.1 400/);
    expect(await postOta(port)).toBe(200);
  });

  it('survives a hostile request line on a websocket upgrade and keeps serving', async () => {
    const port = await start();
    const out = await rawExchange(port, 'GET http://[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    expect(out).not.toMatch(/101 Switching/);
    expect(await postOta(port)).toBe(200);
  });
});
