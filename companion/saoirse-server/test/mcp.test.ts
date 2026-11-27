import { describe, it, expect } from 'vitest';
import { DeviceMcp, McpCallError } from '../src/mcp.js';

function makeTransport() {
  const sent: any[] = [];
  const logs: string[] = [];
  const timers = new Map<number, () => void>();
  let n = 0;
  return {
    sent, logs, timers,
    sendMcp: (p: object) => { sent.push(p); },
    log: (m: string) => { logs.push(m); },
    now: () => 0,
    setTimeout: (fn: () => void) => { timers.set(++n, fn); return n; },
    clearTimeout: (h: unknown) => { timers.delete(h as number); },
    fire: () => { for (const [k, fn] of [...timers]) { timers.delete(k); fn(); } },
  };
}
const ALLOW = ['self.camera.take_photo', 'self.robot.set_head_angles', 'self.robot.get_head_angles', 'self.robot.set_led_color'];
const camera = { name: 'self.camera.take_photo', description: 'Take a photo', inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } };
const reboot = { name: 'self.reboot', description: 'Reboot', inputSchema: { type: 'object', properties: {} } };

describe('DeviceMcp', () => {
  it('start: sends initialize with the vision capability, then tools/list, and keeps only allowed tools', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const started = mcp.start({ url: 'https://h/api/vision', token: 'tok' });
    expect(t.sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: { vision: { url: 'https://h/api/vision', token: 'tok' } } } });
    mcp.handle({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stack-chan' } } });
    await Promise.resolve();
    expect(t.sent[1]).toMatchObject({ id: 2, method: 'tools/list' });
    mcp.handle({ jsonrpc: '2.0', id: 2, result: { tools: [camera, reboot], nextCursor: '' } });
    await started;
    expect(mcp.tools.map(x => x.name)).toEqual(['self.camera.take_photo']);
    expect(mcp.toolSpecs()).toEqual([{ type: 'function', function: { name: 'self.camera.take_photo', description: 'Take a photo', parameters: camera.inputSchema } }]);
    expect(t.logs.at(-1)).toBe('mcp tools: self.camera.take_photo');
    expect(t.timers.size).toBe(0);
  });

  it('start without a vision url sends empty capabilities and survives a timeout', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const started = mcp.start(null, 100);
    expect(t.sent[0].params.capabilities).toEqual({});
    t.fire();
    await started;
    expect(mcp.tools).toEqual([]);
    expect(t.logs.at(-1)).toMatch(/mcp start failed: initialize timed out after 100 ms/);
  });

  it('callTool: sends tools/call and resolves with the text content', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const call = mcp.callTool('self.robot.set_head_angles', { yaw: -35, pitch: -9999, speed: 150 }, { timeoutMs: 1000 });
    expect(t.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'self.robot.set_head_angles', arguments: { yaw: -35, pitch: -9999, speed: 150 } } });
    mcp.handle({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'true' }], isError: false } });
    await expect(call).resolves.toBe('true');
  });

  it('callTool: an error reply, an isError result, a timeout and an abort all reject with McpCallError', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const a = mcp.callTool('x', {}, { timeoutMs: 10 });
    mcp.handle({ jsonrpc: '2.0', id: 1, error: { message: 'Unknown tool: x' } });
    await expect(a).rejects.toThrow('Unknown tool: x');

    const b = mcp.callTool('self.camera.take_photo', { question: 'q' }, { timeoutMs: 10 });
    mcp.handle({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Failed to capture photo' }], isError: true } });
    await expect(b).rejects.toThrow('Failed to capture photo');

    const c = mcp.callTool('x', {}, { timeoutMs: 10 });
    t.fire();
    await expect(c).rejects.toThrow(/timed out after 10 ms/);

    const ac = new AbortController();
    const d = mcp.callTool('x', {}, { timeoutMs: 10, signal: ac.signal });
    ac.abort();
    await expect(d).rejects.toBeInstanceOf(McpCallError);
    expect(t.timers.size).toBe(0);
  });

  it('ignores replies with unknown ids and requests from the robot, logging them', () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    mcp.handle({ jsonrpc: '2.0', id: 99, result: {} });
    mcp.handle({ jsonrpc: '2.0', id: 5, method: 'ping' });
    mcp.handle(null);
    expect(t.logs).toEqual(['mcp reply with unknown id ignored', 'mcp request from robot ignored: ping']);
  });

  it('dispose rejects everything in flight', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const a = mcp.callTool('x', {}, { timeoutMs: 1000 });
    mcp.dispose();
    await expect(a).rejects.toThrow('session closed');
    expect(t.timers.size).toBe(0);
  });
});

describe('DeviceMcp tool list paging', () => {
  it('follows nextCursor across pages and keeps the allowed tools from all of them', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, [...ALLOW, 'self.robot.create_reminder']);
    const started = mcp.start(null);
    mcp.handle({ jsonrpc: '2.0', id: 1, result: {} });
    await Promise.resolve();
    expect(t.sent[1].params).toEqual({});
    mcp.handle({ jsonrpc: '2.0', id: 2, result: { tools: [camera], nextCursor: 'self.robot.create_reminder' } });
    await Promise.resolve(); await Promise.resolve();
    expect(t.sent[2]).toMatchObject({ id: 3, method: 'tools/list', params: { cursor: 'self.robot.create_reminder' } });
    mcp.handle({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'self.robot.create_reminder', description: 'r', inputSchema: { type: 'object', properties: {} } }, reboot], nextCursor: '' } });
    await started;
    expect(mcp.tools.map(x => x.name)).toEqual(['self.camera.take_photo', 'self.robot.create_reminder']);
  });

  it('stops paging after a bounded number of pages, and keeps each tool once', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const started = mcp.start(null);
    mcp.handle({ jsonrpc: '2.0', id: 1, result: {} });
    for (let id = 2; id < 12; id++) {
      await Promise.resolve(); await Promise.resolve();
      if (!t.sent.some(m => m.id === id)) break;
      mcp.handle({ jsonrpc: '2.0', id, result: { tools: [camera], nextCursor: `page${id}` } });
    }
    await started;
    expect(t.sent.filter(m => m.method === 'tools/list')).toHaveLength(5);
    expect(mcp.tools.map(x => x.name)).toEqual(['self.camera.take_photo']);
  });

  it('a repeated cursor ends paging', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const started = mcp.start(null);
    mcp.handle({ jsonrpc: '2.0', id: 1, result: {} });
    await Promise.resolve();
    mcp.handle({ jsonrpc: '2.0', id: 2, result: { tools: [camera], nextCursor: 'same' } });
    await Promise.resolve(); await Promise.resolve();
    mcp.handle({ jsonrpc: '2.0', id: 3, result: { tools: [], nextCursor: 'same' } });
    await started;
    expect(t.sent.filter(m => m.method === 'tools/list')).toHaveLength(2);
  });

  it('a failed later page keeps the tools from earlier pages', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const started = mcp.start(null);
    mcp.handle({ jsonrpc: '2.0', id: 1, result: {} });
    await Promise.resolve();
    mcp.handle({ jsonrpc: '2.0', id: 2, result: { tools: [camera], nextCursor: 'more' } });
    await Promise.resolve(); await Promise.resolve();
    mcp.handle({ jsonrpc: '2.0', id: 3, error: { message: 'busy' } });
    await started;
    expect(mcp.tools.map(x => x.name)).toEqual(['self.camera.take_photo']);
    expect(t.logs.some(l => l.includes('page 2 failed, keeping earlier pages: busy'))).toBe(true);
  });
});

describe('DeviceMcp slow robot at start', () => {
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('asks for the tool list again when the first ask times out', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const started = mcp.start(null, 100);
    mcp.handle({ jsonrpc: '2.0', id: 1, result: {} });
    await tick();
    expect(mcp.loading).toBe(true);
    t.fire();
    await tick();
    expect(t.sent[2]).toMatchObject({ id: 3, method: 'tools/list', params: {} });
    expect(t.logs).toContain('mcp tools/list attempt 1 timed out, asking again');
    mcp.handle({ jsonrpc: '2.0', id: 3, result: { tools: [camera], nextCursor: '' } });
    await started;
    expect(mcp.has('self.camera.take_photo')).toBe(true);
    expect(mcp.loading).toBe(false);
  });

  it('accepts a late reply to an earlier ask', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const started = mcp.start(null, 100);
    mcp.handle({ jsonrpc: '2.0', id: 1, result: {} });
    await tick();
    t.fire();
    await tick();
    mcp.handle({ jsonrpc: '2.0', id: 2, result: { tools: [camera], nextCursor: '' } });
    await started;
    expect(t.logs).toContain('mcp late tools/list reply accepted');
    expect(mcp.tools.map(x => x.name)).toEqual(['self.camera.take_photo']);
    expect(t.timers.size).toBe(0);
  });

  it('gives up after three asks', async () => {
    const t = makeTransport();
    const mcp = new DeviceMcp(t, ALLOW);
    const started = mcp.start(null, 100);
    mcp.handle({ jsonrpc: '2.0', id: 1, result: {} });
    for (let i = 0; i < 3; i++) { await tick(); t.fire(); }
    await started;
    expect(t.sent.filter(m => m.method === 'tools/list')).toHaveLength(3);
    expect(t.logs.at(-1)).toMatch(/mcp start failed: tools\/list timed out/);
    expect(mcp.loading).toBe(false);
    expect(mcp.tools).toEqual([]);
  });
});
