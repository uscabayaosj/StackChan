import { getCache } from '@vercel/functions';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from '../src/config.js';
import { CloudCompanion } from '../src/cloud_companion.js';
import { prefix, send } from '../src/companion.js';

const relay = CloudCompanion.fromEnvironment(loadConfig(), process.env.VERCEL ? getCache() : undefined);

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (!relay) return send(res, 404, { error: 'The companion relay is disabled.' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.startsWith(prefix + '/')
    ? url.pathname.slice(prefix.length)
    : '/' + (url.searchParams.get('route') ?? '');
  return relay.handle(req, res, route);
}
