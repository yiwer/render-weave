/** 宿主执行声明的边界/样式核查；像素诊断与未覆盖要求不冒充设计验收。 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { severe, ProblemCodes, type Problem } from '../problems.js';
import type { LayoutNode } from '../layout/index.js';
import { measureRender, render } from '../render.js';
import { isRecord } from '../util.js';
import type { Workspace } from '../workspace.js';
import type { CandidateDocument } from './candidates.js';
import { canonical } from './diff.js';
import { compareDesignImages, type ImageDifference, type ImageRegion } from './image-comparison.js';
import { sha256 } from './round-files.js';

type Range = { readonly min: number; readonly max: number };
type DataChange = { readonly path: string; readonly op: 'set' | 'remove' | 'resize'; readonly value?: unknown; readonly length?: number };
interface CheckCase {
  readonly id: string; readonly changes?: readonly DataChange[];
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly output?: { readonly width: number; readonly height: number };
}
interface StyleCheck {
  readonly id: string; readonly path: string; readonly cases?: readonly string[];
  readonly minCount?: number; readonly maxCount?: number;
  readonly expect: { readonly fontSize?: Range; readonly spacing?: Range; readonly colors?: readonly string[];
    readonly x?: Range; readonly y?: Range; readonly width?: Range; readonly height?: Range };
}
export interface DesignCheckPlan {
  readonly format: 'renderweave-design-checks/1';
  /** 人工核准依据或推断来源；数字要求只对这份计划成立。 */
  readonly basis: string;
  readonly cases: readonly CheckCase[];
  readonly styles: readonly StyleCheck[];
  readonly reference?: { readonly sha256: string; readonly region?: ImageRegion };
}
const range = { type: 'object', additionalProperties: false, required: ['min', 'max'], properties: { min: { type: 'number' }, max: { type: 'number' } } };
const text = { type: 'string', minLength: 1, maxLength: 300 };
export const DESIGN_CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['format', 'basis', 'cases', 'styles'], properties: {
    format: { const: 'renderweave-design-checks/1' }, basis: { type: 'string', minLength: 1, maxLength: 2000 },
    cases: { type: 'array', maxItems: 23, items: { type: 'object', additionalProperties: false, required: ['id'], properties: {
      id: text, parameters: { type: 'object' },
      output: { type: 'object', additionalProperties: false, required: ['width', 'height'], properties: {
        width: { type: 'number', exclusiveMinimum: 0, maximum: 10000 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 10000 } } },
      changes: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['path', 'op'], properties: {
        path: { ...text, pattern: '^/' }, op: { enum: ['set', 'remove', 'resize'] }, value: {}, length: { type: 'integer', minimum: 0, maximum: 1000 },
      } } },
    } } },
    styles: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['id', 'path', 'expect'], properties: {
      id: text, path: text, cases: { type: 'array', minItems: 1, uniqueItems: true, items: text },
      minCount: { type: 'integer', minimum: 0 }, maxCount: { type: 'integer', minimum: 0 },
      expect: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        fontSize: range, spacing: range, x: range, y: range, width: range, height: range,
        colors: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$' } },
      } },
    } } },
    reference: { type: 'object', additionalProperties: false, required: ['sha256'], properties: {
      sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      region: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: {
        x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
        width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 },
      } },
    } },
  },
} as const;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(DESIGN_CHECK_SCHEMA);

export function parseDesignCheckPlan(value: unknown): DesignCheckPlan {
  if (JSON.stringify(value).length > 100_000 || !validate(value)) throw new Error('核查计划格式不合法：' +
    (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('；'));
  const plan = value as DesignCheckPlan;
  const ids = ['reference', ...plan.cases.map((c) => c.id)];
  if (new Set(ids).size !== ids.length || new Set(plan.styles.map((s) => s.id)).size !== plan.styles.length) throw new Error('核查 ID 重复；reference 是保留的原始请求用例');
  for (const c of plan.cases) for (const change of c.changes ?? []) {
    pointer(change.path);
    if ((change.op === 'resize' && change.length === undefined) || (change.op === 'set' && !Object.hasOwn(change, 'value'))) throw new Error('resize 必须有 length；set 必须有 value');
  }
  for (const style of plan.styles) {
    if (style.cases?.some((id) => !ids.includes(id))) throw new Error(`样式 ${style.id} 引用了未知用例`);
    if ((style.maxCount ?? Infinity) < (style.minCount ?? 1)) throw new Error('样式数量范围颠倒');
    for (const value of Object.values(style.expect)) if (isRecord(value) && Number(value['min']) > Number(value['max'])) throw new Error('样式数值范围颠倒');
  }
  return plan;
}

export interface DesignVerification {
  readonly status: 'passed' | 'failed';
  readonly fingerprint: string;
  readonly planSha256: string;
  readonly cases: readonly { readonly id: string; readonly passed: boolean; readonly problems: readonly string[];
    readonly checkedInstances: number; readonly visibleInstances: number; readonly uncoveredCount: number; readonly uncovered: readonly string[] }[];
  readonly failureCount: number;
  readonly failures: readonly { readonly case: string; readonly style?: string; readonly path?: string; readonly message: string }[];
  readonly visual?: ImageDifference;
  readonly content: 'needsReview';
}

export interface DesignCheckInput { readonly plan: DesignCheckPlan; readonly sampleFile: string }

/** 成果、审核和应用共用；核查本身不可用也不能绕过声明的要求。 */
export async function assessDesign(workspace: Workspace, candidates: readonly CandidateDocument[], request: Record<string, unknown> | undefined,
  input: DesignCheckInput | undefined): Promise<{ report?: DesignVerification; problems: Problem[] }> {
  if (!input) return { problems: [] };
  try {
    if (!request) throw new Error('缺少核查请求');
    const { report } = await verifyTemplateDesign({ workspace, candidates, request, plan: input.plan, sample: await readFile(input.sampleFile) });
    return { report, problems: report.status === 'failed' ? [severe(ProblemCodes.outcomeInvalid, { kind: 'input', source: 'design-checks.json' },
      `设计核查 ${report.failureCount} 项失败：${report.failures.slice(0, 5).map((f) => `${f.case}/${f.path ?? f.style ?? ''}：${f.message}`).join('；')}`)] : [] };
  } catch (error) { return { problems: [severe(ProblemCodes.outcomeInvalid, { kind: 'input', source: 'design-checks.json' }, `设计核查未完成：${error instanceof Error ? error.message : String(error)}`)] }; }
}

/** 每次从当前文档和资源重算，不读旧报告；图像只在 reference 原始数据用例比较。 */
export async function verifyTemplateDesign(options: {
  readonly workspace: Workspace; readonly candidates: readonly CandidateDocument[]; readonly request: Record<string, unknown>;
  readonly plan: DesignCheckPlan; readonly sample?: Uint8Array;
}): Promise<{ report: DesignVerification; heatmap?: Uint8Array }> {
  const plan = parseDesignCheckPlan(options.plan), workspace = withCandidateTemplates(options.workspace, options.candidates);
  const datasetRequest = options.request['dataset'];
  const base = isRecord(datasetRequest) && datasetRequest['inline'] !== undefined ? datasetRequest['inline'] :
    isRecord(datasetRequest) ? workspace.datasets.find((d) => d.id === datasetRequest['id'])?.document : undefined;
  if (!isRecord(base) || !Object.hasOwn(base, 'data')) throw new Error('核查需要请求中的完整数据集');
  const resources = [];
  for (const item of [...workspace.resources.list()].sort((a, b) => a.id.localeCompare(b.id))) {
    try { resources.push({ ...item, sha256: sha256(await workspace.resources.read(item.id)) }); }
    catch { resources.push({ ...item, sha256: null }); }
  }
  const planSha256 = sha256(canonical(plan));
  const fingerprint = sha256(canonical({ plan, request: options.request, base, templates: workspace.templates,
    candidates: options.candidates, schemas: workspace.staticSchemas, resources, sample: options.sample ? sha256(options.sample) : null }));
  const failures: { case: string; style?: string; path?: string; message: string }[] = [];
  const cases = [];
  let visual: ImageDifference | undefined, heatmap: Uint8Array | undefined;
  for (const c of [{ id: 'reference' }, ...plan.cases] as readonly CheckCase[]) {
    const before = failures.length;
    const fail = (message: string, path?: string, style?: string) => failures.push({ case: c.id, message, ...(path ? { path } : {}), ...(style ? { style } : {}) });
    const dataset = structuredClone(base);
    let nodes: LayoutNode[] = [], covered = new Set<string>(), problems: string[] = [];
    try {
      for (const change of c.changes ?? []) changeData(dataset['data'], change);
      const output: Record<string, unknown> = { ...(isRecord(options.request['output']) ? options.request['output'] : {}), ...c.output };
      // 核查使用物理量。像素上限控制成本，不让大 DPI 或极端尺寸制造过量图像。
      const width = Number(output['width']), height = Number(output['height']);
      const requestedDpi = Number(output['dpi'] ?? 100);
      const dpi = Math.max(1, Math.min(requestedDpi, 150, Math.floor(2048 * 25.4 / Math.max(width, height))));
      const request = { ...options.request, mode: 'draft', dataset: { inline: dataset },
        parameters: { ...(isRecord(options.request['parameters']) ? options.request['parameters'] : {}), ...c.parameters },
        output: { ...output, dpi, format: 'png' } };
      const measured = measureRender(workspace, request);
      if (measured.measure && (measured.measure.elements > 20000 || measured.measure.loopItems > 5000)) throw new Error('核查展开规模超过 20,000 元素或 5,000 循环项，未执行');
      const result = await render(workspace, request);
      problems = result.problems.filter((p) => p.level === 'severe').map((p) => `${p.code}：${p.message} ${JSON.stringify(p.location)}`);
      problems.forEach((message) => fail(message));
      if (!result.image) fail('未生成图像');
      const walk = (node: LayoutNode) => { if (!node.visible) return; nodes.push(node); node.children?.forEach(walk); };
      if (result.layout) walk(result.layout.root);
      for (const style of plan.styles.filter((s) => !s.cases || s.cases.includes(c.id))) {
        const pattern = new RegExp('^' + style.path.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        const matches = nodes.filter((n) => pattern.test(n.path));
        if (matches.length < (style.minCount ?? 1) || matches.length > (style.maxCount ?? Infinity)) fail(`匹配 ${matches.length} 项，要求 ${style.minCount ?? 1}–${style.maxCount ?? '不限'}`, style.path, style.id);
        for (const node of matches) {
          covered.add(node.path);
          for (const [key, expected] of Object.entries(style.expect)) {
            if (key === 'colors') {
              const normalize = (color: string) => (color.length === 7 ? color + 'ff' : color).toLowerCase();
              const allowed = (expected as readonly string[]).map(normalize);
              if (!node.text || node.text.fragments.some((f) => f.text && !allowed.includes(normalize(f.color)))) fail('文字颜色不在核准范围', node.path, style.id);
            } else {
              const bound = expected as Range;
              const values = key === 'fontSize' ? node.text?.fragments.filter((f) => f.text).map((f) => f.fontSize) :
                key === 'spacing' ? node.text ? [node.text.spacing] : undefined : [node[key as 'x' | 'y' | 'width' | 'height']];
              if (!values?.length || values.some((v) => v < bound.min - 1e-6 || v > bound.max + 1e-6)) fail(`${key} 实际 ${values?.join(', ') ?? '无'} mm，要求 ${bound.min}–${bound.max} mm`, node.path, style.id);
            }
          }
        }
      }
      if (c.id === 'reference' && plan.reference) {
        if (!options.sample || sha256(options.sample) !== plan.reference.sha256) throw new Error('示例图与核查计划的 SHA-256 不符');
        if (result.image) {
          const compared = await compareDesignImages({ reference: options.sample, actual: result.image.bytes,
            widthMm: width, heightMm: height, referenceRegion: plan.reference.region, layout: result.layout?.root });
          visual = compared.report; heatmap = compared.heatmap;
        }
      }
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    // 容器不算独立可见样式；列出所有尚未被声明规则覆盖的叶元素。
    nodes = nodes.filter((n) => !n.children?.length);
    const uncovered = nodes.filter((n) => !covered.has(n.path)).map((n) => n.path);
    cases.push({ id: c.id, passed: before === failures.length, problems: problems.slice(0, 10), checkedInstances: covered.size,
      visibleInstances: nodes.length, uncoveredCount: uncovered.length, uncovered: uncovered.slice(0, 12) });
  }
  return { report: { status: failures.length ? 'failed' : 'passed', fingerprint, planSha256, cases,
    failureCount: failures.length, failures: failures.slice(0, 40), ...(visual ? { visual } : {}), content: 'needsReview' }, ...(heatmap ? { heatmap } : {}) };
}

export function withCandidateTemplates(workspace: Workspace, candidates: readonly CandidateDocument[]): Workspace {
  const templates = candidates.filter((c) => c.kind === 'template' && isRecord(c.document) && typeof c.document['name'] === 'string')
    .map((c) => ({ name: (c.document as { name: string }).name, document: c.document, source: c.path }));
  const names = new Set(templates.map((t) => t.name));
  return { ...workspace, templates: [...workspace.templates.filter((t) => !names.has(t.name)), ...templates] };
}

function pointer(path: string): string[] {
  if (/~(?![01])/.test(path)) throw new Error('非法 JSON Pointer 转义');
  const parts = path.slice(1).split('/').map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (parts.some((p) => ['__proto__', 'constructor', 'prototype'].includes(p))) throw new Error('核查字段路径含保留键');
  return parts;
}

function changeData(data: unknown, change: DataChange): void {
  const parts = pointer(change.path), key = parts.pop()!;
  let parent: unknown = data;
  for (const p of parts) {
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, p)) throw new Error(`字段不存在：${change.path}`);
    parent = (parent as Record<string, unknown>)[p];
  }
  if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error(`字段不存在：${change.path}`);
  const object = parent as Record<string, unknown>;
  if (change.op === 'set') object[key] = structuredClone(change.value);
  else if (change.op === 'remove') {
    if (Array.isArray(parent)) throw new Error('remove 只删除字段；列表长度用 resize');
    delete object[key];
  } else {
    const list = object[key];
    if (!Array.isArray(list) || (!list.length && change.length! > 0)) throw new Error(`无法从原列表生成长度：${change.path}`);
    object[key] = Array.from({ length: change.length! }, (_, i) => structuredClone(list[i % list.length]));
  }
}
