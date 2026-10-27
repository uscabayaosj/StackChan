import type http from 'node:http';
import type { Config } from './config.js';

export interface MultipartFile { name: string; filename: string; contentType: string; data: Buffer }
export interface Multipart { fields: Record<string, string>; files: MultipartFile[] }

/** Boundary from a `multipart/form-data; boundary=...` header, or null. */
export function multipartBoundary(contentType: string | undefined): string | null {
  const m = /multipart\/form-data\s*;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  return m ? (m[1] ?? m[2]) : null;
}

/** Minimal multipart/form-data parser: enough for the robot's `question` + `file` upload (CRLF framing). */
export function parseMultipart(body: Buffer, boundary: string): Multipart {
  const out: Multipart = { fields: {}, files: [] };
  const delim = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    pos += delim.length;
    if (body.slice(pos, pos + 2).toString() === '--') break; // closing delimiter
    // skip the CRLF after the delimiter
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const headers = body.slice(pos, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delim, dataStart);
    if (next < 0) break;
    let dataEnd = next;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2; // CRLF before the next delimiter
    const data = body.slice(dataStart, dataEnd);
    const disp = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1] ?? '';
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const ctype = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
    if (filename !== undefined) out.files.push({ name, filename, contentType: ctype, data });
    else out.fields[name] = data.toString('utf8');
    pos = next;
  }
  return out;
}

export const VISION_SYSTEM_PROMPT =
  'You are the eyes of a small desk robot. Describe what the photo shows in two or three concrete sentences ' +
  '(people, animals, objects, text, expressions, setting), then answer the question in one sentence. No preamble.';

/** Asks the vision model about one JPEG. Returns the model's text. */
export async function describeImage(
  cfg: Config['vision'], jpeg: Buffer, question: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal,
): Promise<string> {
  const body = {
    model: cfg.model,
    max_tokens: 200,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: `Question: ${question.trim() || 'What do you see?'}` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
      ] },
    ],
  };
  const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/uscabayaosj/StackChan', 'X-Title': 'Saoirse StackChan' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`vision HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('vision model returned no text');
  return text.trim();
}

function reply(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Reads the whole request body, rejecting with 'too large' past `max` bytes. An oversized body is
 * drained rather than cut off, so the 413 reaches a client that is still uploading.
 */
export function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (tooLarge) return;
      if (size > max) { tooLarge = true; chunks = []; return; }
      chunks.push(c);
    });
    req.on('end', () => (tooLarge ? reject(new Error('too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/**
 * POST /api/vision: the robot's photo upload (multipart `question` + `file`), answered as
 * `{"success":true,"text":...}`, which the robot returns verbatim as the take_photo tool result.
 */
export async function handleVision(cfg: Config, req: http.IncomingMessage, res: http.ServerResponse, fetchImpl: typeof fetch = fetch): Promise<void> {
  const auth = req.headers.authorization ?? '';
  if (cfg.deviceToken && auth !== `Bearer ${cfg.deviceToken}`) { reply(res, 401, { success: false, message: 'unauthorized' }); return; }
  const boundary = multipartBoundary(req.headers['content-type']);
  if (!boundary) { reply(res, 400, { success: false, message: 'expected multipart/form-data' }); return; }
  let body: Buffer;
  try { body = await readBody(req, cfg.vision.maxBytes); } catch (err) {
    reply(res, (err as Error).message === 'too large' ? 413 : 400, { success: false, message: (err as Error).message });
    return;
  }
  const parts = parseMultipart(body, boundary);
  const file = parts.files.find(f => f.name === 'file') ?? parts.files[0];
  if (!file || file.data.length === 0) { reply(res, 400, { success: false, message: 'missing file part' }); return; }
  const question = parts.fields.question ?? '';
  const device = String(req.headers['device-id'] ?? '?');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.vision.timeoutMs);
  try {
    const text = await describeImage(cfg.vision, file.data, question, fetchImpl, ac.signal);
    console.log(`[vision] device=${device} ${file.data.length} bytes q="${question.slice(0, 60)}" -> ${text.length} chars`);
    reply(res, 200, { success: true, text });
  } catch (err) {
    console.warn(`[vision] device=${device} failed: ${(err as Error).message}`);
    reply(res, 502, { success: false, message: (err as Error).message });
  } finally {
    clearTimeout(timer);
  }
}
