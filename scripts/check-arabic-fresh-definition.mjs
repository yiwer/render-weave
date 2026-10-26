/** 独立核对原图的新首次定义；保留数值误读，不审核应用、不调用模型。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkAgentOutcome, loadWorkspace } from '../src/index.ts';

const root = resolve(process.argv[2] ?? 'out/arabic-board-retest-2026-10-23');
const original = resolve(process.argv[3] ?? 'out/arabic-board-retest-2026-10-20');
const dir = join(root, 'r1-definition'), agentDir = join(dir, 'agent');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const record = await json(join(dir, 'round.json'));
assert.equal(record.run.endedBy, 'success');
const truth = await json(join(original, 'truth.json'));
assert.equal(truth.stops.length, 16, '本原图必须有16站，不能以空事实基准通过');
assert.equal(truth.tripMinutes, 55);
assert.equal(truth.stops[5].cumulativeMinutes, 24);
assert.equal(truth.stops[15].cumulativeMinutes, 55);
assert.equal(truth.stops[5].stopCode, '2048');
assert.deepEqual(truth.stops.flatMap((entry, index) => entry.cumulativeMinutes === undefined ? [index + 1] : []), [2, 3, 4, 5]);
assert.equal(truth.stops.filter((entry) => entry.stopCode === undefined).length, 15);
const submission = await json(join(agentDir, 'outcome.json'));
const stop = await json(join(agentDir, 'candidates/schema-stop.json'));
const sign = await json(join(agentDir, 'candidates/schema-sign.json'));
const field = (definition, name) => definition.fields.find((entry) => entry.name === name);
assert.equal(stop.name, '站点'); assert.equal(sign.name, '线路站牌');
assert.ok(field(stop, 'code')); assert.notEqual(field(stop, 'code').constraints?.required, true);
assert.equal(submission.coverage.find((entry) => entry.id === 'stopCode').sampleOmissions, 15);
for (const name of ['peakWindows', 'paymentMethods', 'transferWindowMin', 'currency', 'liveUrl']) assert.ok(field(sign, name), name);
assert.notEqual(field(sign, 'liveUrl').constraints?.required, true);
assert.ok(submission.pending.some((entry) => entry.path === 'liveUrl'));
assert.equal(field(sign, 'destinationName'), undefined);
assert.equal(field(sign, 'destinationNameEn'), undefined);
assert.equal(field(sign, 'tripMinutes'), undefined);
assert.equal(submission.coverage.find((entry) => entry.id === 'destination').kind, 'derived');
const baseline = { name: '原图首次定义的独立结构事实', items: [
  { id: 'stopCode', label: '仅本站有站码', definition: '站点', field: 'code', sampleOmissions: 15, mustBeOptionalIfPartial: true },
  ...['peakWindows', 'paymentMethods', 'transferWindowMin', 'currency'].map((name) => ({ id: name, label: name, definition: '线路站牌', field: name, allowConstantWithoutBrief: false })),
  { id: 'destination', label: '终点来自末站', definition: '线路站牌', field: 'destinationName', expectedKind: 'derived', derivableFrom: 'stops[last].nameAr' },
] };
const workspace = await loadWorkspace({ dir: join(dir, 'snapshot'), resourcesDir: join(original, 'resources') });
const report = await checkAgentOutcome({ task: 'definition-extraction', agentDir, workspace, context: { contentBaseline: baseline } });
assert.equal(report.assessment.structure, 'valid');
assert.equal(report.assessment.candidates, 'valid');
assert.equal(report.verdict, 'qualified');
assert.equal(report.coverageVerification.anomalies.filter((entry) => entry.level === 'severe').length, 0);
const scratch = await json(join(agentDir, 'scratch/dataset-draft.json'));
const scratchMinuteErrors = truth.stops.flatMap((entry, index) => {
  const actual = scratch.data.stops[index]?.minutesFromStart;
  return actual === entry.cumulativeMinutes ? [] : [{ path: `stops[${index + 1}].minutesFromStart`, expected: entry.cumulativeMinutes ?? null, actual: actual ?? null }];
});
const datasetBaseline = { name: '原图累计分钟与站码：图上值及独立推导，未读模型草稿作真值', items: [
  { id: 'minutesFromStart', label: '累计分钟：全程55、本站24=55−31，2–5站未知', values: truth.stops.map((entry, index) => ({ path: `stops[${index + 1}].minutesFromStart`, ...(entry.cumulativeMinutes === undefined ? { unknown: true } : { value: entry.cumulativeMinutes }) })) },
  { id: 'stopCode', label: '仅第6站有编号2048，其余15站未知', values: truth.stops.map((entry, index) => ({ path: `stops[${index + 1}].code`, ...(entry.stopCode === undefined ? { unknown: true } : { value: entry.stopCode }) })) },
] };
const logs = (await readFile(join(dir, 'logs/tools.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
const output = join(root, 'definition-audit'); await mkdir(output, { recursive: true });
const summary = { usage: record.run, structuralChecksPassed: true, coverage: report.coverageVerification, scratchMinuteErrors,
  sourceSha256: createHash('sha256').update(await readFile(join(original, 'truth.json'))).digest('hex'),
  tools: { calls: logs.length, errors: logs.filter((entry) => entry.isError).length, outcomeVerdicts: logs.filter((entry) => entry.tool === 'check_outcome').map((entry) => entry.verdict) },
  limits: ['这是独立宿主审核，模型首次提取未获得本基准', '结构合格不代表数值正确；scratch 草稿不应用', '新数据集可使用已定位字段的保护基准，须计入其输入条件', '派生语义及客户未知值继续保留审核'] };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
await writeFile(join(output, 'definition-baseline.json'), JSON.stringify(baseline, null, 2));
await writeFile(join(root, 'dataset-baseline.json'), JSON.stringify(datasetBaseline, null, 2));
console.log(JSON.stringify(summary, null, 2));
