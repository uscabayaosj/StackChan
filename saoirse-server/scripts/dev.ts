import { readFileSync, existsSync } from 'node:fs';
import { createAppServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const cfg = loadConfig();
const port = Number(process.env.PORT ?? 8765);
createAppServer(cfg).listen(port, '0.0.0.0', () => {
  console.log(`saoirse-server listening on http://0.0.0.0:${port}  (OTA: POST /api/ota, WS: /api/ws)`);
  console.log(`robot OTA URL to configure: http://<this-mac-ip>:${port}/api/ota`);
});
