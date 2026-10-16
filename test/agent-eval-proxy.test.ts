/**
 * 评估用协议转换代理（scripts/agent-eval/proxy.ts）：用假的上游核对 Anthropic 请求转成 OpenAI 与 Google 格式、
 * 结果拼成 Anthropic 流式事件、Gemini 的 thoughtSignature 回传与上游错误的映射。不调用真实模型。
 */
import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startProxy } from '../scripts/agent-eval/proxy.js';

const KEY = `rw-proxy-key-${Math.random().toString(36).slice(2)}`;
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
const TOOL = { name: 'view_image', description: '看图', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };

let calls: { url: string; headers: Record<string, string>; body: any }[] = [];
let replies: (() => Response)[] = [];
let proxy: { port: number; close: () => Promise<void> };

const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
  return replies.shift()!();
}) as typeof fetch;

beforeAll(async () => {
  proxy = await startProxy({ port: 0, key: KEY, base: 'https://upstream.test/go', fetch: fakeFetch });
});

afterAll(async () => {
  await proxy.close();
});

async function send(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages?beta=true`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer from-claude-code', ...headers }, body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!body['stream']) return { status: response.status, json: JSON.parse(text) };
  const events = text.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.split('\n').find((line) => line.startsWith('data: '))!.slice(6)));
  return { status: response.status, events };
}

const reply = (status: number, json: unknown) => () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

describe('OpenAI Chat Completions 格式（如 Step 5 Preview）', () => {
  it('系统提示、图片与工具结果中的图片按 OpenAI 写法转发；用上游自己的 key 与会话头；结果拼成 Anthropic 流式事件', async () => {
    calls = [];
    replies = [reply(200, {
      choices: [{ finish_reason: 'tool_calls', message: { content: '先看图。', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'view_image', arguments: '{"path":"sample.png"}' } }] } }],
      usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } },
    })];
    const { events } = await send({
      model: 'step-5-preview', stream: true, max_tokens: 32000, system: [{ type: 'text', text: '你是助手。', cache_control: { type: 'ephemeral' } }],
      tools: [TOOL], tool_choice: { type: 'auto' },
      messages: [
        { role: 'user', content: [IMAGE, { type: 'text', text: '看图' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id: 'toolu_a', name: 'view_image', input: { path: 'a.png' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: '放大图' }, IMAGE] }, { type: 'text', text: '继续' }] },
      ],
    }, { 'x-claude-code-session-id': 'session-42' });

    const call = calls[0]!;
    expect(call.url).toBe('https://upstream.test/go/openai/v1/chat/completions');
    expect(call.headers).toMatchObject({ authorization: `Bearer ${KEY}`, 'x-opencode-session': 'session-42', 'user-agent': 'renderweave-eval-proxy/0.1' });
    expect(call.body).toMatchObject({ model: 'step-5-preview', max_tokens: 32000, tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'view_image', description: '看图', parameters: TOOL.input_schema } }] });
    expect(call.body.messages).toEqual([
      { role: 'system', content: '你是助手。' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }, { type: 'text', text: '看图' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_a', type: 'function', function: { name: 'view_image', arguments: '{"path":"a.png"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_a', content: '放大图\n（结果中的 1 张图片附在下一条消息里）' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }, { type: 'text', text: '继续' }] },
    ]);

    expect(events!.map((event) => event.type)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    expect(events![0].message.usage).toMatchObject({ input_tokens: 200, cache_read_input_tokens: 800 });
    expect(events![2].delta).toEqual({ type: 'text_delta', text: '先看图。' });
    expect(events![4].content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'view_image', input: {} });
    expect(JSON.parse(events![5].delta.partial_json)).toEqual({ path: 'sample.png' });
    expect(events![7]).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } });
  });

  it('非流式请求返回 Anthropic 消息；上游 429 映射为 rate_limit_error，流式时以 error 事件给出', async () => {
    replies = [reply(200, { choices: [{ finish_reason: 'length', message: { content: '截断' } }], usage: { prompt_tokens: 5, completion_tokens: 7 } })];
    const plain = await send({ model: 'step-5-preview', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(plain).toMatchObject({ status: 200, json: { type: 'message', role: 'assistant', content: [{ type: 'text', text: '截断' }], stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 7 } } });

    replies = [reply(429, { error: 'quota exhausted' })];
    const limited = await send({ model: 'step-5-preview', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(limited).toMatchObject({ status: 429, json: { type: 'error', error: { type: 'rate_limit_error' } } });
    replies = [reply(429, { error: 'quota exhausted' })];
    const streamed = await send({ model: 'step-5-preview', stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(streamed.events).toEqual([{ type: 'error', error: { type: 'rate_limit_error', message: expect.stringContaining('上游 429') } }]);
  });
});

describe('Google generateContent 格式（如 Gemini 4 Argon）', () => {
  it('工具调用与结果转成 functionCall / functionResponse，图片作 inlineData；thoughtSignature 在下一轮补回', async () => {
    calls = [];
    replies = [reply(200, {
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
        { text: '想法', thought: true }, { text: '我来看图。' },
        { functionCall: { name: 'view_image', args: { path: 'sample.png' } }, thoughtSignature: 'sig-123' },
      ] } }],
      usageMetadata: { promptTokenCount: 3000, cachedContentTokenCount: 2000, candidatesTokenCount: 30, thoughtsTokenCount: 70 },
    })];
    const first = await send({ model: 'gemini-4-argon-contributor', stream: true, max_tokens: 64000, system: '你是助手。', tools: [TOOL],
      messages: [{ role: 'user', content: [IMAGE, { type: 'text', text: '看图' }] }] });
    expect(calls[0]!.url).toBe('https://upstream.test/go/google/v1beta/models/gemini-4-argon-contributor:generateContent');
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0]!.body).toMatchObject({
      systemInstruction: { parts: [{ text: '你是助手。' }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { text: '看图' }] }],
      tools: [{ functionDeclarations: [{ name: 'view_image', parametersJsonSchema: TOOL.input_schema }] }],
      generationConfig: { maxOutputTokens: 64000 },
    });
    const toolUse = first.events!.find((event) => event.type === 'content_block_start' && event.content_block.type === 'tool_use').content_block;
    expect(first.events![0].message.usage).toMatchObject({ input_tokens: 1000, cache_read_input_tokens: 2000 });
    expect(first.events!.find((event) => event.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 100 } });
    // 思考部分不转发给 Claude Code。
    expect(first.events!.filter((event) => event.type === 'content_block_delta' && event.delta.type === 'text_delta').map((event) => event.delta.text)).toEqual(['我来看图。']);

    replies = [reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '是绿色。' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } })];
    const second = await send({ model: 'gemini-4-argon-contributor', max_tokens: 100, tools: [TOOL], messages: [
      { role: 'user', content: '看图' },
      { role: 'assistant', content: [{ type: 'text', text: '我来看图。' }, { type: 'tool_use', id: toolUse.id, name: 'view_image', input: { path: 'sample.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: [{ type: 'text', text: '放大图' }, IMAGE] }] },
    ] });
    expect(second.json).toMatchObject({ content: [{ type: 'text', text: '是绿色。' }], stop_reason: 'end_turn' });
    expect(calls[1]!.body.contents).toEqual([
      { role: 'user', parts: [{ text: '看图' }] },
      { role: 'model', parts: [{ text: '我来看图。' }, { functionCall: { name: 'view_image', args: { path: 'sample.png' } }, thoughtSignature: 'sig-123' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'view_image', response: { content: '放大图' } } }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] },
    ]);
  });

  it('count_tokens 给出估计值；不支持的路径返回 404', async () => {
    const count = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'abcd'.repeat(100) }] }) });
    expect(((await count.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(100);
    expect((await fetch(`http://127.0.0.1:${proxy.port}/v1/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });
});

describe('只接受本机命令行的请求', () => {
  // 用 node:http 发请求，才能自己写 Host 与 Origin。
  const post = (headers: Record<string, string>) => new Promise<number>((done, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/v1/messages', headers }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    request.on('error', fail);
    request.end(JSON.stringify({ model: 'step-5-preview', max_tokens: 10, messages: [{ role: 'user', content: '你好' }] }));
  });

  it('别的 Host、带 Origin 的网页请求、非 JSON 的"简单请求"都被拒绝，不转发给上游', async () => {
    calls = [];
    expect(await post({ host: `evil.test:${proxy.port}`, 'content-type': 'application/json' })).toBe(403);
    expect(await post({ host: `127.0.0.1:${proxy.port}`, origin: 'https://evil.test', 'content-type': 'application/json' })).toBe(403);
    expect(await post({ host: `127.0.0.1:${proxy.port}`, 'content-type': 'text/plain' })).toBe(415);
    expect(calls).toEqual([]);

    replies = [reply(200, { choices: [{ finish_reason: 'stop', message: { content: '你好。' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })];
    expect(await post({ host: `localhost:${proxy.port}`, 'content-type': 'application/json' })).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
