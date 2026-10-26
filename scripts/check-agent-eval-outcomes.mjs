/** 离线重放已结束的评估轮次，比较当前 MCP 与模型最后一次实际收到的成果检查；不调用模型。 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { startMcp } from '../test/support/mcp-client.ts';

const root = resolve(process.argv[2] ?? 'out/agent-eval/2026-10-22-visual-feedback-0100');
const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('round.json')).sort();
assert.ok(files.length > 0, '没有已保存轮次，不能验证模型实际收到的反馈');
const summary = [];
for (const file of files) {
  const dir = dirname(join(root, file)), record = JSON.parse(await readFile(join(dir, 'round.json'), 'utf8'));
  if (record.run.endedBy !== 'success') continue;
  const events = (await readFile(join(dir, 'logs/stream.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const ids = new Set(), replies = [];
  for (const event of events) for (const block of event.message?.content ?? []) {
    if (block.type === 'tool_use' && block.name.endsWith('check_outcome')) ids.add(block.id);
    if (block.type === 'tool_result' && ids.has(block.tool_use_id) && !block.is_error) {
      const content = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content;
      for (const part of content ?? []) if (part.type === 'text') {
        try { const value = JSON.parse(part.text); if (value.verdict) replies.push(value); } catch { /* 非 JSON 文本不作为合同证据。 */ }
      }
    }
  }
  assert.ok(replies.length, `${dir} 缺少实际 check_outcome 回复，不可用宿主报告冒充`);
  const session = startMcp(['--workspace', join(dir, 'snapshot'), '--resources', record.inputs.resources,
    '--root', join(dir, 'agent'), '--outcome-context', join(dir, 'logs/outcome-context.json')]);
  try {
    await session.request('initialize', { protocolVersion: '2025-06-18' });
    const actual = await session.callJson('check_outcome');
    const expected = structuredClone(replies.at(-1)), comparable = structuredClone(actual);
    // reportId 绑定实际构建，源码/编译文件以及预算修复都会使它改变；只排除这个来源字段，不排除任何判定或明细。
    const reportIds = { model: expected.assessment.visual?.reportId, current: comparable.assessment.visual?.reportId };
    if (expected.assessment.visual) delete expected.assessment.visual.reportId;
    if (comparable.assessment.visual) delete comparable.assessment.visual.reportId;
    assert.deepEqual(comparable, expected, `${dir} 当前输出与模型收到的末次检查不同，需进一步验收`);
    summary.push({ round: relative(root, dir).replaceAll('\\', '/'), chars: JSON.stringify(actual).length, equalExceptBuildBoundReportId: true, reportIds,
      verdict: actual.verdict, comparisonsInStream: replies.length, startedBuild: JSON.parse(await readFile(join(dir, 'logs/provenance.json'), 'utf8')).engine });
  } finally { await session.close(); }
}
assert.ok(summary.length > 0, '没有成功轮次，不能声称已验证模型实际收到的反馈');
await mkdir(join(root, 'current-source-verification'), { recursive: true });
await writeFile(join(root, 'current-source-verification/summary.json'), JSON.stringify({ scope: '仅重放已保存的成功轮次，不能作为完整模型门槛结论',
  observedRounds: files.length, verifiedRounds: summary.length, rounds: summary, limit: '只排除绑定构建的 reportId，重放最后一次已保存输入；不验证模型中间候选或未覆盖的大规模输出分支' }, null, 2));
console.log(JSON.stringify(summary, null, 2));
