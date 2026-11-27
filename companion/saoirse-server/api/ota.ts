import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleOta } from '../src/server.js';
import { CloudCompanion } from '../src/cloud_companion.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const companion = CloudCompanion.fromEnvironment(cfg);
export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  return handleOta(cfg, req, res, companion);
}
