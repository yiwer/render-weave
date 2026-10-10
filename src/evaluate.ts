/**
 * 求值：按作用域重新读取模板画板，得到绑定、状态样式、条件显示与插槽都已取值的静态元素树（M102 第 4 步）。
 *
 * 缺值时不回退到设计时的占位内容（M16），按属性类型取"空"（M119）：颜色为透明，是否显示为否，
 * 图片不画内容，插槽为空文字；数值没有"空"，缺值或超出属性的取值范围时报严重问题，
 * 属性有缺省值时用缺省值，没有时该元素按隐藏处理。
 */
import { displayValue, type DisplayFormat } from './display-format.js';
import { formatElementPath } from './element-path.js';
import { plainNumber } from './decimal.js';
import { ProblemCodes, severe, type Problem } from './problems.js';
import { parseResourceRef } from './resources.js';
import { stateKey } from './template/check.js';
import { normalizeColor } from './template/declarations.js';
import type { ArtboardModel, Color, ElementModel, TemplateModel, TextElementModel } from './template/model.js';
import { describeRule, readArtboardResolved, satisfies, type BindingHost, type BindingSite, type NumberRule } from './template/parse.js';
import type { Scope } from './template/scope.js';
import { displayKind } from './template/types.js';

export interface EvaluatedNode {
  readonly model: ArtboardModel | ElementModel;
  /** 文本元素求值后的片段，样式已合并上文本元素的设置。 */
  readonly fragments?: readonly EvaluatedFragment[];
  readonly children?: readonly EvaluatedNode[];
}

export interface EvaluatedFragment {
  readonly text: string;
  readonly style: ResolvedStyle;
}

export interface ResolvedStyle {
  /** 字体资源 ID。 */
  readonly font: string;
  readonly fontSize: number;
  readonly color: Color;
  /** 倾斜角度，度。 */
  readonly slant: number;
}

export interface EvaluatedTemplate {
  readonly template: TemplateModel;
  readonly root: EvaluatedNode;
}

const TRANSPARENT = '#00000000';

export function evaluate(scope: Scope): { evaluated?: EvaluatedTemplate; problems: Problem[] } {
  const host = new ResolvingHost(scope);
  const problems = scope.runChecks();
  const { artboard, problems: readProblems } = readArtboardResolved(scope.template, host);
  problems.push(...readProblems, ...host.problems);
  if (!artboard) return { problems };
  return { evaluated: { template: scope.template, root: toNode(artboard) }, problems };
}

/** 先序遍历求值树中会显示的节点：隐藏的元素连同其子元素都跳过（M27）。 */
export function* walkVisible(node: EvaluatedNode): Generator<EvaluatedNode> {
  if (node.model.type !== 'artboard' && !node.model.visible) return;
  yield node;
  for (const child of node.children ?? []) yield* walkVisible(child);
}

/** 文字的全部内容。 */
export function fragmentsText(fragments: readonly EvaluatedFragment[]): string {
  return fragments.map((fragment) => fragment.text).join('');
}

function toNode(model: ArtboardModel | ElementModel): EvaluatedNode {
  switch (model.type) {
    case 'artboard':
    case 'container':
      return { model, children: model.children.map(toNode) };
    case 'text':
      return { model, fragments: model.visible ? fragmentsOf(model) : [] };
    default:
      return { model };
  }
}

function fragmentsOf(model: TextElementModel): EvaluatedFragment[] {
  return model.content.map((item) => ({
    // 求值读取已把插槽换成文字。
    text: item.kind === 'text' ? item.text : '',
    style: {
      font: item.style.font ?? model.font,
      fontSize: item.style.fontSize ?? model.fontSize,
      color: item.style.color ?? model.color,
      slant: item.style.slant ?? model.slant,
    },
  }));
}

/**
 * 求值读取：绑定按作用域取值。数据或参数本身的错误已由校验报告，这里取不到合规的值就当作缺值；
 * 没有通过静态检查的绑定（变量不存在或类型不符，问题已报告）同样当作缺值，不再重复报告。
 */
class ResolvingHost implements BindingHost {
  readonly resolving = true;
  readonly problems: Problem[] = [];

  constructor(private readonly scope: Scope) {}

  color(ref: string): Color {
    return (this.typed(ref, 'color') && normalizeColor(this.scope.value(ref))) || TRANSPARENT;
  }

  number(ref: string, site: BindingSite, rule: NumberRule, fallback: number | undefined): number | undefined {
    if (!this.typed(ref, 'number')) return fallback;
    const value = this.scope.value(ref);
    if (typeof value === 'number' && Number.isFinite(value) && satisfies(value, rule)) return value;
    const what =
      typeof value === 'number' ? `取值 ${plainNumber(value)} 不能用：${site.label} 必须是${describeRule(rule)}` : '缺值，数值属性没有空值';
    const outcome = fallback !== undefined ? `，按缺省值 ${plainNumber(fallback)} 处理` : '，该元素不显示';
    this.problems.push(
      severe(
        ProblemCodes.templateBindingValueInvalid,
        { kind: 'element', path: formatElementPath(site.path) },
        `${site.label} 绑定的 ${ref} ${what}${outcome}（M119）`,
      ),
    );
    return fallback;
  }

  boolean(ref: string): boolean {
    return this.typed(ref, 'boolean') && this.scope.value(ref) === true;
  }

  image(ref: string, site: BindingSite): string | null {
    const value = this.typed(ref, 'image') ? this.scope.value(ref) : undefined;
    if (typeof value !== 'string') return null;
    const id = parseResourceRef(value);
    if (id) return id;
    this.problems.push(
      severe(
        ProblemCodes.templateBindingValueInvalid,
        { kind: 'element', path: formatElementPath(site.path) },
        `${site.label} 绑定的 ${ref} 是 URL 图片（${value}），URL 图片尚未支持，不画内容`,
      ),
    );
    return null;
  }

  slot(ref: string, format: DisplayFormat | undefined): string {
    const resolved = this.scope.table.typeOf(ref);
    const kind = 'type' in resolved ? displayKind(resolved.type) : undefined;
    // 没有通过静态检查的插槽（问题已报告）为空。
    return kind ? displayValue(this.scope.value(ref), kind, format) : '';
  }

  /** 变量的类型是否就是绑定需要的类型。 */
  private typed(ref: string, kind: 'color' | 'number' | 'boolean' | 'image'): boolean {
    const resolved = this.scope.table.typeOf(ref);
    return 'type' in resolved && resolved.type.kind === kind;
  }

  state(ref: string, keys: readonly string[]): string | undefined {
    const value = this.scope.value(ref);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
    const key = stateKey(value);
    return keys.includes(key) ? key : undefined;
  }
}
