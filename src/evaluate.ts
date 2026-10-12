/**
 * 求值：按作用域重新读取模板画板，得到绑定、状态样式、条件显示与插槽都已取值的静态元素树（M102 第 4 步）。
 *
 * 缺值时不回退到设计时的占位内容（M16），按属性类型取"空"（M119）：颜色为透明，是否显示为否，
 * 图片不画内容，插槽为空文字；数值没有"空"，缺值或超出属性的取值范围时报严重问题，
 * 属性有缺省值时用缺省值，没有时该元素按隐藏处理。
 */
import { displayValue, type DisplayFormat } from './display-format.js';
import { formatElementPath, rootPath, type ElementPath } from './element-path.js';
import { plainNumber } from './decimal.js';
import { ProblemCodes, severe, type Problem } from './problems.js';
import { parseResourceRef } from './resources.js';
import { stateKey } from './template/check.js';
import { normalizeColor } from './template/declarations.js';
import type { ArtboardModel, CallModel, Color, ContainerModel, ElementModel, LoopInfoKey, LoopModel, Place, TemplateModel, TextElementModel } from './template/model.js';
import { describeRule, readArtboardResolved, satisfies, type BindingHost, type BindingSite, type NumberRule } from './template/parse.js';
import { MAX_CODE128_LENGTH } from './template/model.js';
import { Scope, resolveParameters } from './template/scope.js';
import { argumentProblem, type TemplateProgram } from './template/program.js';
import { displayKind } from './template/types.js';
import { fieldOrigin, MissingValues, type DataOrigin } from './template/missing-values.js';
import { groupLoopItems } from './template/loop.js';

export interface EvaluatedNode {
  /** 已定位的缺值或静态问题，供草稿画问题边框；不影响正常布局。 */
  readonly previewProblem?: boolean;
  readonly model: ArtboardModel | Exclude<ElementModel, LoopModel | CallModel>;
  /** 调用与循环展开为普通容器，摘要保留原来的元素类型。 */
  readonly sourceType?: 'loop' | 'call';
  /** 被调画板的尺寸范围，在实际调用框确定后检查。 */
  readonly calledTemplate?: { readonly name: string; readonly sizeRange: ArtboardModel['sizeRange'] };
  /** 合并循环沿原始列划分空间，组宽包含被合并的内部列间距。 */
  readonly loopColumns?: { readonly count: number; readonly gap: number };
  readonly loopGroup?: { readonly index: number; readonly size: number };
  /** 文本元素求值后的片段，样式已合并上文本元素的设置。 */
  readonly fragments?: readonly EvaluatedFragment[];
  readonly children?: readonly EvaluatedNode[];
}

export interface EvaluatedFragment {
  readonly placeholder?: string;
  readonly text: string;
  readonly style: ResolvedStyle;
  /** 缺字替代前的字体资源 ID；仅替代成功的片段携带。 */
  readonly sourceFont?: string;
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

export function evaluate(scope: Scope, program: TemplateProgram, problems: readonly Problem[] = [],
  parameterProblems: readonly Problem[] = []): { evaluated?: EvaluatedTemplate; problems: Problem[] } {
  const expander = new Expander(program, problems);
  const root = expander.expand(scope, rootPath(scope.template.name), false, { path: '' }, parameterProblems);
  return { ...(root && !expander.failed && { evaluated: { template: scope.template, root } }), problems: expander.problems };
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

class Expander {
  readonly problems: Problem[] = [];
  failed = false;
  constructor(private readonly program: TemplateProgram, private readonly inputProblems: readonly Problem[]) {}

  expand(scope: Scope, path: ElementPath, called: boolean, origin?: DataOrigin, parameterProblems: readonly Problem[] = []): EvaluatedNode | undefined {
    const host = new ResolvingHost(scope, new MissingValues(scope, this.inputProblems, origin, parameterProblems));
    const { artboard, problems } = readArtboardResolved(scope.template, host, path);
    if (!artboard) this.failed = true;
    this.problems.push(...scope.runChecks().map((problem) => called && problem.location.kind === 'check'
      ? { ...problem, location: { ...problem.location, path: formatElementPath(path) } } : problem), ...problems, ...host.problems);
    const node = artboard && this.node(artboard, scope, host, origin, path);
    this.problems.push(...scope.problems.map((problem) => called && problem.location.kind === 'variable'
      ? { ...problem, location: { ...problem.location, path: formatElementPath(path) } } : problem));
    return node;
  }

  private node(model: ArtboardModel | ElementModel, scope: Scope, host: ResolvingHost, origin: DataOrigin | undefined, root: ElementPath): EvaluatedNode {
    const node = this.expandNode(model, scope, host, origin, root);
    const staticPath = formatElementPath([{ name: scope.template.name }, ...model.path.slice(root.length)]);
    const problem = host.affected.has(formatElementPath(model.path)) || this.inputProblems.some((p) =>
      p.location.kind === 'element' && p.location.path === staticPath);
    return problem ? { ...node, previewProblem: true } : node;
  }

  private expandNode(model: ArtboardModel | ElementModel, scope: Scope, host: ResolvingHost, origin: DataOrigin | undefined, root: ElementPath): EvaluatedNode {
    if (model.type !== 'artboard' && !model.visible) {
      return { model: model.type === 'loop' || model.type === 'call' ? emptyContainer(model) : model,
        ...(model.type === 'loop' || model.type === 'call' ? { sourceType: model.type } : {}) };
    }
    switch (model.type) {
      case 'artboard':
      case 'container':
        return { model, children: model.children.map((child) => this.node(child, scope, host, origin, root)) };
      case 'text': return { model, fragments: fragmentsOf(model) };
      case 'barcode': return { model, ...(model.showText && model.font && model.content.length <= MAX_CODE128_LENGTH && { fragments: [{ text: model.content,
        style: { font: model.font, fontSize: model.fontSize, color: model.foreground, slant: 0 } }] }) };
      case 'call': {
        const data = model.data === 'current' ? scope.data : model.data === 'none' ? {} : scope.value(model.data.var);
        const childOrigin = model.data === 'current' ? origin : model.data === 'none' ? undefined : fieldOrigin(origin, model.data.var);
        return this.invoke(model, scope, data, model.path, model.place, typeof childOrigin === 'string' ? { path: childOrigin } : childOrigin, model);
      }
      case 'loop': {
        const value = scope.value(model.list.var);
        const items: unknown[] = Array.isArray(value) ? value : [];
        const listType = scope.table.typeOf(model.list.var);
        const wrap = 'type' in listType && listType.type.kind === 'list' && listType.type.items.kind !== 'ref';
        const children = groupLoopItems(items, model.mergeBy).map((group) => {
          const { data: item, index, size } = group;
          const path = [...model.path.slice(0, -1), { name: model.name, index }];
          const width = model.itemLayout.widths;
          const place: Place = { ...EMPTY_PLACE,
            width: width === 'equal' ? { kind: 'fill', weight: 1 } : width === 'content' ? { kind: 'hug' } : { kind: 'fixed', value: width.fixed },
            height: { kind: 'fill', weight: 1 } };
          const listOrigin = fieldOrigin(origin, model.list.var);
          const child = this.invoke(model, scope, wrap ? { value: item } : item, path, place,
            listOrigin === undefined ? undefined : { path: `${listOrigin}[${index}]`, wrapped: wrap }, undefined,
            { index, isFirst: index === 1, isLast: index + size - 1 === items.length, count: items.length, groupSize: size });
          return model.mergeBy ? { ...child, loopGroup: { index, size } } : child;
        });
        return { sourceType: 'loop', ...(model.mergeBy && { loopColumns: { count: items.length, gap: model.itemLayout.gap } }),
          model: { ...model, type: 'container', children: [],
          layout: { mode: 'stack', direction: 'row', gap: model.itemLayout.gap, justifyContent: 'start', alignItems: 'start' } }, children };
      }
      default: return { model };
    }
  }

  private invoke(call: LoopModel | CallModel, caller: Scope, data: unknown, path: ElementPath, place: Place,
    origin?: DataOrigin, appearance?: CallModel, loop?: Readonly<Record<LoopInfoKey, number | boolean>>): EvaluatedNode {
    const target = this.program.get(call.template)!;
    const requested: Record<string, unknown> = Object.create(null);
    const reportedStatically = new Set<string>();
    for (const parameter of target.template.parameters) {
      if (parameter.visibility !== 'public') continue;
      const argument = call.args[parameter.name];
      // 声明处已经报告的错误不重复；undefined 防止重复报告必填错误，但仍允许取缺省值。
      if (!argument || argumentProblem(argument, parameter.type, caller.table)) {
        requested[parameter.name] = undefined;
        reportedStatically.add(parameter.name);
      } else {
        requested[parameter.name] = 'value' in argument ? argument.value : 'var' in argument ? caller.value(argument.var) : loop?.[argument.loop];
      }
    }
    const parameters = resolveParameters(target.template, requested);
    this.problems.push(...parameters.problems.filter((problem) => {
      // 未填写和静态类型错误已在调用声明处报告。正常绑定运行时缺值仍报告参数错误。
      if (problem.location.kind !== 'parameter') return true;
      return !reportedStatically.has(problem.location.name);
    }).map((problem) => problem.location.kind === 'parameter'
      ? { ...problem, location: { ...problem.location, path: formatElementPath(path) } } : problem));
    const root = this.expand(new Scope(target.template, target.table, data, parameters.values), path, true, origin,
      [...parameters.problems.filter((problem) => problem.location.kind !== 'parameter' || !reportedStatically.has(problem.location.name)),
        ...[...reportedStatically].filter((name) => !parameters.values.has(name))
        .map((name) => severe(ProblemCodes.parameterMissing, { kind: 'parameter', name }, ''))]);
    if (!root) return { sourceType: 'call', model: { ...emptyContainer(call), path, place, visible: false } };
    const artboard = root.model as ArtboardModel;
    return { ...root, sourceType: 'call', calledTemplate: { name: target.template.name, sizeRange: artboard.sizeRange },
      model: { ...artboard, type: 'container', name: call.name, path, place, visible: true,
        opacity: appearance?.opacity ?? 1, rotation: appearance?.rotation ?? 0 } };
  }
}

const EMPTY_PLACE: Place = { horizontal: { edge: 'left', offset: 0 }, vertical: { edge: 'top', offset: 0 },
  row: 1, column: 1, rowSpan: 1, columnSpan: 1, margin: { top: 0, right: 0, bottom: 0, left: 0 } };

function emptyContainer(model: LoopModel | CallModel): ContainerModel {
  return { ...model, type: 'container', children: [], layout: { mode: 'free' }, clip: false,
    padding: { top: 0, right: 0, bottom: 0, left: 0 }, cornerRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 } };
}

function fragmentsOf(model: TextElementModel): EvaluatedFragment[] {
  return model.content.map((item) => ({
    // 求值读取已把插槽换成文字。
    text: item.kind === 'text' ? item.text : '',
    ...(item.kind === 'text' && item.placeholder && { placeholder: item.placeholder }),
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
  readonly affected = new Set<string>();

  constructor(private readonly scope: Scope, private readonly missing: MissingValues) {}

  placeholder(ref: string): string | undefined {
    const resolved = this.scope.table.typeOf(ref);
    return !('type' in resolved) || !displayKind(resolved.type) || this.missing.hasProblem(ref)
      ? `〔${this.missing.label(ref)}〕` : undefined;
  }

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

  text(ref: string): string {
    const value = this.typed(ref, 'text') ? this.scope.value(ref) : undefined;
    return typeof value === 'string' ? value : '';
  }

  image(ref: string, site: BindingSite): string | null {
    const value = this.typed(ref, 'image') ? this.scope.value(ref) : undefined;
    if (typeof value !== 'string') {
      if (this.missing.hasProblem(ref)) this.affected.add(formatElementPath(site.path));
      return null;
    }
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
  private typed(ref: string, kind: 'color' | 'number' | 'boolean' | 'image' | 'text'): boolean {
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
