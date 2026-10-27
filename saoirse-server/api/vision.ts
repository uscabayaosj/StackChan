import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVision } from '../src/vision.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  return handleVision(cfg, req, res);
}
