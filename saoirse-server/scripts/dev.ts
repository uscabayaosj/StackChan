import { readFileSync, existsSync } from 'node:fs';
import { createAppServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

if (existsSync('.env.local')) {
  for (const raw of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    // An already-set variable (even an empty string) wins over the file: the shell is authoritative.
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
const cfg = loadConfig();
const port = Number(process.env.PORT ?? 8765);
createAppServer(cfg).listen(port, '0.0.0.0', () => {
  console.log(`saoirse-server listening on http://0.0.0.0:${port}  (OTA: POST /api/ota, WS: /api/ws)`);
  console.log(`robot OTA URL to configure: http://<this-mac-ip>:${port}/api/ota`);
});
