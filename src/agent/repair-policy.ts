/** 核准参考的修复策略：完整测量留宿主，两条区域反馈交给模型。 */
import type { LayoutReference, RepairCheck } from './layout-reference.js';

export interface RepairPolicy {
  readonly approval: 'approved';
  readonly regions: readonly { readonly id: string; readonly paths: readonly string[] }[];
  readonly references: readonly { readonly case: string; readonly geometry: boolean; readonly reference: LayoutReference }[];
}

const text = { type: 'string', minLength: 1, maxLength: 500 } as const;
const positive = { type: 'number', exclusiveMinimum: 0 } as const;
export const REPAIR_POLICY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['approval', 'regions', 'references'], properties: {
    approval: { const: 'approved' },
    regions: { type: 'array', minItems: 1, maxItems: 32, items: {
      type: 'object', additionalProperties: false, required: ['id', 'paths'], properties: {
        id: text, paths: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true, items: text },
      },
    } },
    references: { type: 'array', minItems: 1, maxItems: 24, items: {
      type: 'object', additionalProperties: false, required: ['case', 'geometry', 'reference'], properties: {
        case: text, geometry: { type: 'boolean' }, reference: {
          type: 'object', additionalProperties: false, required: ['basis', 'width', 'height', 'elements'], properties: {
            basis: text, width: positive, height: positive,
            elements: { type: 'array', minItems: 1, maxItems: 500, items: {
              type: 'object', additionalProperties: false, required: ['path', 'role', 'type', 'box', 'boxKind'], properties: {
                path: text, role: text, type: text, boxKind: { enum: ['layout', 'ink'] },
                box: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: {
                  x: { type: 'number' }, y: { type: 'number' }, width: positive, height: positive,
                } },
                text: { type: 'string', minLength: 1, maxLength: 10000 }, image: text,
                characters: { type: 'array', minItems: 1, maxItems: 10000, items: {
                  type: 'object', additionalProperties: false, required: ['text', 'size', 'color'], properties: {
                    text: { type: 'string', minLength: 1, maxLength: 2 }, size: positive,
                    color: { type: 'string', pattern: '^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$' },
                  },
                } },
              },
            } },
          },
        },
      },
    } },
  },
} as const;

/** Schema 之外的交叉约束；核准是宿主声明，不接受 Agent 在 outcome 中自报。 */
export function validateRepairPolicy(policy: RepairPolicy, cases: readonly string[], sampleHash?: string): void {
  const ids = policy.references.map(r => r.case);
  if (!sampleHash || ids.length !== cases.length || new Set(ids).size !== ids.length || cases.some(id => !ids.includes(id))) {
    throw new Error('修复策略必须绑定示例图，并为全部登记用例提供唯一核准参考');
  }
  if (new Set(policy.regions.map(r => r.id)).size !== policy.regions.length) throw new Error('修复区域 ID 重复');
  const paths = policy.regions.flatMap(r => r.paths);
  if (new Set(paths).size !== paths.length) throw new Error('同一参考路径不能属于多个修复区域');
  const all = new Set<string>();
  for (const { reference } of policy.references) {
    if (!reference.basis.trim() || new Set(reference.elements.map(e => e.path)).size !== reference.elements.length) throw new Error('参考依据为空或元素路径重复');
    for (const e of reference.elements) {
      all.add(e.path);
      if ((e.text === undefined) === (e.image === undefined)) throw new Error('参考元素必须明确为文字或图片');
      if (e.text !== undefined && (!e.characters || e.characters.some(c => [...c.text].length !== 1) || e.characters.map(c => c.text).join('') !== e.text)) {
        throw new Error('文字参考必须有与内容逐字对齐的显式字号与颜色');
      }
      if (!paths.includes(e.path)) throw new Error(`参考元素没有核准区域：${e.path}`);
    }
  }
  if (paths.some(path => !all.has(path))) throw new Error('修复区域引用了未登记的参考元素');
}

export interface RepairMeasurement {
  readonly checks: readonly RepairCheck[];
  readonly complete: boolean;
  readonly passed: boolean;
  readonly failed: number;
  readonly unknown: number;
  readonly feedback: string;
}
export interface RepairDecision {
  readonly stop: boolean;
  readonly reason: 'complete' | 'checksFailed' | 'technicalFailure' | 'pendingReview';
  readonly fingerprint: string;
  readonly checked: number;
  readonly failed: number;
  readonly unknown: number;
  readonly feedback: string;
  readonly scope: string;
}

export function measureRepairPolicy(policy: RepairPolicy, expected: readonly string[], checks: readonly RepairCheck[]): RepairMeasurement {
  const actual = new Set(checks.map(c => c.id));
  const complete = expected.length > 0 && new Set(expected).size === expected.length && actual.size === checks.length &&
    actual.size === expected.length && expected.every(id => actual.has(id));
  const failed = checks.filter(c => c.pass !== true || c.status !== 'measured').length;
  const unknown = checks.filter(c => c.status !== 'measured').length;
  const priority = { content: 0, font: 1, position: 2, size: 3, color: 4 };
  const byPath = new Map(policy.regions.flatMap(r => r.paths.map(path => [path, r.id] as const)));
  const regionByCheck = new Map(policy.references.flatMap(r => r.reference.elements.flatMap(e =>
    (['content', 'font', 'position', 'size', 'color'] as const).map(d => [r.case + '/' + e.path + ':' + d, byPath.get(e.path)!] as const))));
  const selected: { region: string; check: RepairCheck }[] = [];
  for (const check of checks.filter(c => !c.pass || c.status !== 'measured').toSorted((a, b) =>
    priority[a.dimension] - priority[b.dimension] || b.severity - a.severity || a.id.localeCompare(b.id))) {
    // 缺失元素仍用登记路径归组，不宣称已匹配到候选路径。
    const region = regionByCheck.get(check.id) ?? '完整性';
    if (!selected.some(item => item.region === region)) selected.push({ region, check });
    if (selected.length === 2) break;
  }
  const items = selected.map(({ region, check }) => ({ region: region.slice(0, 80), dimension: check.dimension,
    difference: check.detail.slice(0, 180), path: check.path?.slice(0, 120) ?? null }));
  // JSON 的控制字符转义也计入预算；整条删除，不截成无效 JSON。
  const encode = () => '宿主登记检查（最多两项，未列出不表示通过）：\n' + JSON.stringify(items) + '\n按参考图局部修复，保持绑定；布局检查不代表最终墨迹可见或人工认可。';
  while (encode().length > 1200 && items.length) items.pop();
  return { checks, complete, passed: complete && failed === 0, failed, unknown, feedback: encode() };
}

export function decideRepair(measurement: RepairMeasurement, fingerprint: string, qualified: boolean, pending: number): RepairDecision {
  const reason = !qualified ? 'technicalFailure' : pending > 0 ? 'pendingReview' : measurement.passed ? 'complete' : 'checksFailed';
  return { stop: reason === 'complete', reason, fingerprint, checked: measurement.checks.length, failed: measurement.failed, unknown: measurement.unknown,
    feedback: measurement.feedback, scope: '仅表示当前候选的登记布局、内容及用例检查完成；仍需人工视觉审核。' };
}
