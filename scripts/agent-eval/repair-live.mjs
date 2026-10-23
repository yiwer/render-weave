/** 固定两轮、交叉顺序的真实模型实验。失败不重跑，额度耗尽立即停止。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runAgentTask } from '../../dist/index.js';

const { values } = parseArgs({ options: { root: { type: 'string' } }, strict: true });
if (!values.root || !process.env.OPEN_CODE_API_KEY) throw new Error('需要 --root 与 OPEN_CODE_API_KEY');
const root = resolve(values.root), repo = resolve(import.meta.dirname, '../..');
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const manifest = await json(join(root, 'manifest.json'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
for (const file of manifest.scripts) if (sha(await readFile(join(repo, file.path))) !== file.sha256) throw new Error('脚本不再等于登记版本：' + file.path);
for (const [directory, files] of [['dist', manifest.runtime], ['agent', manifest.materials]]) for (const file of files) {
  if (sha(await readFile(join(repo, directory, file.path))) !== file.sha256) throw new Error('运行资料不再等于登记版本：' + file.path);
}
for (const file of manifest.inputs) if (sha(await readFile(join(root, file.path))) !== file.sha256) throw new Error('实验输入已变化：' + file.path);
for (const file of manifest.resources) if (sha(await readFile(join(repo, 'fixtures/resources', file.path))) !== file.sha256) throw new Error('资源已变化：' + file.path);
const dir = join(root, 'live'); await mkdir(dir); // 不能静默覆盖或重复付费
const runtime = { key: process.env.OPEN_CODE_API_KEY, keyEnv: 'OPEN_CODE_API_KEY', model: manifest.model, smallModel: manifest.model, maxTurns: manifest.maxTurns };
const rows = [];
const save = async () => writeFile(join(root, 'live-report.json'), JSON.stringify({ manifestSha256: sha(await readFile(join(root, 'manifest.json'))), rows }, null, 2) + '\n');
const score = (caseId, round) => {
  const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(repo, 'scripts/agent-eval/repair-experiment.ts'), '--root', root, '--case', caseId, '--round', round], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  console.log(stdout.trim());
};
let stopped = false;
for (const unit of manifest.order) {
  if (stopped) break;
  const base = join(root, unit.caseId), unitDir = join(dir, unit.id); await mkdir(unitDir);
  const item = { ...unit, rounds: [], status: 'running' }; rows.push(item); await save();
  for (const iteration of [1, 2]) {
    const out = join(unitDir, 'round-' + iteration);
    console.log(JSON.stringify({ event: 'start', unit: unit.id, iteration, at: new Date().toISOString() }));
    const options = iteration === 1 ? { task: 'template-revision', sample: join(root, 'reference.png'), brief: join(root, 'brief.md'), resources: join(repo, 'fixtures/resources'),
      workspace: join(base, 'workspace'), dataset: 'ds-m402-wanguocheng', request: join(root, 'request.json'), requirement: join(base, unit.arm + '.md'), domain: 'route-sign' }
      : { from: join(unitDir, 'round-1'), feedback: join(unitDir, 'round-1/repair-score', unit.arm + '-feedback.md') };
    const result = await runAgentTask({ ...runtime, ...options, out });
    item.rounds.push({ dir: out, record: result.record }); await save();
    const error = result.record.run.error ?? '';
    if (result.record.run.stopped || /\b429\b|rate[_ ]?limit|quota|usage limit/i.test(error)) { item.status = 'quota'; stopped = true; await save(); break; }
    if (/\b(?:500|502|503|529)\b|overloaded|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error)) { item.status = 'invalid'; await save(); break; }
    score(unit.caseId, out); // 模型已结束，离线评分时间不混入 wallMs
    const measured = await json(join(out, 'repair-score/report.json'));
    item.rounds.at(-1).score = { qualified: measured.qualified, repaired: measured.repaired, addedFailures: measured.addedFailures, cleanSuccess: measured.cleanSuccess, available: measured.available };
    console.log(JSON.stringify({ event: 'complete', unit: unit.id, iteration, verdict: result.record.verdict, peak: result.record.run.context?.peakInputTokens, wallMs: result.record.run.wallMs, ...item.rounds.at(-1).score }));
    if (iteration === 2) item.status = 'completed';
    await save();
  }
}
console.log(JSON.stringify({ completed: rows.filter((r) => r.status === 'completed').length, planned: manifest.order.length, stopped }));
