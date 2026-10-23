/** 运行：npx tsx scripts/agent-eval/fidelity-experiment.ts --out <新目录>；离线，不调用模型。 */
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { render, compareDesignImages, loadWorkspace, type Workspace } from '../../src/index.js';
import { assessFidelity, m402DisplayContract, type FidelityMeasurement, type M402Data } from './fidelity.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const hash = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
async function fingerprintDirectory(dir: string, prefix = ''): Promise<{ path: string; sha256: string }[]> {
  const files: { path: string; sha256: string }[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('实验指纹不接受链接：' + join(dir, entry.name));
    if (entry.isDirectory()) files.push(...await fingerprintDirectory(join(dir, entry.name), prefix + entry.name + '/'));
    else if (entry.isFile()) files.push({ path: prefix + entry.name, sha256: hash(await readFile(join(dir, entry.name))) });
  }
  return files;
}
type Doc = Record<string, any>;
type Variant = { id: string; label: string; mutate?: (docs: Doc[], data: M402Data) => void };
const edit = (docs: Doc[], template: string, nodeName: string, change: (node: Doc) => void) => {
  const doc = docs.find((d) => d.name === template);
  if (!doc) throw new Error('缺少实验模板：' + template);
  let count = 0;
  const walk = (node: Doc) => { if (node.name === nodeName) { change(node); count++; } node.children?.forEach(walk); };
  walk(doc.artboard);
  if (count !== 1) throw new Error(`变体定位 ${template}/${nodeName} 得到 ${count} 项`);
};
const variants: Variant[] = [
  { id: 'control', label: '受控正例：项目维护的模板' },
  { id: 'empty-skeleton', label: '空骨架：仅保留五区背景', mutate(docs) {
    const main = docs.find((d) => d.name === '标准线路单边')!;
    main.artboard.layout = { mode: 'free' };
    main.artboard.children = [[0, 0, 740, 35, '#ff8000'], [0, 35, 740, 98, '#ffffff'], [0, 133, 740, 11, '#dcdcdc'],
      [0, 144, 200, 21, '#ffffff'], [200, 144, 540, 21, '#ffef00']].map(([x, y, w, h, fill], i) =>
        ({ type: 'rect', name: '背景' + i, fill, place: { left: x, top: y, width: { fixed: w }, height: { fixed: h } } }));
  } },
  { id: 'missing-station', label: '漏掉第一站', mutate: (docs) => edit(docs, '标准线路单边', '站点列', (n) => { n.slice = { start: 2 }; }) },
  { id: 'reverse-stations', label: '站点顺序颠倒', mutate: (docs) => edit(docs, '标准线路单边', '站点列', (n) => { n.reverse = true; }) },
  { id: 'missing-times', label: '隐藏全部班次时刻', mutate: (docs) => edit(docs, '标准线路单边', '班次列', (n) => { n.visible = false; }) },
  { id: 'small-stations', label: '站名字号减半', mutate(docs) { docs.find((d) => d.name === '标准线路单边')!.parameters.find((p: Doc) => p.name === 'stopNameSize').default = 5; } },
  { id: 'shift-stations', label: '站点面板左留白增加 20 mm', mutate: (docs) => edit(docs, '标准线路单边', '站点面板', (n) => { n.padding.left += 20; }) },
  { id: 'raised-divider', label: '底栏增高 10 mm，内容仍齐全', mutate(docs) {
    docs.find((d) => d.name === '标准线路单边')!.artboard.layout.rows[3].fixed += 10;
  } },
  { id: 'missing-landmarks', label: '隐藏站点地标', mutate: (docs) => edit(docs, '站点', '地标', (n) => { n.visible = false; }) },
  { id: 'extra-label', label: '插入陌生站名标签', mutate: (docs) => edit(docs, '标准线路单边', '站点面板', (n) => {
    n.children.push({ type: 'text', name: '陌生标签', content: [{ text: '虚构站' }], font: 'res:font-hei-medium', fontSize: 5,
      place: { width: 'fill', height: { fixed: 6 } } });
  }) },
  { id: 'frozen-example', label: '写死第一站和下一站的示例值', mutate(docs, data) {
    const stop = docs.find((d) => d.name === '站点')!;
    stop.derived.push({ name: 'frozenName', displayName: '写死首站名', type: 'text', op: 'branch', branches: [
      { when: { left: { var: 'index' }, op: 'eq', right: { value: 1 } }, then: { value: data.stops[0]!.name } }], otherwise: { var: 'name' } });
    edit(docs, '站点', '站名', (n) => { n.content = [{ slot: 'frozenName' }]; });
    edit(docs, '标准线路单边', '下一站', (n) => { n.content = [{ text: '下一站：', color: '#333333' }, { text: data.stops[5]!.name, color: '#FF6A00' }]; });
  } },
];

export async function runFidelityExperiment(outDir: string, cohort = true) {
  await mkdir(outDir); // 不覆盖已保存证据
  const sourceFingerprint = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    node: process.version, engine: await fingerprintDirectory(join(repo, 'src')),
    evaluator: await Promise.all(['scripts/agent-eval/fidelity.ts', 'scripts/agent-eval/fidelity-experiment.ts', 'package-lock.json'].map(async (path) =>
      ({ path, sha256: hash(await readFile(join(repo, path))) }))) };
  const resources = new Map<string, { sha256: string; files: { path: string; sha256: string }[] }>();
  const resourceFingerprint = async (path: string) => {
    if (!resources.has(path)) { const files = await fingerprintDirectory(path); resources.set(path, { sha256: hash(JSON.stringify(files)), files }); }
    return resources.get(path)!.sha256;
  };
  const controlledResources = await resourceFingerprint(join(repo, 'fixtures/resources'));
  const ws = await loadWorkspace({ dir: join(repo, 'docs/examples/m402-dsl'), resourcesDir: join(repo, 'fixtures/resources') });
  const dataDocument = await json(join(repo, 'docs/examples/m402-dsl/dataset-m402.json'));
  const data = dataDocument.data as M402Data, originalDocs = ws.templates.map((t) => structuredClone(t.document) as Doc);
  const request = { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 },
    output: { width: 740, height: 165, dpi: 50, format: 'png' }, mode: 'final' };
  const sample = await readFile(join(repo, 'docs/examples/materials/m402-route-sign.jpg'));
  await writeFile(join(outDir, 'reference.jpg'), sample);
  const apply = (workspace: Workspace, docs: Doc[]): Workspace => ({ ...workspace, templates: docs.map((document) => ({ name: document.name, document })) });
  const reference = await render(apply(ws, originalDocs), request);
  if (!reference.image || reference.problems.some((p) => p.level === 'severe')) throw new Error('受控正例未成功渲染：' + JSON.stringify(reference.problems));
  const control = assessFidelity(reference.layout, m402DisplayContract(data, 5));
  const rows: any[] = [];
  const measure = async (id: string, label: string, workspace: Workspace, req: typeof request, inputData: M402Data,
    origin: string, geometryRef?: FidelityMeasurement, baselineImage?: Uint8Array, documents?: Doc[], resourceSha256 = controlledResources) => {
    const dir = join(outDir, id); await mkdir(dir);
    const rendered = await render(workspace, req);
    const metrics = assessFidelity(rendered.layout, m402DisplayContract(inputData, req.parameters.currentIndex), geometryRef);
    const originalPixel = rendered.image ? (await compareDesignImages({ reference: sample, actual: rendered.image.bytes, widthMm: 740, heightMm: 165 })).report : null;
    const controlledPixel = rendered.image && baselineImage ? (await compareDesignImages({ reference: baselineImage, actual: rendered.image.bytes, widthMm: 740, heightMm: 165 })).report : null;
    const row = { id, label, origin, metrics, originalPixel, controlledPixel, renderProblems: rendered.problems,
      geometryBasis: geometryRef ? '项目维护模板的渲染布局，仅作受控正例；并非原图金标准' : null,
      sampleSha256: hash(sample), dataSha256: hash(JSON.stringify(inputData)), request: req, resourceSha256,
      imageKind: rendered.image ? 'clean-final' : 'unavailable', imageSha256: rendered.image ? hash(rendered.image.bytes) : null,
      templateSha256: hash(JSON.stringify(workspace.templates.map((t) => [t.name, t.document]))) };
    rows.push(row);
    await writeFile(join(dir, 'report.json'), JSON.stringify(row, null, 2) + '\n');
    await writeFile(join(dir, 'data.json'), JSON.stringify(inputData, null, 2) + '\n');
    if (documents) await writeFile(join(dir, 'templates.json'), JSON.stringify(documents, null, 2) + '\n');
    if (rendered.image) await writeFile(join(dir, 'actual.png'), rendered.image.bytes);
    if (rendered.layout) await writeFile(join(dir, 'layout.json'), JSON.stringify(rendered.layout, null, 2) + '\n');
    console.log(JSON.stringify({ id, content: metrics.content, ssim: originalPixel?.ssim, issues: metrics.diagnostics.map((d) => d.role + ':' + d.code) }));
    return row;
  };
  for (const variant of variants) {
    const docs = structuredClone(originalDocs); variant.mutate?.(docs, data);
    await measure(variant.id, variant.label, apply(ws, docs), request, data, 'controlled-mutation', control, reference.image.bytes, docs);
  }
  for (const kind of ['rename', 'swap', 'current-index', 'no-badges'] as const) for (const frozen of [false, true]) {
    const input = structuredClone(dataDocument), docs = structuredClone(originalDocs), req = structuredClone(request);
    if (frozen) variants.find((v) => v.id === 'frozen-example')!.mutate!(docs, data);
    if (kind === 'rename') input.data.stops[0].name = '校准测试总站';
    if (kind === 'swap') [input.data.stops[0], input.data.stops[1]] = [input.data.stops[1], input.data.stops[0]];
    if (kind === 'current-index') req.parameters.currentIndex = 10;
    if (kind === 'no-badges') input.data.stops.forEach((s: Doc) => { delete s.badges; });
    const changed: Workspace = { ...apply(ws, docs), datasets: ws.datasets.map((d) => d.id === 'ds-m402-wanguocheng' ? { ...d, document: input } : d) };
    const inputLabel = { rename: '首站改名', swap: '交换前两站', 'current-index': '切换本站序号', 'no-badges': '移除可选标识' }[kind];
    await measure(`counter-${kind}-${frozen ? 'frozen' : 'bound'}`, `${inputLabel} · ${frozen ? '写死示例' : '正常绑定'}`,
      changed, req, input.data, 'counterfactual-input', undefined, undefined, docs);
  }
  if (cohort) {
    const previous = await json(join(repo, 'docs/template-design-p1-live-comparison.json'));
    const oldLabel = (id: string) => id === 'initial-failure' ? 'P0 首次失败' : id.replace(/^before-/, 'P0 改前 · ').replace(/^final-/, 'P0 修订 · ')
      .replace(/^unlimited-/, 'P1 无阈值 · ').replace(/^handoff-/, 'P1 交接 · ');
    const sources = [...previous.rows.map((r: any) => ({ id: 'old-' + r.id, label: oldLabel(r.id), round: r.round })),
      ...[1, 2].map((i) => ({ id: 'new-unlimited-' + i, label: '区域纠偏无阈值 · ' + i, round: `out/refinement-live/run-${i}/m402-template/template` }))];
    for (const i of [1, 2]) {
      const round = `out/refinement-handoff-${i}/resumed`;
      try { await access(join(repo, round, 'round.json')); sources.push({ id: 'new-handoff-' + i, label: '区域纠偏交接 · ' + i, round }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const source of sources) {
      const round = resolve(repo, source.round), record = await json(join(round, 'round.json'));
      const outcome = await json(join(round, 'outcome.json')), req = await json(join(round, 'request.json'));
      req.mode = 'final'; req.output.dpi = 50;
      const base = await loadWorkspace({ dir: join(round, 'snapshot'), resourcesDir: record.inputs.resources });
      const candidates = await Promise.all(outcome.candidates.filter((c: any) => c.kind === 'template').map(async (c: any) => {
        if (!/^candidates\/[^:]+\.json$/.test(c.path) || c.path.split(/[\\/]/).includes('..')) throw new Error('非法候选路径');
        const document = await json(join(round, c.path)); return { name: document.name, document };
      }));
      const names = new Set(candidates.map((c) => c.name));
      const workspace = { ...base, templates: [...base.templates.filter((t) => !names.has(t.name)), ...candidates] };
      const dataset = workspace.datasets.find((d) => d.id === record.inputs.dataset)!;
      await measure(source.id, source.label, workspace, req, (dataset.document as any).data, round, undefined, undefined, undefined,
        await resourceFingerprint(record.inputs.resources));
    }
  }
  const find = (id: string) => rows.find((r) => r.id === id)!;
  const station = (id: string) => find(id).metrics.roles.find((r: any) => r.id === 'stations');
  const checks = [
    { name: '受控和派生输入均无严重渲染问题', pass: rows.filter((r) => ['controlled-mutation', 'counterfactual-input'].includes(r.origin))
      .every((r) => !r.renderProblems.some((p: any) => p.level === 'severe')) },
    { name: '正例匹配已覆盖内容', pass: find('control').metrics.content === 'matched' },
    { name: '空骨架未匹配站名与时刻', pass: station('empty-skeleton')?.matched === 0 && find('empty-skeleton').metrics.content === 'mismatch' },
    { name: '漏站被识别', pass: station('missing-station').matched === data.stops.length - 1 },
    { name: '逆序即使内容齐全也被识别', pass: station('reverse-stations').matched === data.stops.length && station('reverse-stations').inversionRate === 1 },
    { name: '缺时刻被识别', pass: find('missing-times').metrics.roles.find((r: any) => r.id === 'service-times').matched === 2 },
    { name: '字号减半内容仍匹配，但文字偏差增大', pass: station('small-stations').matched === data.stops.length && station('small-stations').geometry.meanFontLogError > 0.5 },
    { name: '位置偏移进入结构指标', pass: station('shift-stations').geometry.meanCenterError > 0.005 },
    { name: '区域分界变化不冒充内容缺失', pass: find('raised-divider').metrics.content === 'matched' && station('raised-divider').geometry.meanCenterError > 0 },
    { name: '缺地标被识别', pass: find('missing-landmarks').metrics.roles.find((r: any) => r.id === 'landmarks').matched === 0 },
    { name: '陌生标签保留证据并待核查', pass: station('extra-label').matched === data.stops.length &&
      station('extra-label').unassignedText.some((e: any) => e.value === '虚构站') && find('extra-label').metrics.content !== 'matched' },
    { name: '写死示例在原数据上仍匹配', pass: find('frozen-example').metrics.content === 'matched' },
    ...['rename', 'swap', 'current-index', 'no-badges'].map((kind) => ({ name: `${kind} 正常绑定可适应`, pass: find(`counter-${kind}-bound`).metrics.content === 'matched' })),
    ...['rename', 'swap', 'current-index'].map((kind) => ({ name: `${kind} 揭示写死值`, pass: find(`counter-${kind}-frozen`).metrics.content === 'mismatch' })),
  ];
  const report = { format: 'renderweave-fidelity-experiment/1', createdAt: new Date().toISOString(),
    scope: 'M402 离线校准；布局证据不等于完整视觉验收，未引入权重总分或正式门槛',
    sourceFingerprint, resources: [...resources].map(([path, value]) => ({ path, ...value })),
    replayNote: '当前环境离线重放；历史未单独记录资源内容版本，不能据当前资源指纹还原历史资源',
    contract: m402DisplayContract(data, 5), checks, rows };
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ checksPassed: checks.filter((c) => c.pass).length, checks: checks.length, report: join(outDir, 'report.json') }));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'controls-only': { type: 'boolean' } }, strict: true });
  if (!values.out) throw new Error('需要 --out <新目录>');
  const result = await runFidelityExperiment(resolve(values.out), !values['controls-only']);
  process.exitCode = result.checks.every((c) => c.pass) ? 0 : 1;
}
