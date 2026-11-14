import { describe, it, expect } from 'vitest';
import { streamChatEvents, streamChatEventsWithFallback, LlmHttpError, type ChatEvent, type ToolSpec } from '../src/llm.js';

function sse(lines: string[]): Response {
  const body = lines.map(l => `data: ${l}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const cfg = { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', maxTokens: 400, reasoningEffort: 'none' as const };
const tools: ToolSpec[] = [{ type: 'function', function: { name: 'self.camera.take_photo', description: 'd', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } }];
async function collect(gen: AsyncGenerator<ChatEvent>) { const out: ChatEvent[] = []; for await (const e of gen) out.push(e); return out; }

describe('streamChatEvents with tools', () => {
  it('sends the tools and assembles a tool call whose arguments arrive in fragments', async () => {
    let body: any;
    const fetchImpl = (async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return sse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'self_camera_take_photo', arguments: '' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"question": "what ' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'is on the desk?"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;
    const events = await collect(streamChatEvents(cfg, [{ role: 'user', content: 'look' }], fetchImpl, { tools }));
    expect(body.tools[0].function.name).toBe('self_camera_take_photo');
    expect(body.tool_choice).toBe('auto');
    expect(events).toEqual([{ type: 'tool_calls', calls: [{ id: 'call_1', name: 'self.camera.take_photo', arguments: '{"question": "what is on the desk?"}' }] }]);
  });

  it('yields text first and the tool calls once at the end, in index order, with ids filled in', async () => {
    const fetchImpl = (async () => sse([
      JSON.stringify({ choices: [{ delta: { content: '[neutral] Fine. ' } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'self.robot.set_led_color', arguments: '{"red":168,"green":0,"blue":0}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'self.robot.set_head_angles', arguments: '{"yaw":-35}' } }] } }] }),
      '[DONE]',
    ])) as unknown as typeof fetch;
    const events = await collect(streamChatEvents(cfg, [{ role: 'user', content: 'x' }], fetchImpl, { tools }));
    expect(events[0]).toEqual({ type: 'text', text: '[neutral] Fine. ' });
    expect(events[1]).toEqual({ type: 'tool_calls', calls: [
      { id: 'a', name: 'self.robot.set_head_angles', arguments: '{"yaw":-35}' },
      { id: 'call_1', name: 'self.robot.set_led_color', arguments: '{"red":168,"green":0,"blue":0}' },
    ] });
  });

  it('does not send tools when none are offered, and a stream with neither text nor calls is still a 502', async () => {
    let body: any;
    const fetchImpl = (async (_u: string, init: any) => { body = JSON.parse(init.body); return sse([JSON.stringify({ choices: [{ delta: { reasoning: 'hmm' } }] }), '[DONE]']); }) as unknown as typeof fetch;
    await expect(collect(streamChatEvents(cfg, [{ role: 'user', content: 'x' }], fetchImpl))).rejects.toBeInstanceOf(LlmHttpError);
    expect(body.tools).toBeUndefined();
  });

  it('falls back after a blank primary stream and decodes the fallback tool alias', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.model === 'm') return sse(['{"choices":[{"delta":{"content":" "}}]}', '[DONE]']);
      expect(body.tools[0].function.name).toBe('self_camera_take_photo');
      return sse([JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'camera', function: {
        name: 'self_camera_take_photo', arguments: '{}',
      } }] } }] }), '[DONE]']);
    }) as typeof fetch;
    const events = await collect(streamChatEventsWithFallback(cfg, { ...cfg, model: 'fb' }, [{ role: 'user', content: 'look' }], fetchImpl, { tools }));
    expect(events).toEqual([{ type: 'tool_calls', calls: [{ id: 'camera', name: 'self.camera.take_photo', arguments: '{}' }] }]);
  });

  it('a tool-calls-only stream counts as content for the fallback policy (no fallback after it)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return sse([JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 't', arguments: '{}' } }] } }] }), '[DONE]']);
    }) as unknown as typeof fetch;
    const events = await collect(streamChatEventsWithFallback(cfg, { ...cfg, model: 'fb' }, [{ role: 'user', content: 'x' }], fetchImpl, { tools }));
    expect(events).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('accepts assistant tool_calls and tool messages in the history it sends', async () => {
    let body: any;
    const fetchImpl = (async (_u: string, init: any) => { body = JSON.parse(init.body); return sse([JSON.stringify({ choices: [{ delta: { content: 'A cat.' } }] }), '[DONE]']); }) as unknown as typeof fetch;
    await collect(streamChatEvents(cfg, [
      { role: 'user', content: 'what do you see' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'self.camera.take_photo', arguments: '{"question":"what is here?"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'A cat on a desk.' },
    ], fetchImpl, { tools }));
    expect(body.messages[1].tool_calls[0].id).toBe('c1');
    expect(body.messages[1].tool_calls[0].function.name).toBe('self_camera_take_photo');
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'A cat on a desk.' });
  });
});


describe('direct Anthropic Messages API', () => {
  const direct = { ...cfg, protocol: 'anthropic' as const, model: 'claude-haiku-5-5' };

  it('disables thinking, streams tool arguments and sends results back in a user turn', async () => {
    const event = (type: string, fields: object = {}) => JSON.stringify({ type, ...fields });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://llm.test/v1/messages');
      expect(new Headers(init.headers).get('x-api-key')).toBe('k');
      expect(new Headers(init.headers).get('anthropic-version')).toBe('2023-06-01');
      const body = JSON.parse(String(init.body));
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.system).toBe('Be concise');
      expect(body.tools[0]).toEqual({ name: 'self_camera_take_photo', description: 'd', input_schema: tools[0].function.parameters });
      if (body.messages.length === 1) return sse([
        event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'self_camera_take_photo', input: {} } }),
        event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"question":' } }),
        event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"what is there?"}' } }),
        event('message_stop'),
      ]);
      expect(body.messages[1]).toEqual({ role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_1', name: 'self_camera_take_photo', input: { question: 'what is there?' } },
      ] });
      expect(body.messages[2]).toEqual({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'A cat on a desk.' },
      ] });
      return sse([
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '[neutral] A cat.' } }),
        event('message_stop'),
      ]);
    }) as typeof fetch;
    const history = [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'look' }] as const;
    expect(await collect(streamChatEvents(direct, [...history], fetchImpl, { tools }))).toEqual([
      { type: 'tool_calls', calls: [{ id: 'toolu_1', name: 'self.camera.take_photo', arguments: '{"question":"what is there?"}' }] },
    ]);
    expect(await collect(streamChatEvents(direct, [...history, {
      role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: {
        name: 'self.camera.take_photo', arguments: '{"question":"what is there?"}',
      } }],
    }, { role: 'tool', tool_call_id: 'toolu_1', content: 'A cat on a desk.' }], fetchImpl, { tools }))).toEqual([
      { type: 'text', text: '[neutral] A cat.' },
    ]);
  });

  it('falls back if Anthropic disconnects before a streamed tool call is complete', async () => {
    const fetchImpl = (async (url: string) => url.endsWith('/messages') ? sse([
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"test","input":{}}}',
    ]) : sse(['{"choices":[{"delta":{"content":"Fallback reply."}}]}', '[DONE]'])) as typeof fetch;
    expect(await collect(streamChatEventsWithFallback(direct, cfg, [{ role: 'user', content: 'test' }], fetchImpl))).toEqual([
      { type: 'text', text: 'Fallback reply.' },
    ]);
  });
});
