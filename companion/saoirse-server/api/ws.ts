import { getCache } from '@vercel/functions';
import { createAppServer } from '../src/server.js';
import { CloudCompanion } from '../src/cloud_companion.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
const server = createAppServer(cfg, undefined, undefined, CloudCompanion.fromEnvironment(cfg, process.env.VERCEL ? getCache() : undefined));
export default server;
