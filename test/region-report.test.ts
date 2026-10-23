import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dirs: string[] = [];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const save = async (path: string, value: unknown) => { const s = JSON.stringify(value); await writeFile(path, s); return sha(s); };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rw-region-report-')); dirs.push(root);
  await mkdir(join(root, 'c/initial'), { recursive: true });
  for (const dir of ['control', 'control-score']) await mkdir(join(root, dir));
  for (const file of ['brief.md', 'request.json']) await writeFile(join(root, file), 'fixture');
  for (const p of ['reference.png', 'c/initial/base.png']) await writeFile(join(root, p), 'fixture');
  await save(join(root, 'c/initial/report.json'), { checks: [] });
  await writeFile(join(root, 'c/role.md'), '初始反馈');
  const unit = { id: 'c-1-role', arm: 'role', repetition: 1, caseId: 'c' };
  const hash = await save(join(root, 'manifest.json'), { comparison: 'role-region', head: 'fixture', order: [unit] });
  const rounds = [];
  for (const i of [1, 2]) {
    const dir = join(root, 'round-' + i); await mkdir(join(dir, 'repair-score'), { recursive: true });
    const record = { startedAt: `2026-10-23T05:0${i * 2}:00.000Z`, verdict: 'qualified', run: { wallMs: i * 1000, context: { peakInputTokens: i * 100 } } };
    await save(join(dir, 'round.json'), record);
    const score = { qualified: true, available: true, repaired: i === 1 ? ['a', 'b'] : ['b'], targetCount: 2,
      addedFailures: i === 1 ? [] : ['a'], cleanSuccess: i === 1, measurement: { checks: [{ id: 'a', pass: i === 1 }, { id: 'b', pass: true }] } };
    const scoreHash = await save(join(dir, 'repair-score/report.json'), score);
    await save(join(dir, 'repair-score/stop-decision.json'), { stop: i === 1, measurementSha256: scoreHash, decidedAt: `2026-10-23T05:0${i * 2 + 1}:00.000Z` });
    await writeFile(join(dir, 'feedback.md'), '续轮反馈');
    rounds.push({ dir, record });
  }
  await save(join(root, 'live-report.json'), { manifestSha256: hash, rows: [{ ...unit, status: 'completed', rounds }] });
  return root;
}
function run(root: string) { execFileSync(process.execPath, ['scripts/agent-eval/region-report.mjs', '--root', root, '--out', join(root, 'archive')], { cwd: resolve(import.meta.dirname, '..'), stdio: 'pipe' }); }
describe('区域实验报告公开命令', () => {
  it('跨模板分别归档与汇总，同次重复的不同模板不能凑成一对', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rw-cross-report-')); dirs.push(root);
    const order = [], rows = [];
    for (const [caseId, arm] of [['price', 'role'], ['badge', 'region']] as const) {
      const source = await fixture(), base = join(root, caseId);
      await mkdir(base);
      for (const file of ['control', 'control-score', 'reference.png', 'brief.md', 'request.json']) await cp(join(source, file), join(base, file), { recursive: true });
      await cp(join(source, 'c/initial'), join(base, 'initial'), { recursive: true });
      await writeFile(join(base, arm + '.md'), caseId + '反馈');
      const live = JSON.parse(await readFile(join(source, 'live-report.json'), 'utf8'));
      const unit = { id: caseId + '-1-' + arm, caseId, repetition: 1, arm };
      order.push(unit); rows.push({ ...live.rows[0], ...unit });
    }
    const manifestSha256 = await save(join(root, 'manifest.json'), { comparison: 'cross-template', head: 'fixture', cases: [{ id: 'price' }, { id: 'badge' }], order });
    await save(join(root, 'live-report.json'), { manifestSha256, rows }); run(root);
    const report = JSON.parse(await readFile(join(root, 'archive/report.json'), 'utf8'));
    expect(report.byCase.price.role.fixed.measured).toBe(1);
    expect(report.byCase.price.region.fixed.measured).toBe(0);
    expect(report.byCase.badge.region.fixed.measured).toBe(1);
    expect(report.pairedGroups.role.fixed.measured).toBe(0);
    expect(report.baselines.badge.reference).toBe('badge-reference.png');
    expect(report.rows[1].rounds[0].feedback).toBe('badge反馈');
    expect(await readFile(join(root, 'archive/inputs/price/brief.md'), 'utf8')).toBe('fixture');
    expect(await readFile(join(root, 'archive/index.html'), 'utf8')).toContain('id="case"');
  });
  it('固定续跑的回退与共享前缀停止成本分别保留', async () => {
    const root = await fixture(); run(root);
    const report = JSON.parse(await readFile(join(root, 'archive/report.json'), 'utf8'));
    expect(report.groups.role.fixed).toMatchObject({ repaired: 1, allPassed: 0, regressions: 1, meanPeak: 200, meanWallMs: 3000 });
    expect(report.groups.role.stopped).toMatchObject({ repaired: 2, allPassed: 1, regressions: 0, meanPeak: 100, meanWallMs: 1000 });
  });
  it('缺少评分与决定不能冒充零缺陷或自动停止', async () => {
    const root = await fixture();
    // 精确删除本测试创建的两份文件；并非递归目录操作。
    for (const file of ['report.json', 'stop-decision.json']) await rm(join(root, 'round-2/repair-score', file));
    run(root);
    const report = JSON.parse(await readFile(join(root, 'archive/report.json'), 'utf8'));
    expect(report.groups.role.fixed).toMatchObject({ unknownRepair: 1, unknownAdded: 1, unknownAllPassed: 1, unknownRegressions: 1 });
    expect(report.groups.role.stopped.allPassed).toBe(1);
  });
  it('一侧最终不可测不能进入成对可测集合，但保留已知停止前缀', async () => {
    const root = await fixture(), other = await fixture();
    const live = JSON.parse(await readFile(join(root, 'live-report.json'), 'utf8'));
    const right = JSON.parse(await readFile(join(other, 'live-report.json'), 'utf8')).rows[0];
    right.id = 'c-1-region'; right.arm = 'region'; live.rows.push(right);
    await writeFile(join(root, 'c/region.md'), '区域反馈');
    for (const file of ['report.json', 'stop-decision.json']) await rm(join(other, 'round-2/repair-score', file));
    live.manifestSha256 = await save(join(root, 'manifest.json'), { comparison: 'role-region', head: 'fixture', order: live.rows.map(({ id, caseId, arm, repetition }: any) => ({ id, caseId, arm, repetition })) });
    await save(join(root, 'live-report.json'), live); run(root);
    const report = JSON.parse(await readFile(join(root, 'archive/report.json'), 'utf8'));
    expect(report.groups.region.fixed).toMatchObject({ measured: 1, unknownRepair: 1 });
    expect(report.pairedKeys.fixed).toEqual([]);
    expect(report.pairedGroups.role.fixed.measured).toBe(0);
    expect(report.pairedKeys.stopped).toEqual(['c-1']);
    expect(report.pairedGroups.region.stopped).toMatchObject({ measured: 1, repaired: 2 });
  });
  it('影子续跑失败也保留已登记的首轮停止成果，配对覆盖另列', async () => {
    const root = await fixture(), p = join(root, 'live-report.json');
    const live = JSON.parse(await readFile(p, 'utf8'));
    live.rows[0].status = 'invalid'; live.rows[0].rounds = live.rows[0].rounds.slice(0, 1);
    await save(p, live); run(root);
    const report = JSON.parse(await readFile(join(root, 'archive/report.json'), 'utf8'));
    expect(report.groups.role.fixed.measured).toBe(0);
    expect(report.groups.role.stopped).toMatchObject({ measured: 1, repaired: 2, allPassed: 1, meanWallMs: 1000 });
    expect(report.pairedGroups.role.stopped.measured).toBe(0);
  });
  it('拒绝候选评分变化及事后补写停止决定', async () => {
    const root = await fixture();
    const p = join(root, 'round-1/repair-score/stop-decision.json');
    const decision = JSON.parse(await readFile(p, 'utf8'));
    await save(p, { ...decision, measurementSha256: 'wrong' });
    expect(() => run(root)).toThrow();
    await save(p, { ...decision, decidedAt: '2026-10-23T06:00:00.000Z' });
    expect(() => run(root)).toThrow();
  });
});
