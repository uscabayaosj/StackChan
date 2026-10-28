import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.js';
import { createCodec, type OpusCodec } from './opus.js';
import { transcribe } from './stt.js';
import { streamChatEventsWithFallback, type ChatMessage } from './llm.js';
import { synthesizeToFrames } from './tts.js';
import { handleVision } from './vision.js';
import { createServerTools } from './server_tools.js';
import { bearerMatches, secretMatches } from './auth.js';
import { Session, type SessionDeps, type SessionSocket } from './session.js';
import { callWithDeadline, streamWithDeadline } from './deadline.js';
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

/**
 * Build session deps. The Opus codec is stateful per stream, so pass a codec owned by one connection.
 * Every upstream call gets the turn's signal (barge-in / socket close) combined with its own deadline:
 * STT per request, the LLM for the whole stream, TTS per sentence.
 */
export function createDeps(cfg: Config, codec: OpusCodec = createCodec(), fetchImpl: typeof fetch = fetch): SessionDeps {
  return {
    config: cfg,
    codec,
    serverTools: createServerTools(cfg, fetchImpl),
    transcribe: (pcm, signal) =>
      callWithDeadline('STT', cfg.sttTimeoutMs, signal, s => transcribe(cfg.elevenlabs, pcm, fetchImpl, { signal: s })),
    chat: (messages, signal, tools) =>
      streamWithDeadline('LLM', cfg.llmTimeoutMs, signal, s => streamChatEventsWithFallback(cfg.llm, cfg.fallbackLlm, messages, fetchImpl, { signal: s, tools })),
    synthesize: (text, signal) =>
      streamWithDeadline('TTS', cfg.ttsTimeoutMs, signal, s => synthesizeToFrames(cfg.elevenlabs, text, codec, fetchImpl, { signal: s })),
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log: sharedLog,
  };
}

/** Request path, or null when the request target is not parseable (hostile absolute-form etc). */
function safePathname(req: http.IncomingMessage): string | null {
  try { return new URL(req.url ?? '/', 'http://localhost').pathname; } catch { return null; }
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
  // The OTA reply hands out the WebSocket token, so the robot must present the shared secret from its URL.
  if (cfg.otaSecret) {
    let k = '';
    try { k = new URL(req.url ?? '/', 'http://localhost').searchParams.get('k') ?? ''; } catch { /* hostile url: no secret */ }
    if (!secretMatches(k, cfg.otaSecret)) {
      console.warn(`[ota] refused device=${req.headers['device-id']}: missing or wrong secret`);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
  }
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
  // 16 KiB is far above any protocol frame (Opus packets are ~200 bytes, JSON a few hundred); ws defaults to 100 MiB.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
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
    // Only a codec this connection created is ours to free; injected shared deps own theirs.
    let codec: OpusCodec | undefined;
    try {
      // Codec creation can throw (e.g. the opus wasm missing from a bundle); that must only cost this socket.
      if (!sharedDeps) codec = codecFactory();
      deps = sharedDeps ?? createDeps(cfg, codec);
      // A client without a Device-Id gets no shared memory: 'unknown' would mix unrelated callers.
      session = new Session(sock, deps, deviceId, deviceId === 'unknown' ? [] : historyFor(deviceId));
    } catch (err) {
      codec?.dispose?.();
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
    ws.on('close', () => {
      clearInterval(timer);
      session.dispose();
      deps.log(`closed ${deviceId}`);
      // Free the codec once the cancelled turn has unwound, so it is not freed under a running encode.
      void session.drain().finally(() => codec?.dispose?.());
    });
  });
  return wss;
}

export function createAppServer(cfg: Config, deps?: SessionDeps, codecFactory?: () => OpusCodec): http.Server {
  if (!cfg.deviceToken) console.warn('[server] SAOIRSE_DEVICE_TOKEN is empty: /api/ws accepts any client (auth off)');
  if (!cfg.otaSecret) console.warn('[server] OTA_SECRET is empty: /api/ota hands the WebSocket token to any caller');
  const server = http.createServer((req, res) => {
    const pathname = safePathname(req);
    if (pathname === null) { res.writeHead(400, { Connection: 'close' }); res.end(); return; }
    if (req.method === 'POST' && pathname === '/api/ota') { void handleOta(cfg, req, res); return; }
    if (req.method === 'POST' && pathname === '/api/vision') { void handleVision(cfg, req, res); return; }
    if (req.method === 'GET' && pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('saoirse-server ok'); return; }
    res.writeHead(404); res.end();
  });
  attachWebSocket(cfg, server, deps, codecFactory);
  return server;
}
