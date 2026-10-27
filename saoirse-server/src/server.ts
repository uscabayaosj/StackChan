import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.js';
import { createCodec, type OpusCodec } from './opus.js';
import { transcribe } from './stt.js';
import { streamChatWithFallback, type ChatMessage } from './llm.js';
import { synthesizeToFrames } from './tts.js';
import { Session, type SessionDeps, type SessionSocket } from './session.js';
import { buildOtaResponse, deviceVersionFromBody } from './ota.js';

/** Conversation history per device id, bounded: oldest-inserted device is evicted first. */
const MAX_HISTORIES = 32;
const histories = new Map<string, ChatMessage[]>();

function historyFor(deviceId: string): ChatMessage[] {
  let h = histories.get(deviceId);
  if (h) {
    // Refresh recency so an active device is never the eviction victim.
    histories.delete(deviceId);
    histories.set(deviceId, h);
    return h;
  }
  h = [];
  histories.set(deviceId, h);
  while (histories.size > MAX_HISTORIES) {
    const oldest = histories.keys().next().value;
    if (oldest === undefined) break;
    histories.delete(oldest);
  }
  return h;
}

const sharedLog = (m: string): void => console.log(`[session] ${m}`);

/** Build session deps. The Opus codec is stateful per stream, so pass a codec owned by one connection. */
export function createDeps(cfg: Config, codec: OpusCodec = createCodec()): SessionDeps {
  return {
    config: cfg,
    codec,
    transcribe: (pcm) => transcribe(cfg.elevenlabs, pcm),
    chat: (messages) => streamChatWithFallback(cfg.llm, cfg.fallbackLlm, messages),
    synthesize: (text) => synthesizeToFrames(cfg.elevenlabs, text, codec),
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log: sharedLog,
  };
}

/** Request path, or null when the request target is not parseable (hostile absolute-form etc). */
function safePathname(req: http.IncomingMessage): string | null {
  try { return new URL(req.url ?? '/', 'http://localhost').pathname; } catch { return null; }
}

/** Constant-time check of an Authorization header against the expected bearer token. */
function bearerMatches(header: string, token: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { chunks.length = 0; reject(new BodyTooLargeError()); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleOta(cfg: Config, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('payload too large', () => req.destroy());
      return;
    }
    /* malformed JSON: treat as an empty body */
  }
  console.log(`[ota] device=${req.headers['device-id']} version=${deviceVersionFromBody(body)}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildOtaResponse(cfg, deviceVersionFromBody(body), new Date())));
}

/**
 * Attach the /api/ws upgrade handler. Unless `sharedDeps` is injected (tests), every connection
 * gets its own deps and therefore its own Opus codec from `codecFactory`.
 */
export function attachWebSocket(
  cfg: Config,
  server: http.Server,
  sharedDeps?: SessionDeps,
  codecFactory: () => OpusCodec = createCodec,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    // A client reset between our 401 write and destroy() would otherwise be an unhandled 'error'.
    socket.on('error', () => {});
    const pathname = safePathname(req);
    if (pathname !== '/api/ws') { socket.destroy(); return; }
    const auth = req.headers.authorization ?? '';
    if (cfg.deviceToken && !bearerMatches(auth, cfg.deviceToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const deviceId = String(req.headers['device-id'] ?? 'unknown');
    const sock: SessionSocket = {
      sendText: j => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(j)); },
      sendBinary: b => { if (ws.readyState === ws.OPEN) ws.send(b, { binary: true }); },
      close: () => ws.close(),
      get isOpen() { return ws.readyState === ws.OPEN; },
    };
    const log = sharedDeps?.log ?? sharedLog;
    // Attach first so an early socket error can never be an unhandled 'error' event.
    ws.on('error', err => log(`socket error ${err.message}`));
    let deps: SessionDeps;
    let session: Session;
    try {
      // Codec creation can throw (e.g. the opus wasm missing from a bundle); that must only cost this socket.
      deps = sharedDeps ?? createDeps(cfg, codecFactory());
      session = new Session(sock, deps, deviceId, historyFor(deviceId));
    } catch (err) {
      log(`setup failed for ${deviceId}: ${err instanceof Error ? err.message : String(err)}`);
      try { ws.close(1011, 'server setup failed'); } catch { /* socket already gone */ }
      return;
    }
    deps.log(`connected ${deviceId}`);
    const timer = setInterval(() => session.tick(), 1000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) session.handleBinary(Buffer.from(data as Buffer));
      else void session.handleText(data.toString());
    });
    ws.on('close', () => { clearInterval(timer); session.dispose(); deps.log(`closed ${deviceId}`); });
  });
  return wss;
}

export function createAppServer(cfg: Config, deps?: SessionDeps, codecFactory?: () => OpusCodec): http.Server {
  const server = http.createServer((req, res) => {
    const pathname = safePathname(req);
    if (pathname === null) { res.writeHead(400, { Connection: 'close' }); res.end(); return; }
    if (req.method === 'POST' && pathname === '/api/ota') { void handleOta(cfg, req, res); return; }
    if (req.method === 'GET' && pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('saoirse-server ok'); return; }
    res.writeHead(404); res.end();
  });
  attachWebSocket(cfg, server, deps, codecFactory);
  return server;
}
