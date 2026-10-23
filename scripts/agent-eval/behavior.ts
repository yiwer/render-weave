/** 预登记的独立业务事实，经公开渲染结果核查；不从候选推导预期。 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadWorkspace, render, matchPath, diffTemplate, type LayoutNode, type RenderResult, type Workspace } from '../../src/index.js';
import { loadCanvasKit } from '../../src/canvaskit.js';

type Status = 'pass' | 'fail' | 'notChecked';
type Category = 'field' | 'list' | 'parameter' | 'optional' | 'fit' | 'image' | 'revision';
interface TextFact { id: string; kind: 'texts'; selector: string; expected: string[]; order: 'x' | 'y' }
interface ColorFact { id: string; kind: 'colors'; selector: string; expected: string[][]; order: 'x' | 'y' }
interface VisibilityFact { id: string; kind: 'visibility'; selector: string; expected: boolean }
interface BoxFact { id: string; kind: 'box'; selector: string; expected: Partial<Pick<LayoutNode, 'x' | 'y' | 'width' | 'height'>>; toleranceMm: number }
interface FitFact { id: string; kind: 'fit'; selector: string; expected: { minFontSize: number; maxFontSize: number; minCompression: number } }
interface PixelFact { id: string; kind: 'pixels'; expected: { file: string; sha256: string }; regionMm: { x: number; y: number; width: number; height: number }; tolerance: number }
type Fact = TextFact | ColorFact | VisibilityFact | BoxFact | FitFact | PixelFact;
interface RevisionPolicy { beforeWorkspace: string; targets: string[];
  allowedChanges: { template: string; path: string; target: 'element' | 'template'; properties?: string[]; change?: 'added' | 'removed' }[];
  allowedOutputChanges: { selector: string; properties: string[] }[] }
interface Case { id: string; category: Category; change: string; request: unknown; facts: Fact[]; resources?: { id: string; file: string }[]; revision?: RevisionPolicy }
interface Policy { format: 'renderweave-behavior-policy/1'; id: string; authority: string; cases: Case[] }
interface FactResult { id: string; kind: string; status: Status; expected?: unknown; actual?: unknown; paths?: string[]; reason?: string }
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const save = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const statusOf = (statuses: Status[]): Status => statuses.includes('fail') ? 'fail' : !statuses.length || statuses.includes('notChecked') ? 'notChecked' : 'pass';
const categories: Category[] = ['field', 'list', 'parameter', 'optional', 'fit', 'image'];

export async function runBehavior(options: { policy: string; workspace: string; resources: string; out: string }) {
  const bytes = await readFile(options.policy, 'utf8'), input: unknown = JSON.parse(bytes);
  if (!record(input) || input['format'] !== 'renderweave-behavior-policy/1' || typeof input['id'] !== 'string' || !Array.isArray(input['cases'])) throw new Error('业务案例政策格式错误');
  const policy = input as Policy, ids = new Set<string>();
  for (const test of policy.cases) {
    if (!record(test) || typeof test.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(test.id) || ids.has(test.id) || !Array.isArray(test.facts) || ![...categories, 'revision'].includes(test.category)) throw new Error('案例须有唯一安全 ID、支持的 category 和 facts 列表');
    const factIds = new Set<string>();
    for (const fact of test.facts) {
      if (!record(fact) || typeof fact.id !== 'string' || !fact.id || factIds.has(fact.id) || typeof fact.kind !== 'string') throw new Error('事实须有唯一 ID 和 kind');
      factIds.add(fact.id);
    }
    if (test.revision && (!record(test.revision) || typeof test.revision.beforeWorkspace !== 'string' || !Array.isArray(test.revision.targets) || !Array.isArray(test.revision.allowedChanges) || !Array.isArray(test.revision.allowedOutputChanges))) throw new Error('修改政策须预登记基线、目标事实和允许变化');
    ids.add(test.id);
  }
  const workspace = await loadWorkspace({ dir: options.workspace, resourcesDir: options.resources });
  await mkdir(options.out, { recursive: true });
  await writeFile(join(options.out, 'policy.json'), bytes, { flag: 'wx' });
  await save(join(options.out, 'workspace.json'), { staticSchemas: workspace.staticSchemas, templates: workspace.templates, datasets: workspace.datasets });
  const cases: { id: string; category: Category; status: Status; [key: string]: unknown }[] = [];
  for (const test of policy.cases) {
    const folder = join(options.out, test.id); await mkdir(folder, { recursive: true });
    await save(join(folder, 'request.json'), test.request);
    const overrides = new Map<string, Uint8Array>();
    for (const entry of test.resources ?? []) {
      if (workspace.resources.get(entry.id)?.kind !== 'image') throw new Error(`资源变化只接受已有图片：${entry.id}`);
      overrides.set(entry.id, await readFile(resolve(dirname(options.policy), entry.file)));
    }
    const consumed = new Map<string, Uint8Array>();
    const resources = { get: (id: string) => workspace.resources.get(id), list: () => workspace.resources.list(), read: async (id: string) => {
      if (!consumed.has(id)) consumed.set(id, overrides.get(id) ?? await workspace.resources.read(id)); return consumed.get(id)!;
    } };
    const result = await render({ ...workspace, resources }, test.request, { comparisonEvidence: true });
    await save(join(folder, 'render.json'), { problems: result.problems, layout: result.layout, nodes: result.evidence?.nodes });
    const image = result.evidence?.image ?? result.image;
    const imageFile = image ? `output.${image.format}` : null;
    if (image && imageFile) await writeFile(join(folder, imageFile), image.bytes);
    const facts = typeof policy.authority === 'string' && policy.authority.trim() && test.change && test.facts.length
      ? await Promise.all(test.facts.map((fact) => fact.kind === 'pixels' ? pixels(fact, result, dirname(options.policy), folder) : measure(fact, result)))
      : [{ id: 'independent-facts', kind: 'policy', status: 'notChecked' as const, reason: '缺少独立事实来源或预登记输入变化' }];
    const severe = result.problems.filter((p) => p.level === 'severe').length;
    let revision;
    if (test.revision) {
      const before = await loadWorkspace({ dir: resolve(dirname(options.policy), test.revision.beforeWorkspace), resourcesDir: options.resources });
      const baseline = await render({ ...before, resources }, test.request, { comparisonEvidence: true });
      await save(join(folder, 'before-workspace.json'), { staticSchemas: before.staticSchemas, templates: before.templates, datasets: before.datasets });
      await save(join(folder, 'before-render.json'), { problems: baseline.problems, layout: baseline.layout, nodes: baseline.evidence?.nodes });
      const beforeImage = baseline.evidence?.image ?? baseline.image;
      if (beforeImage) await writeFile(join(folder, `before.${beforeImage.format}`), beforeImage.bytes);
      revision = revisionResult(test.revision, before, workspace, baseline, result, facts);
    }
    const resourceEvidence = [];
    await mkdir(join(folder, 'resources'), { recursive: true });
    for (const [id, content] of consumed) {
      const digest = hash(content), file = `${test.id}/resources/${digest}`;
      await writeFile(join(options.out, file), content); resourceEvidence.push({ id, kind: resources.get(id)?.kind, sha256: digest, file });
    }
    const revisionStatus = revision ? statusOf([revision.targets, revision.nonTargets]) : test.category === 'revision' ? 'notChecked' : 'pass';
    cases.push({ id: test.id, category: test.category, change: test.change, status: statusOf([...facts.map((f) => f.status), revisionStatus, ...(!image || severe ? ['fail' as const] : [])]),
      ...(revision ? { revision } : {}),
      technical: { severe, problems: result.problems }, facts, evidence: { request: `${test.id}/request.json`, render: `${test.id}/render.json`, image: imageFile ? `${test.id}/${imageFile}` : null,
        requestSha256: hash(`${JSON.stringify(test.request, null, 2)}\n`), imageSha256: image ? hash(image.bytes) : null, resources: resourceEvidence } });
  }
  const missing = categories.filter((category) => !cases.some((c) => c.category === category));
  const report = { format: 'renderweave-behavior-report/1', id: policy.id, status: statusOf(cases.map((c) => c.status)),
    coverage: { measuredCategories: categories.filter((category) => cases.some((c) => c.category === category && c.status === 'pass')), missingCategories: missing,
      complete: missing.length === 0 && cases.every((c) => c.status === 'pass') },
    policy: { file: 'policy.json', sha256: hash(bytes), authority: policy.authority ?? null },
    candidates: { file: 'workspace.json', sha256: hash(`${JSON.stringify({ staticSchemas: workspace.staticSchemas, templates: workspace.templates, datasets: workspace.datasets }, null, 2)}\n`) },
    scope: '仅判定预登记事实；未列维度、完整样式与感知相似度未核查', cases };
  await save(join(options.out, 'behavior.json'), report);
  return report;
}

function revisionResult(policy: RevisionPolicy, before: Workspace, after: Workspace, oldResult: RenderResult, newResult: RenderResult, facts: FactResult[]) {
  const changes = [...new Set([...before.templates, ...after.templates].map((t) => t.name))].flatMap((name) => {
    const old = before.templates.find((t) => t.name === name)?.document, next = after.templates.find((t) => t.name === name)?.document;
    if (old === undefined || next === undefined) return [{ template: name, path: name, target: 'template', change: old === undefined ? 'added' : 'removed', property: '*' }];
    return diffTemplate(old, next).flatMap((change) => (change.properties?.map((p) => p.key) ?? ['*']).map((property) => ({ template: name, path: change.path, target: change.target, change: change.change, property })));
  });
  const violations = changes.filter((change) => !policy.allowedChanges.some((a) => a.template === change.template && a.path === change.path && a.target === change.target && (change.change === 'changed' ? a.properties?.includes(change.property) : a.change === change.change)));
  const project = (result: RenderResult) => new Map(nodesOf(result, true).map((n) => [n.path, { visible: n.visible, box: { x: n.x, y: n.y, width: n.width, height: n.height }, text: n.text?.content,
    colors: n.text?.fragments.map((f) => f.color), fontSizes: n.text?.fragments.map((f) => f.fontSize), fonts: n.text?.fragments.map((f) => f.font), image: n.image, type: n.type }]));
  const old = project(oldResult), next = project(newResult), outputChanges: { path: string; property: string; before: unknown; after: unknown }[] = [];
  for (const path of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(path), b = next.get(path);
    if (!a || !b) { outputChanges.push({ path, property: '*', before: a, after: b }); continue; }
    for (const property of Object.keys(a) as (keyof typeof a)[]) if (JSON.stringify(a[property]) !== JSON.stringify(b[property])) outputChanges.push({ path, property, before: a[property], after: b[property] });
  }
  const outputViolations = outputChanges.filter((c) => !policy.allowedOutputChanges.some((a) => matchPath(a.selector, c.path) && a.properties.includes(c.property)));
  const targetStatuses = policy.targets.map((id) => facts.find((f) => f.id === id)?.status ?? 'notChecked');
  const baselineValid = !!oldResult.layout && !oldResult.problems.some((p) => p.level === 'severe');
  return { targets: statusOf(targetStatuses), nonTargets: !baselineValid ? 'notChecked' as const : violations.length || outputViolations.length ? 'fail' as const : 'pass' as const,
    changes, violations, outputChanges, outputViolations, scope: '结构及公开布局的非目标保留；未测量的感知差异仍需核准像素或人工审核' };
}

async function pixels(fact: PixelFact, result: RenderResult, policyDir: string, folder: string): Promise<FactResult> {
  const base = { id: fact.id, kind: fact.kind, expected: fact.expected };
  const box = fact.regionMm;
  if (!box || !Object.values(box).every(Number.isFinite) || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || !Number.isFinite(fact.tolerance) || fact.tolerance < 0 || fact.tolerance > 255 || !fact.expected?.file || !/^[a-f0-9]{64}$/.test(fact.expected.sha256)) return { ...base, status: 'notChecked', reason: '缺少核准区域、内容哈希或像素容差' };
  const approved = await readFile(resolve(policyDir, fact.expected.file));
  if (hash(approved) !== fact.expected.sha256) return { ...base, status: 'notChecked', reason: '核准图片内容与预登记哈希不同' };
  await writeFile(join(folder, `approved-${fact.expected.sha256}.png`), approved);
  const ck = await loadCanvasKit(), expected = ck.MakeImageFromEncoded(approved), actual = ck.MakeImageFromEncoded((result.evidence?.image ?? result.image)?.bytes ?? new Uint8Array());
  try {
    if (!expected || !actual || !result.layout) return { ...base, status: 'notChecked', reason: '无法解码核准图片或实际出图' };
    const scale = result.layout.output.dpi / 25.4;
    const [x, y, w, h] = [box.x, box.y, box.width, box.height].map((n) => Math.round(n * scale)) as [number, number, number, number];
    if (w !== expected.width() || h !== expected.height()) return { ...base, status: 'notChecked', reason: '核准区域像素尺寸与本次出图不一致；必须事先核准同DPI参考' };
    if (x + w > actual.width() || y + h > actual.height()) return { ...base, status: 'fail', reason: '核准区域越出画板' };
    const info = { width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB };
    const e = expected.readPixels(0, 0, info), a = actual.readPixels(x, y, info);
    if (!(e instanceof Uint8Array) || !(a instanceof Uint8Array)) return { ...base, status: 'notChecked', reason: '无法读取区域像素' };
    let mismatchedPixels = 0;
    for (let i = 0; i < e.length; i += 4) if ([0, 1, 2, 3].some((c) => Math.abs(e[i + c]! - a[i + c]!) > fact.tolerance)) mismatchedPixels++;
    return { ...base, status: mismatchedPixels ? 'fail' : 'pass', actual: { regionMm: box, pixels: w * h, mismatchedPixels }, reason: `核准参考已留存 approved-${fact.expected.sha256}.png；逐区域像素比较，不用整图哈希判通过` };
  } finally { expected?.delete(); actual?.delete(); }
}

function nodesOf(result: RenderResult, includeHidden = false): LayoutNode[] {
  const nodes: LayoutNode[] = [];
  const visit = (node: LayoutNode, parent: boolean) => { const visible = parent && node.visible; if (includeHidden || visible) nodes.push({ ...node, visible }); node.children?.forEach((child) => visit(child, visible)); };
  if (result.layout) visit(result.layout.root, true);
  return nodes;
}

function measure(fact: Fact, result: RenderResult): FactResult {
  if (fact.kind === 'fit' && record(fact.expected) && [fact.expected.minFontSize, fact.expected.maxFontSize, fact.expected.minCompression].every((v) => Number.isFinite(v) && v > 0)) {
    const nodes = nodesOf(result).filter((n) => matchPath(fact.selector, n.path));
    const actual = nodes.map((n) => { const trace = result.evidence?.nodes.find((e) => e.path === n.path); return { path: n.path, fontSizes: n.text?.fragments.map((f) => f.fontSize), compression: n.text?.compression, overflow: n.text?.overflow, ink: trace?.inkBounds, transformed: trace?.transformed }; });
    const failed = !nodes.length || actual.some((n) => !n.fontSizes || n.fontSizes.some((s) => s < fact.expected.minFontSize || s > fact.expected.maxFontSize) || n.compression! < fact.expected.minCompression || n.overflow || n.ink && (n.ink.x < -0.01 || n.ink.y < -0.01 || n.ink.x + n.ink.width > result.layout!.output.width + 0.01 || n.ink.y + n.ink.height > result.layout!.output.height + 0.01));
    const all = nodesOf(result);
    // 公共摘要无法判定后画元素的实际遮挡面积：有相交即留未知，不能仅凭文字墨迹在画板内放行。
    const overlapping = actual.some((n) => n.ink && all.slice(all.findIndex((a) => a.path === n.path) + 1).some((a) => !n.path.startsWith(`${a.path}/`) && !['artboard', 'container', 'loop', 'call'].includes(a.type) && a.x < n.ink!.x + n.ink!.width && a.x + a.width > n.ink!.x && a.y < n.ink!.y + n.ink!.height && a.y + a.height > n.ink!.y));
    const unknown = overlapping || actual.some((n) => !n.ink || n.transformed);
    return { id: fact.id, kind: fact.kind, expected: fact.expected, actual, status: failed ? 'fail' : unknown ? 'notChecked' : 'pass', ...(unknown ? { reason: '可能遮挡、复杂变换或缺少墨迹证据，未核查适配可见性；需要核准像素事实' } : {}) };
  }
  if (fact.kind === 'visibility' && typeof fact.expected === 'boolean') {
    const nodes = nodesOf(result, true).filter((n) => matchPath(fact.selector, n.path));
    return { id: fact.id, kind: fact.kind, expected: fact.expected, actual: nodes.map((n) => n.visible), paths: nodes.map((n) => n.path), status: nodes.length > 0 && nodes.every((n) => n.visible === fact.expected) ? 'pass' : 'fail' };
  }
  if (fact.kind === 'box' && record(fact.expected) && Number.isFinite(fact.toleranceMm) && fact.toleranceMm >= 0) {
    const nodes = nodesOf(result).filter((n) => matchPath(fact.selector, n.path));
    const keys = Object.keys(fact.expected) as ('x' | 'y' | 'width' | 'height')[];
    const actual = nodes.map((n) => Object.fromEntries(keys.map((k) => [k, n[k]])));
    return { id: fact.id, kind: fact.kind, expected: fact.expected, actual, paths: nodes.map((n) => n.path), status: keys.length > 0 && nodes.length === 1 && keys.every((k) => Number.isFinite(fact.expected[k]) && Math.abs(nodes[0]![k] - fact.expected[k]!) <= fact.toleranceMm) ? 'pass' : 'fail' };
  }
  if (!record(fact) || (fact.kind !== 'texts' && fact.kind !== 'colors') || typeof fact.selector !== 'string' || !Array.isArray(fact.expected) || !['x', 'y'].includes(fact.order)) return { id: fact?.id ?? '', kind: fact?.kind ?? 'unknown', status: 'notChecked', reason: '缺少支持的独立事实或测量方式' };
  const nodes = nodesOf(result).filter((n) => matchPath(fact.selector, n.path)).sort((a, b) => a[fact.order] - b[fact.order]);
  const color = (c: string) => c.toUpperCase().padEnd(9, 'F');
  const actual = fact.kind === 'texts' ? nodes.map((n) => n.text?.content ?? null) : nodes.map((n) => [...new Set(n.text?.fragments.map((f) => color(f.color)) ?? [])]);
  const expected = fact.kind === 'texts' ? fact.expected : fact.expected.map((list) => [...new Set(list.map(color))]);
  const ambiguous = nodes.some((node, index) => index > 0 && Math.abs(node[fact.order] - nodes[index - 1]![fact.order]) < 0.001);
  const matches = JSON.stringify(actual) === JSON.stringify(expected);
  return { id: fact.id, kind: fact.kind, expected, actual, paths: nodes.map((n) => n.path), status: !matches ? 'fail' : ambiguous ? 'notChecked' : 'pass', ...(ambiguous ? { reason: '匹配实例在所选空间轴存在顺序歧义，不能按遍历顺序放行' } : {}) };
}
