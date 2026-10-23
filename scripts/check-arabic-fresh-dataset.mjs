/** 核对原图新数据集及实际基准反馈轨迹；不批准或应用数据。 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkAgentOutcome, loadWorkspace } from '../src/index.ts';

const root = resolve(process.argv[2] ?? 'out/arabic-board-retest-2026-10-23');
const original = resolve(process.argv[3] ?? 'out/arabic-board-retest-2026-10-20');
const dir = join(root, 'r2-dataset'), agentDir = join(dir, 'agent');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const round = await json(join(dir, 'round.json')); assert.equal(round.run.endedBy, 'success');
const truth = await json(join(original, 'truth.json')); assert.equal(truth.stops.length, 16); assert.equal(truth.tripMinutes, 55);
const document = await json(join(agentDir, 'candidates/ds-line12-port.json')), data = document.data;
const submission = await json(join(agentDir, 'outcome.json'));
const workspace = await loadWorkspace({ dir: join(dir, 'snapshot'), resourcesDir: join(original, 'resources') });
const contentBaseline = await json(join(dir, 'logs/content-baseline.json'));
assert.deepEqual(contentBaseline, await json(join(root, 'dataset-baseline.json')));
assert.equal(contentBaseline.items.length, 2); assert.ok(contentBaseline.items.every((item) => item.values.length === 16));
const report = await checkAgentOutcome({ task: 'dataset-extraction', agentDir, workspace, context: { definition: { name: '线路站牌', version: 1 }, contentBaseline } });
assert.equal(report.assessment.structure, 'valid'); assert.equal(report.assessment.candidates, 'valid');
assert.equal(report.verdict, 'qualified'); assert.equal(report.coverageVerification.passed, true);
const checks = [];
const eq = (path, actual, expected) => { assert.deepEqual(actual, expected, path); checks.push({ path, actual: actual ?? null, expected: expected ?? null }); };
eq('routeNo', data.routeNo, truth.routeNo); eq('stops.length', data.stops.length, 16);
for (let index = 0; index < 16; index++) {
  const stop = data.stops[index], expected = truth.stops[index], path = `stops[${index + 1}]`;
  eq(`${path}.nameAr`, stop.nameAr, expected.nameAr); eq(`${path}.nameEn`, stop.nameEn, expected.nameEn);
  eq(`${path}.transferRoutes`, [...(stop.transferRoutes ?? [])].sort(), [...(expected.otherRoutes ?? [])].sort());
  eq(`${path}.code`, stop.code, expected.stopCode); eq(`${path}.minutesFromStart`, stop.minutesFromStart, expected.cumulativeMinutes);
}
for (const key of ['tripKm', 'fareAmount', 'peakHeadwayMin', 'offPeakHeadwayMin']) eq(key, data[key], truth[key]);
eq('serviceWindows', data.serviceWindows.map((entry) => [entry.startsAt, entry.endsAt]), [truth.weekdayHours, truth.restdayHours]);
eq('peakWindows', data.peakWindows.map((entry) => [entry.startsAt, entry.endsAt]), truth.peakWindows);
eq('paymentMethods', data.paymentMethods, ['بطاقة النقل الذكية', 'الدفع اللاتلامسي']);
eq('transferWindowMin', data.transferWindowMin, truth.transferMinutes);
eq('accessibility', [...data.accessibility].sort(), ['lowFloor', 'wheelchairSpace', 'audioAnnouncement'].sort());
eq('viaNames', data.viaNames, ['الجامعة', 'دوار الساعة', 'الكورنيش']);
for (const [key, value] of Object.entries({ supportPhone: '[رقم الهاتف]', smsNumber: '[رقم الرسائل]', operatorName: '[اسم شركة النقل]', website: '[الموقع الإلكتروني]' })) eq(key, data[key], value);
for (const key of ['updatedOn', 'liveUrl', 'currentIndex', 'currency']) eq(key, data[key], undefined);
assert.equal(submission.pending.length, 1); assert.equal(submission.pending[0].path, 'currency');
assert.equal(submission.pending[0].reason, 'conflicting');
// 约束与占位冲突独立复核，不根据模型解释直接采纳。
const schema = await json(join(root, 'r1-definition/candidates/schema-sign.json'));
assert.equal(schema.fields.find((field) => field.name === 'currency').constraints.maxLength, 6);
assert.equal('[العملة]'.length, 8);
const events = (await readFile(join(dir, 'logs/stream.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
const ids = new Set(), replies = [];
for (const event of events) for (const block of event.message?.content ?? []) {
  if (block.type === 'tool_use' && block.name.endsWith('check_outcome')) ids.add(block.id);
  if (block.type === 'tool_result' && ids.has(block.tool_use_id)) for (const part of block.content ?? []) if (part.type === 'text') {
    try { const value = JSON.parse(part.text); if (value.verdict) replies.push(value); } catch { /* 非JSON不算检查记录。 */ }
  }
}
assert.ok(replies.some((reply) => reply.assessment?.coverage?.anomalies.some((item) => item.code === 'missingBusinessCoverage' && item.path === 'stops[1].minutesFromStart')));
assert.equal(replies.at(-1).verdict, 'qualified'); assert.deepEqual(replies.at(-1).assessment.coverage.anomalies, []);
const output = join(root, 'dataset-audit'); await mkdir(output, { recursive: true });
const summary = { usage: round.run, checks: checks.length, passed: checks.length, checksScope: '明确列出的原图内容与未知值，不是全图语义通过率',
  baselineValues: 32, coverage: report.coverageVerification, pending: submission.pending,
  loop: replies.map((reply) => ({ verdict: reply.verdict, problems: reply.problems, coverage: reply.assessment?.coverage })),
  limits: ['模型本轮获得独立保护基准，不能记作无基准识别成功', '货币占位与长度约束冲突仍待审核', '只有始发站缺0的纠偏由本轮实际工具轨迹证明，55读数不能据此归功于工具'] };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(join(output, 'checks.json'), JSON.stringify(checks, null, 2));
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checks: summary.checks, pending: summary.pending, coverage: summary.coverage, wallMs: round.run.wallMs, turns: round.run.turns }));
