import { createAppServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const server = createAppServer(loadConfig());
export default server;
