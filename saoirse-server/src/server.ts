import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.js';
import { createCodec } from './opus.js';
import { transcribe } from './stt.js';
import { streamChatWithFallback, type ChatMessage } from './llm.js';
import { synthesizeToFrames } from './tts.js';
import { Session, type SessionDeps, type SessionSocket } from './session.js';
import { buildOtaResponse, deviceVersionFromBody } from './ota.js';

const histories = new Map<string, ChatMessage[]>();

export function createDeps(cfg: Config): SessionDeps {
  const codec = createCodec();
  return {
    config: cfg,
    codec,
    transcribe: (pcm) => transcribe(cfg.elevenlabs, pcm),
    chat: (messages) => streamChatWithFallback(cfg.llm, cfg.fallbackLlm, messages),
    synthesize: (text) => synthesizeToFrames(cfg.elevenlabs, text, codec),
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    log: (m) => console.log(`[session] ${m}`),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function handleOta(cfg: Config, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
  console.log(`[ota] device=${req.headers['device-id']} version=${deviceVersionFromBody(body)}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(buildOtaResponse(cfg, deviceVersionFromBody(body), new Date())));
}

export function attachWebSocket(cfg: Config, server: http.Server, deps: SessionDeps = createDeps(cfg)): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/ws') { socket.destroy(); return; }
    const auth = req.headers.authorization ?? '';
    if (cfg.deviceToken && auth !== `Bearer ${cfg.deviceToken}`) {
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
    const history = histories.get(deviceId) ?? [];
    histories.set(deviceId, history);
    const session = new Session(sock, deps, deviceId, history);
    deps.log(`connected ${deviceId}`);
    const timer = setInterval(() => session.tick(), 1000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) session.handleBinary(Buffer.from(data as Buffer));
      else void session.handleText(data.toString());
    });
    ws.on('close', () => { clearInterval(timer); session.dispose(); deps.log(`closed ${deviceId}`); });
    ws.on('error', err => deps.log(`socket error ${err.message}`));
  });
  return wss;
}

export function createAppServer(cfg: Config, deps?: SessionDeps): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/ota') { void handleOta(cfg, req, res); return; }
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('saoirse-server ok'); return; }
    res.writeHead(404); res.end();
  });
  attachWebSocket(cfg, server, deps);
  return server;
}
