// 已知用量后通过真实 MCP 发布完整检查点，再等待停止。
console.log(JSON.stringify({ type: 'assistant', message: { id: 'before-check', usage: { input_tokens: 30, output_tokens: 12 } } }));
await import('./fake-checkpoint.mjs');
