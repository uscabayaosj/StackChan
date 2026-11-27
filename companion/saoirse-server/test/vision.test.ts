import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseMultipart, multipartBoundary, describeImage, handleVision } from '../src/vision.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', PUBLIC_WS_URL: 'wss://h/api/ws', SAOIRSE_DEVICE_TOKEN: 'tok', VISION_MAX_BYTES: '5000' });
const B = '----ESP32_CAMERA_BOUNDARY';
function robotBody(question: string, jpeg: Buffer): Buffer {
  // Exactly how the firmware frames it (stackchan_camera.cc): question part, file part, closing delimiter.
  return Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="question"\r\n\r\n${question}\r\n`),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="camera.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpeg,
    Buffer.from(`\r\n--${B}--\r\n`),
  ]);
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0xff, 0xd9]); // binary incl. CRLF and "--" bytes

describe('multipart', () => {
  it('reads the boundary from the content-type', () => {
    expect(multipartBoundary(`multipart/form-data; boundary=${B}`)).toBe(B);
    expect(multipartBoundary('multipart/form-data; charset=utf-8; boundary="a b"')).toBe('a b');
    expect(multipartBoundary('application/json')).toBeNull();
    expect(multipartBoundary(undefined)).toBeNull();
  });
  it('parses the robot upload: question field and binary file, bytes intact', () => {
    const m = parseMultipart(robotBody('what is this?', jpeg), B);
    expect(m.fields).toEqual({ question: 'what is this?' });
    expect(m.files).toHaveLength(1);
    expect(m.files[0]).toMatchObject({ name: 'file', filename: 'camera.jpg', contentType: 'image/jpeg' });
    expect(Buffer.compare(m.files[0].data, jpeg)).toBe(0);
  });
  it('parses parts in the other order and an empty question', () => {
    const body = Buffer.concat([
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="c.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpeg,
      Buffer.from(`\r\n--${B}\r\nContent-Disposition: form-data; name="question"\r\n\r\n\r\n--${B}--\r\n`),
    ]);
    const m = parseMultipart(body, B);
    expect(m.fields.question).toBe('');
    expect(Buffer.compare(m.files[0].data, jpeg)).toBe(0);
  });
});

describe('describeImage', () => {
  it('sends the model the question and the JPEG as a data url and returns the text', async () => {
    let captured: any;
    const fetchImpl = (async (url: string, init: any) => {
      captured = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: ' A cat on a desk. ' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await describeImage(cfg.vision, jpeg, 'what is this?', fetchImpl);
    expect(text).toBe('A cat on a desk.');
    expect(captured.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(captured.init.body);
    expect(body.model).toBe('google/gemini-3.5-flash-lite');
    expect(body.messages[1].content[0]).toEqual({ type: 'text', text: 'Question: what is this?' });
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    expect(captured.init.headers.Authorization).toBe('Bearer k');
  });
  it('throws on a non-2xx and on an empty answer', async () => {
    await expect(describeImage(cfg.vision, jpeg, 'q', (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch)).rejects.toThrow(/vision HTTP 500/);
    await expect(describeImage(cfg.vision, jpeg, 'q', (async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }))) as unknown as typeof fetch)).rejects.toThrow(/no text/);
  });
});

describe('POST /api/vision', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));
  async function start(fetchImpl: typeof fetch): Promise<string> {
    server = http.createServer((req, res) => { void handleVision(cfg, req, res, fetchImpl); });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/vision`;
  }
  const modelOk = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'A cat.' } }] }), { status: 200 })) as unknown as typeof fetch;
  const post = (url: string, body: Buffer, headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${B}`, ...headers }, body: new Uint8Array(body) });

  it('answers the robot upload with {success:true,text} when the token matches', async () => {
    const url = await start(modelOk);
    const r = await post(url, robotBody('what is on the desk?', jpeg), { Authorization: 'Bearer tok', 'Device-Id': 'aa:bb' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ success: true, text: 'A cat.' });
  });
  it('rejects a wrong or missing token', async () => {
    const url = await start(modelOk);
    expect((await post(url, robotBody('q', jpeg), { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(url, robotBody('q', jpeg), {})).status).toBe(401);
  });
  it('400 without a file part or a multipart body, 413 over the size cap, 502 when the model fails', async () => {
    const url = await start((async () => new Response('x', { status: 503 })) as unknown as typeof fetch);
    const noFile = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="question"\r\n\r\nq\r\n--${B}--\r\n`);
    expect((await post(url, noFile, { Authorization: 'Bearer tok' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await post(url, robotBody('q', Buffer.alloc(6000, 1)), { Authorization: 'Bearer tok' })).status).toBe(413);
    const r = await post(url, robotBody('q', jpeg), { Authorization: 'Bearer tok' });
    expect(r.status).toBe(502);
    expect((await r.json()).success).toBe(false);
  });
});
