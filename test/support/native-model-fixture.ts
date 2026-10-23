/** 本机模型协议夹具：仅发预登记工具调用，实际权限判断由未修改的 Claude CLI 执行。 */
import { createServer } from 'node:http';
export interface NativeTool { name: string; input: Record<string, unknown> }
export async function nativeModelFixture(plan: readonly (readonly NativeTool[])[], failure?: string) {
  const requests: any[] = [];
  let turn = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    let body: any;
    try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
    if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":100}'); return; }
    requests.push(body);
    if (failure) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: failure } })); return; }
    const tools = plan[turn++] ?? [];
    const content = tools.length ? tools.map((tool, i) => ({ type: 'tool_use', id: `tool_${turn}_${i}`, ...tool })) : [{ type: 'text', text: '受控协议计划已结束。' }];
    const reason = tools.length ? 'tool_use' : 'end_turn';
    const message = { id: `msg_test_${turn}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
    if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (name: string, data: unknown) => response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    content.forEach((block: any, index: number) => {
      event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
      event('content_block_stop', { type: 'content_block_stop', index });
    });
    event('message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 20 } });
    event('message_stop', { type: 'message_stop' }); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('没有本机测试端口');
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}