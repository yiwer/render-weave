/** 离线重放已存原失败/反馈轮次；不调用模型，不改旧轮次。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkAgentOutcome, loadWorkspace } from '../src/index.ts';

const source = resolve(process.argv[2] ?? 'out/arabic-board-retest-2026-10-20');
const output = resolve(process.argv[3] ?? 'out/agent-content-replay');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const hashes = {};
const remember = async (path) => { hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex'); };
const truth = await json(join(source, 'truth.json')); await remember(join(source, 'truth.json'));
const definitionBaseline = { name: '存档原场景的核准事实', items: [
  { id: 'stopCode', label: '站码', definition: '公交站点', field: 'code', sampleOmissions: truth.stops.filter((s) => s.stopCode === undefined).length, mustBeOptionalIfPartial: true },
  ...['peakMorningStart', 'paymentMethods', 'transferValidityMin'].map((field) => ({ id: field, label: field, definition: '公交线路牌', field })),
  { id: 'destinationName', label: '终点', definition: '公交线路牌', field: 'destinationName', expectedKind: 'derived', derivableFrom: 'stops[last].name' },
] };
const datasetBaseline = { name: '存档原场景累计分钟事实', items: [{ id: 'minutesFromStart', label: '累计分钟', values: truth.stops.map((stop, index) => ({
  path: `stops[${index + 1}].minutesFromStart`, ...(stop.cumulativeMinutes === undefined ? { unknown: true } : { value: stop.cumulativeMinutes }),
})) }] };
assert.equal(definitionBaseline.items[0].sampleOmissions, 15);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'definition-baseline.json'), JSON.stringify(definitionBaseline, null, 2));
await writeFile(join(output, 'dataset-baseline.json'), JSON.stringify(datasetBaseline, null, 2));
const summary = [];
for (const [name, task, contentBaseline] of [
  ['r1b-definition', 'definition-extraction', definitionBaseline], ['r1c-definition', 'definition-extraction', definitionBaseline],
  ['r2-dataset', 'dataset-extraction', datasetBaseline], ['r2b-dataset', 'dataset-extraction', datasetBaseline],
]) {
  const agentDir = join(source, name, 'agent');
  const submission = await json(join(agentDir, 'outcome.json')); await remember(join(agentDir, 'outcome.json'));
  for (const path of submission.candidates) await remember(join(agentDir, path));
  const workspace = await loadWorkspace({ dir: join(source, name, 'snapshot'), resourcesDir: join(source, 'resources') });
  const report = await checkAgentOutcome({ task, agentDir, workspace, context: { contentBaseline,
    ...(task === 'dataset-extraction' ? { definition: { name: '公交线路牌', version: 1 } } : {}) } });
  const anomalies = report.coverageVerification.anomalies;
  const severe = anomalies.filter((a) => a.level === 'severe');
  if (name === 'r1b-definition') assert.ok(severe.some((a) => a.code === 'fieldShouldBeOptional'));
  if (name === 'r2-dataset') assert.equal(severe.filter((a) => a.code === 'missingBusinessCoverage').length, 12);
  if (name === 'r1c-definition' || name === 'r2b-dataset') assert.equal(severe.length, 0);
  await writeFile(join(output, `${name}.json`), JSON.stringify(report, null, 2));
  summary.push({ name, verdict: report.verdict, status: report.coverageVerification.status, severe: severe.map((a) => ({ code: a.code, path: a.path })), unknownItems: report.coverageVerification.unknownItems });
}
for (const [path, hash] of Object.entries(hashes)) assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash);
await writeFile(join(output, 'summary.json'), JSON.stringify({ source, hashes, summary,
  note: '可信事实来自存档 truth.json 与原图审核记录；这里只重放旧候选，未进行新模型提取或验证通用推导能力。反馈候选仍需人工审核。' }, null, 2));
console.log(JSON.stringify(summary, null, 2));
