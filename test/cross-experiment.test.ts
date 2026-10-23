import { expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CROSS_CASES, prepareCrossExperiment, scoreCrossRound } from '../scripts/agent-eval/cross-experiment.js';
it('两种模板正例全过、坏例有效；同预算反馈分别集中/覆盖两个区域，首轮候选重放可停止且不能覆写', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'rw-cross-'));
  try {
    const root = join(tmp, 'trial'); await prepareCrossExperiment(root);
    const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
    const manifest = await read(join(root, 'manifest.json'));
    expect(manifest.order).toHaveLength(8); expect(manifest.maxTurns).toBe(20);
    for (const s of CROSS_CASES) {
      const good = await read(join(root, s.id, 'control-score/report.json')), bad = await read(join(root, s.id, 'initial/report.json'));
      expect(good.checks.every((c: any) => c.pass)).toBe(true);
      for (const t of s.targets) expect(bad.checks.find((c: any) => c.id === 'base/' + t).pass).toBe(false);
      expect(bad.inputs.every((i: any) => i.problems.every((p: any) => p.level !== 'severe'))).toBe(true);
      const packets = await Promise.all(['role', 'region'].map(async a => {
        const text = await readFile(join(root, s.id, a + '.md'), 'utf8');
        const packet = text.slice(text.indexOf('宿主元素测量')); expect(packet.trim().length).toBeLessThanOrEqual(1200);
        const items = JSON.parse(packet.split('\n')[1]!); expect(items).toHaveLength(2);
        return items.map((i: any) => i.role.split('/')[1]);
      }));
      expect(new Set(packets[0]).size).toBe(1); expect(new Set(packets[1]).size).toBe(2);
    }
    const round = join(tmp, 'round'); await mkdir(join(round, 'candidates'), { recursive: true });
    await cp(join(root, 'price/workspace'), join(round, 'snapshot'), { recursive: true });
    const bytes = await readFile(join(root, 'price/control/template-price-tag.json'));
    await writeFile(join(round, 'candidates/template-price-tag.json'), bytes);
    await writeFile(join(round, 'outcome.json'), JSON.stringify({ candidates: [{ kind: 'template', path: 'candidates/template-price-tag.json', sha256: createHash('sha256').update(bytes).digest('hex') }] }));
    await writeFile(join(round, 'round.json'), JSON.stringify({ verdict: 'qualified' }));
    await scoreCrossRound(root, 'price', round);
    expect((await read(join(round, 'repair-score/stop-decision.json'))).stop).toBe(true);
    const before = await readFile(join(round, 'repair-score/stop-decision.json'), 'utf8');
    await expect(scoreCrossRound(root, 'price', round)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(round, 'repair-score/stop-decision.json'), 'utf8')).toBe(before);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
