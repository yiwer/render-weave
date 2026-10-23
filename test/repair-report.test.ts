import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/agent-eval/repair-report.mjs', import.meta.url));
let root: string;
const save = (path: string, data: unknown) => writeFile(path, JSON.stringify(data));
const success = { available: true, qualified: true, repaired: ['a', 'b'], targetCount: 2, addedFailures: [], cleanSuccess: true, measurement: { checks: [] } };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rw-repair-report-'));
  await mkdir(join(root, 'a/initial'), { recursive: true });
  await save(join(root, 'a/initial/report.json'), { checks: [] });
  // 报告只复制图片字节；这里不调用渲染器。
  await writeFile(join(root, 'reference.png'), 'reference');
  await writeFile(join(root, 'a/initial/base.png'), 'initial');
});
afterEach(async () => {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rw-repair-report-')) throw new Error('临时目录越界');
  await rm(target, { recursive: true, force: true });
});
async function fixture(unavailable: boolean, collateralRegression = false) {
  const order = ['image', 'evidence'].flatMap((arm) => [1, 2].map((repetition) => ({ id: `a-${repetition}-${arm}`, caseId: 'a', arm, repetition })));
  const manifest = { head: 'fixture', rounds: 2, cases: [{ id: 'a', label: 'A' }], order };
  await save(join(root, 'manifest.json'), manifest);
  const rows = [];
  for (const unit of order.filter((u) => u.repetition === 1)) {
    const rounds = [];
    for (const iteration of [1, 2]) {
      const dir = join(root, unit.id, String(iteration));
      await mkdir(join(dir, 'repair-score'), { recursive: true });
      const missingScore = unavailable && unit.arm === 'image' && iteration === 2;
      const score = missingScore ? { available: false, qualified: false, repaired: [], targetCount: 2, addedFailures: null, cleanSuccess: false } :
        collateralRegression && unit.arm === 'image' ? { ...success, measurement: { checks: [{ id: 'collateral', pass: iteration === 1 }] } } : success;
      await save(join(dir, 'repair-score/report.json'), score);
      const missingUsage = unavailable && unit.arm === 'evidence' && iteration === 2;
      rounds.push({ dir, record: { verdict: missingScore ? 'unqualified' : 'qualified', run: { wallMs: missingUsage ? null : iteration * 100, context: { peakInputTokens: missingUsage ? null : iteration * 10 }, endedBy: 'success' } } });
      // 初始化存在但结束事件缺失，同样不能把未观测的工具动作记成零。
      if (unit.arm === 'image' && iteration === 1) {
        await mkdir(join(dir, 'logs'));
        await writeFile(join(dir, 'logs/stream.jsonl'), JSON.stringify({ type: 'system', subtype: 'init', model: 'fixture', skills: [] }) + '\n');
      }
    }
    rows.push({ ...unit, status: 'completed', rounds });
  }
  rows.push({ ...order.find((u) => u.id === 'a-2-image')!, status: 'invalid', failure: 'fixture infrastructure failure', rounds: [] });
  const manifestSha256 = createHash('sha256').update(await readFile(join(root, 'manifest.json'))).digest('hex');
  await save(join(root, 'live-report.json'), { manifestSha256, rows });
  execFileSync(process.execPath, [script, '--root', root, '--out', join(root, 'report')], { stdio: 'pipe' });
  return JSON.parse(await readFile(join(root, 'report/report.json'), 'utf8'));
}

describe('修复对照报告 CLI', () => {
  it('不把缺失测量、日志和耗时当成零或已证实回退', async () => {
    const report = await fixture(true);
    const image = report.groups.image, evidence = report.groups.evidence;
    expect(image).toMatchObject({ repaired: 0, unknownAddedUnits: 1, regressedTargets: 0, unknownRegressionUnits: 1,
      exploratoryAllChecks: { unknownRemainingUnits: 1, unknownRegressionUnits: 1 } });
    expect(evidence).toMatchObject({ repaired: 2, meanPeak: null, meanWallMs: null, totalWallMs: null, exploratoryEarlyStop: { secondRoundMsAfterSuccess: null } });
    expect(report.rows.flatMap((r: { rounds: { behavior: unknown }[] }) => r.rounds).every((r: { behavior: unknown }) => r.behavior === null)).toBe(true);
  });
  it('保留无效与未运行单元，分母只含完成的成对单元', async () => {
    const report = await fixture(false);
    expect(report.completePairs).toEqual(['a-1']);
    expect(report.rows.map((r: { status: string }) => r.status)).toEqual(['completed', 'invalid', 'completed', 'notRun']);
    for (const arm of ['image', 'evidence']) {
      expect(report.groups[arm]).toMatchObject({ planned: 2, completed: 1, targets: 2, repaired: 2, cleanSuccess: 1, addedFailures: 0, meanPeak: 20, meanWallMs: 300, totalWallMs: 300 });
      expect(report.pairedGroups[arm]).toEqual(report.groups[arm]);
    }
  });
  it('非目标项的轮间回退另外报告，不悄改事前目标修复口径', async () => {
    const report = await fixture(false, true);
    expect(report.groups.image).toMatchObject({ repaired: 2, cleanSuccess: 1, addedFailures: 0, regressedTargets: 0,
      exploratoryAllChecks: { allPassedUnits: 0, remainingFailures: 1, regressedFromFirst: 1 } });
    expect(report.rows[0].exploratoryAllChecks.regressedFromFirst).toEqual(['collateral']);
  });
});
