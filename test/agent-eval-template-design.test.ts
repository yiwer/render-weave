/**
 * 模板设计评估集（M333–M336）：配置与用例材料的一致性、数据驱动评分的校准，以及经产品路径的一次假执行器运行。不调用模型。
 * - 每个用例的工作区经引擎载入没有问题，示例数据集与压测、检查中的每个数据变体都合法：评分里的严重问题只能来自模板；
 * - 05 的专家模板是正例（压测与版面全过），只有空画板的模板是反例；
 * - 单元目录里组的资源仓库只含字体与本用例列出的图片（M334）。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport, formatReport, runScenario, scenarioResources, scoreScenario, type Launcher } from '../scripts/agent-eval/eval.js';
import { readConfig, repoPath, TEMPLATE_DESIGN_CONFIG, type EvalConfig, type TemplateScenario } from '../scripts/agent-eval/scenarios.js';
import { evaluateCheck, patchData, scoreTemplateCase, type CaseCheck, type StressSpec } from '../scripts/agent-eval/score.js';
import { checkDataset, loadWorkspace, runAgentTask } from '../src/index.js';
import { repoRoot } from './support/fixtures.js';

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
const EXPERT = join(repoRoot, 'fixtures/agent-eval/templates/tds-05-expert');
const read = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;

let base: string, config: EvalConfig;
const cases = () => config.scenarios as readonly TemplateScenario[];
const scenario = (id: string) => cases().find((item) => item.id === id)!;
const expertTemplates = async () => Promise.all((await readdir(EXPERT)).map(async (file) => {
  const document = await read<{ name: string }>(join(EXPERT, file));
  return { name: document.name, document };
}));
const emptyTemplate = (name: string, definition: string) => ({ name, document: {
  dslVersion: 'renderweave-template/1', name, base: { name: definition, version: 1 },
  artboard: { sizeRange: { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } }, fill: '#FFFFFF', layout: { mode: 'free' }, children: [] },
} });

beforeAll(async () => {
  // 放在仓库内被忽略的 test-output/ 下：字体能硬链接，不必每例复制 34 MB。
  await mkdir(join(repoRoot, 'test-output'), { recursive: true });
  base = await mkdtemp(join(repoRoot, 'test-output', 'tds-'));
  config = await readConfig(TEMPLATE_DESIGN_CONFIG);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('配置与用例材料', () => {
  it('12 个用例都是数据驱动评分的模板设计，每例材料齐全；没有 04 会议胸牌（M222）', async () => {
    expect(config.consecutivePasses).toBe(1);
    expect(cases().map((item) => item.id)).toEqual([
      'tds-01-m518', 'tds-02-m162', 'tds-03-price-tag', 'tds-05-asset-card', 'tds-06-metro-strip', 'tds-07-clinic',
      'tds-08-waybill', 'tds-09-promo-tag', 'tds-10-gate-screen', 'tds-11-hazmat', 'tds-12-cup-label', 'tds-13-boarding-pass',
    ]);
    const library = (await read<{ resources: { id: string; file: string }[] }>(join(repoRoot, 'scripts/agent-eval/template-design/resources/resources.json'))).resources;
    for (const item of cases()) {
      expect(item.kind).toBe('template');
      for (const path of [item.sample, item.brief, item.request, item.scoring!.stress, item.scoring!.checks, `agent/domains/${item.domain!}.md`]) await stat(repoPath(path));
      for (const file of item.workspace.files) await stat(join(repoPath(item.workspace.from), file));
      for (const id of item.resources!.images) expect(library.some((entry) => entry.id === id), `${item.id} 的资源 ${id}`).toBe(true);
      const request = await read<{ template: string; dataset: { id: string } }>(repoPath(item.request));
      expect(request.dataset.id).toBe(item.dataset);
      expect(await readFile(repoPath(item.brief), 'utf8')).toContain(`"${request.template}"`);
      const stress = await read<StressSpec>(repoPath(item.scoring!.stress));
      const checks = (await read<{ checks: CaseCheck[] }>(repoPath(item.scoring!.checks))).checks;
      // 通过线（M337）：压测全部，版面检查 85%（向上取整）。
      expect(item.pass).toEqual({ stress: stress.cases.length, layoutChecks: Math.ceil(checks.length * 0.85) });
      // 检查引用的图片都在本用例的资源里，否则 Agent 无从满足。
      for (const check of checks.filter((entry) => entry.kind === 'image')) {
        for (const source of [check.source].flat()) expect(item.resources!.images, `${item.id}「${check.label}」`).toContain(String(source).replace(/^res:/, ''));
      }
    }
    for (const entry of library) await stat(join(repoRoot, 'scripts/agent-eval/template-design/resources', entry.file));
  });

  it('每例的工作区经引擎载入没有问题；示例数据集、压测与检查中的每个数据变体都通过数据集校验', async () => {
    for (const item of cases()) {
      const resourcesDir = await scenarioResources(config, item, join(base, 'materials', item.id));
      const workspace = await loadWorkspace({ dir: repoPath(item.workspace.from), resourcesDir });
      expect(workspace.problems, item.id).toEqual([]);
      const dataset = workspace.datasets.find((entry) => entry.id === item.dataset)!;
      const stress = await read<StressSpec>(repoPath(item.scoring!.stress));
      const checks = (await read<{ checks: CaseCheck[] }>(repoPath(item.scoring!.checks))).checks;
      const variants = [{ label: '示例数据集', data: {} }, ...stress.cases, ...checks.filter((check) => check.variant?.data).map((check) => ({ label: check.label, data: check.variant!.data }))];
      for (const variant of variants) {
        const document = { dataset: dataset.document.dataset, data: patchData(dataset.document.data as Record<string, unknown>, variant.data) };
        expect(checkDataset(Buffer.from(JSON.stringify(document)), workspace).problems, `${item.id}「${variant.label}」`).toEqual([]);
      }
    }
  });

  it('单元的资源仓库只含字体与本用例列出的图片；没写 resources 的场景仍用共用仓库', async () => {
    const dir = await scenarioResources(config, scenario('tds-11-hazmat'), join(base, 'resources-11'));
    const manifest = await read<{ resources: { id: string; kind: string }[] }>(join(dir, 'resources.json'));
    expect(manifest.resources.filter((entry) => entry.kind === 'image').map((entry) => entry.id))
      .toEqual(['ghs-flammable', 'ghs-exclamation', 'ghs-health-hazard', 'ghs-corrosive', 'border-hazard-stripe']);
    expect(manifest.resources.filter((entry) => entry.kind === 'font').map((entry) => entry.id))
      .toEqual(['font-hei-regular', 'font-hei-medium', 'font-hei-bold', 'font-hei-heavy']);
    const { resources: _ignored, ...shared } = scenario('tds-11-hazmat');
    expect(await scenarioResources(config, shared, join(base, 'resources-shared'))).toBe(repoPath(config.resources));
    await expect(scenarioResources(config, { ...scenario('tds-11-hazmat'), resources: { from: 'scripts/agent-eval/template-design/resources', images: ['no-such'] } }, join(base, 'resources-bad')))
      .rejects.toThrow('没有图片 no-such');
  });
});

describe('数据驱动的压测与版面检查', () => {
  it('改数据：路径、删除与循环取项，不改原数据', () => {
    const data = { name: '甲', stops: [{ name: 'A', road: 'r' }, { name: 'B' }], tags: ['x'] };
    const patched = patchData(data, { 'stops[1].name': 'Z', 'stops[0].road': null, tags: null, list: { $take: { from: 'stops', count: 5 } } });
    expect(patched).toEqual({ name: '甲', stops: [{ name: 'A' }, { name: 'Z' }], list: [{ name: 'A', road: 'r' }, { name: 'B' }, { name: 'A', road: 'r' }, { name: 'B' }, { name: 'A', road: 'r' }] });
    expect(data.stops[1]!.name).toBe('B');
    expect(patchData(data, { stops: { $take: { from: 'stops', count: 1 } } })['stops']).toEqual([{ name: 'A', road: 'r' }]);
    expect(() => patchData(data, { 'missing.key': 1 })).toThrow('改数据的路径不存在');
  });

  it('检查：文字、区域、字号最大、颜色与断言找不到', () => {
    const text = (content: string, x: number, fontSize: number, color = '#000000') => ({
      type: 'text', path: content, x, y: 10, width: 10, height: 5, visible: true,
      text: { content, fontSize, fragments: [{ text: content, fontSize, color }] },
    });
    const layout = { output: { width: 100, height: 50 }, root: { type: 'container', path: '', x: 0, y: 0, width: 100, height: 50, visible: true, children: [
      text('品名：天然 水', 5, 4), text('2.50', 70, 12, '#E60012'), text('张敏', 5, 3, '#A0A0A0'),
      { type: 'image', path: 'logo', x: 0, y: 0, width: 8, height: 8, visible: false, image: { source: 'res:logo', drawn: { x: 0, y: 0, width: 8, height: 8 } } },
    ] } };
    const check = (spec: Omit<CaseCheck, 'label'>) => evaluateCheck({ label: 't', ...spec }, layout);
    expect(check({ kind: 'text', text: '天然水' }).pass).toBe(true);
    expect(check({ kind: 'text', text: '天然水', region: { x: [0.5, 1] } })).toMatchObject({ pass: false, detail: expect.stringContaining('位置不对') });
    expect(check({ kind: 'largest', text: ['2.50', '2'] }).pass).toBe(true);
    expect(check({ kind: 'largest', text: '张敏' })).toMatchObject({ pass: false, detail: expect.stringContaining('最大字号 12.0 mm：2.50') });
    expect(check({ kind: 'text', text: '张敏', color: '#AAAAAA' }).pass).toBe(true);
    expect(check({ kind: 'text', text: '张敏', color: '#000000' })).toMatchObject({ pass: false, detail: expect.stringContaining('#A0A0A0') });
    expect(check({ kind: 'image', source: 'res:logo' }).pass).toBe(false);
    expect(check({ kind: 'image', source: 'res:logo', absent: true }).pass).toBe(true);
    expect(check({ kind: 'qrcode' }).pass).toBe(false);
    // 条码自带的下方文字（showText）也算文字：基线里 08 的运单号就是这样印的。
    const coded = { ...layout, root: { ...layout.root, children: [{ type: 'barcode', path: '运单码', x: 10, y: 20, width: 40, height: 15, visible: true,
      barcode: { format: 'CODE128', symbol: { x: 10, y: 20, width: 40, height: 10 },
        label: { box: { x: 10, y: 31, width: 40, height: 4 }, text: { content: 'XD882026102509', fontSize: 3, fragments: [{ text: 'XD882026102509', fontSize: 3, color: '#000000' }] } } } }] } };
    expect(evaluateCheck({ label: 't', kind: 'text', text: 'XD882026102509', region: { y: [0.6, 0.75] } }, coded).pass).toBe(true);
    expect(evaluateCheck({ label: 't', kind: 'barcode', format: 'CODE128', region: { y: [0.4, 0.6] } }, coded).pass).toBe(true);
  });

  it('校准：05 的专家模板压测 8/8、版面 11/11；只有空画板时版面只剩"找不到"一类的检查碰巧成立', async () => {
    const item = scenario('tds-05-asset-card');
    const options = {
      workspaceDir: repoPath(item.workspace.from), resourcesDir: await scenarioResources(config, item, join(base, 'calibrate-05')),
      request: await read<Parameters<typeof scoreTemplateCase>[0]['request']>(repoPath(item.request)), datasetId: item.dataset,
      stress: await read<StressSpec>(repoPath(item.scoring!.stress)), checks: (await read<{ checks: CaseCheck[] }>(repoPath(item.scoring!.checks))).checks,
      sample: await readFile(repoPath(item.sample)),
    };
    const expert = await scoreTemplateCase({ ...options, templates: await expertTemplates() });
    expect(expert).toMatchObject({ stressPassed: 8, layoutPassed: 11, layoutTotal: 11, sample: { severe: 0 } });
    expect(expert.checks!.filter((check) => !check.pass)).toEqual([]);
    const empty = await scoreTemplateCase({ ...options, templates: [emptyTemplate('资产标识卡', '固定资产标识卡')] });
    expect(empty).toMatchObject({ stressPassed: 8, layoutPassed: 0, layoutTotal: 11 });
  });
});

describe('编排：经产品路径跑一个用例（假执行器）', () => {
  it('05 交回专家模板：一轮合格、达线；资源只含本例图片；按评估清单的配置可重新评分', async () => {
    const outDir = join(base, 'eval-05');
    const files: Record<string, unknown> = {};
    for (const template of await expertTemplates()) files[`candidates/${template.name}.json`] = template.document;
    files['outcome.json'] = { candidates: Object.keys(files), pending: [], notes: '评估夹具：05 专家模板。' };
    const launch: Launcher = async (spec) => {
      expect(spec.task).toBe('template-design');
      expect(spec.domain).toBe('asset-tag');
      const manifest = await read<{ resources: { id: string; kind: string }[] }>(join(spec.resources, 'resources.json'));
      expect(manifest.resources.filter((entry) => entry.kind === 'image').map((entry) => entry.id)).toEqual(['logo-nebula-tech']);
      const preset = join(base, 'preset-05');
      await mkdir(join(preset, 'candidates'), { recursive: true });
      for (const [path, value] of Object.entries(files)) await writeFile(join(preset, path), JSON.stringify(value, null, 2));
      await runAgentTask({ ...spec, key: 'rw-test-key-tds', keyEnv: 'RW_TEST_KEY', claude: { command: process.execPath, args: [FAKE, preset] } });
    };
    const item = scenario('tds-05-asset-card');
    const result = await runScenario(config, item, 1, outDir, launch);
    expect(result).toMatchObject({ status: 'pass', failures: [], rounds: [{ task: 'template-design', verdict: 'qualified' }],
      checks: { template: { stressPassed: 8, layoutPassed: 11, layoutTotal: 11 } } });
    expect(await scoreScenario(config, item, 1, outDir)).toEqual(result);
    const report = await buildReport({ config, label: 'tds-test', startedAt: '2026-10-25T00:00:00.000Z', outDir, results: [result] });
    expect(report.gate).toMatchObject({ status: 'pass', scenarios: [{ id: 'tds-05-asset-card', outcomes: ['pass'] }] });
    expect(formatReport(report)).toContain('05 固定资产标识卡 第 1 次：达线');
  });

  it('只有空画板时版面不达线，原因列出未过的检查', async () => {
    const outDir = join(base, 'eval-05-empty');
    const template = emptyTemplate('资产标识卡', '固定资产标识卡');
    const launch: Launcher = async (spec) => {
      const preset = join(base, 'preset-05-empty');
      await mkdir(join(preset, 'candidates'), { recursive: true });
      await writeFile(join(preset, 'candidates/card.json'), JSON.stringify(template.document));
      await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates: ['candidates/card.json'], pending: [], notes: '空画板。' }));
      await runAgentTask({ ...spec, key: 'rw-test-key-tds', keyEnv: 'RW_TEST_KEY', claude: { command: process.execPath, args: [FAKE, preset] } });
    };
    const result = await runScenario(config, scenario('tds-05-asset-card'), 1, outDir, launch);
    expect(result.status).toBe('fail');
    expect(result.failures).toEqual(expect.arrayContaining([expect.stringMatching(/^版面检查 0\/11，要求至少 10（未过：单位标识在左上、标题含单位名称、/)]));
  });
});
