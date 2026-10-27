import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { createAppServer } from '../src/server.js';
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
});
