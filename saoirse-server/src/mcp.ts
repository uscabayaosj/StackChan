import type { ToolSpec } from './llm.js';

/** A tool the robot advertises over MCP (`tools/list`). `inputSchema` is JSON Schema, passed to the LLM unchanged. */
export interface DeviceTool { name: string; description: string; inputSchema: unknown }

export interface McpTransport {
  /** Sends one xiaozhi `mcp` frame: `{type:'mcp', session_id, payload}`. */
  sendMcp(payload: object): void;
  log(msg: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CallOptions { timeoutMs: number; signal?: AbortSignal }

/** Error from a `tools/call`: the robot's `error.message`, an `isError` result, a timeout or an abort. */
export class McpCallError extends Error {}

interface Pending { resolve(v: any): void; reject(e: Error): void; timer: unknown; onAbort?: () => void; signal?: AbortSignal }

/**
 * MCP client for one robot session. The server initiates (`initialize`, `tools/list`, `tools/call`);
 * replies are matched by JSON-RPC id. The robot never sends requests of its own today; any are ignored.
 */
export class DeviceMcp {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private _tools: DeviceTool[] = [];
  private allow: Set<string>;

  constructor(private readonly t: McpTransport, allowedTools: string[]) {
    this.allow = new Set(allowedTools);
  }

  /** Tools the robot advertised that are on the allow list (empty until `tools/list` has been answered). */
  get tools(): DeviceTool[] { return this._tools; }

  /** OpenAI function tools for the LLM. */
  toolSpecs(): ToolSpec[] {
    return this._tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  }

  /** Tell the robot where to upload photos, then ask for its tools. Resolves when the tool list is in (or fails). */
  async start(vision: { url: string; token: string } | null, timeoutMs = 8_000): Promise<void> {
    const capabilities: Record<string, unknown> = vision ? { vision } : {};
    try {
      await this.request('initialize', { protocolVersion: '2024-11-05', capabilities, clientInfo: { name: 'saoirse-server', version: '1' } }, { timeoutMs });
      const res = await this.request('tools/list', {}, { timeoutMs });
      const list = Array.isArray(res?.tools) ? res.tools : [];
      this._tools = list
        .filter((x: any) => x && typeof x.name === 'string' && this.allow.has(x.name))
        .map((x: any) => ({ name: x.name, description: typeof x.description === 'string' ? x.description : '', inputSchema: x.inputSchema ?? { type: 'object', properties: {} } }));
      this.t.log(`mcp tools: ${this._tools.map(t => t.name).join(', ') || '(none)'}`);
    } catch (err) {
      this.t.log(`mcp start failed: ${(err as Error).message}`);
    }
  }

  /** Runs a tool on the robot and returns the text of its result. */
  async callTool(name: string, args: Record<string, unknown>, opts: CallOptions): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args }, opts);
    if (res?.isError) throw new McpCallError(textOf(res) || 'tool reported an error');
    return textOf(res);
  }

  /** Feed every incoming `mcp` payload here. */
  handle(payload: any): void {
    if (!payload || typeof payload !== 'object') return;
    const id = payload.id;
    if (typeof id !== 'number' || !this.pending.has(id)) {
      if (payload.method) this.t.log(`mcp request from robot ignored: ${payload.method}`);
      else this.t.log(`mcp reply with unknown id ignored`);
      return;
    }
    const p = this.pending.get(id)!;
    this.settle(id, p);
    if (payload.error) p.reject(new McpCallError(String(payload.error.message ?? 'mcp error')));
    else p.resolve(payload.result);
  }

  /** Rejects everything in flight (socket closed). */
  dispose(): void {
    for (const [id, p] of [...this.pending]) { this.settle(id, p); p.reject(new McpCallError('session closed')); }
  }

  private request(method: string, params: object, opts: CallOptions): Promise<any> {
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = this.t.setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.settle(id, p);
        reject(new McpCallError(`${method} timed out after ${opts.timeoutMs} ms`));
      }, opts.timeoutMs);
      const p: Pending = { resolve, reject, timer, signal: opts.signal };
      if (opts.signal) {
        if (opts.signal.aborted) { this.t.clearTimeout(timer); reject(new McpCallError('aborted')); return; }
        p.onAbort = () => { if (this.pending.has(id)) { this.settle(id, p); reject(new McpCallError('aborted')); } };
        opts.signal.addEventListener('abort', p.onAbort, { once: true });
      }
      this.pending.set(id, p);
      this.t.sendMcp({ jsonrpc: '2.0', id, method, params });
    });
  }

  private settle(id: number, p: Pending): void {
    this.pending.delete(id);
    this.t.clearTimeout(p.timer);
    if (p.onAbort && p.signal) p.signal.removeEventListener('abort', p.onAbort);
  }
}

function textOf(result: any): string {
  const c = result?.content;
  if (Array.isArray(c)) return c.filter((x: any) => x?.type === 'text' && typeof x.text === 'string').map((x: any) => x.text).join('\n');
  if (typeof result === 'string') return result;
  return result == null ? '' : JSON.stringify(result);
}
