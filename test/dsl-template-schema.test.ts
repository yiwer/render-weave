import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ProblemCodes, checkDslDocument, dslDocumentKind, openResourceRepository, publishStaticSchema, render,
  type DatasetDocument, type DslDocumentKind, type Problem, type StaticSchemaEntry, type Workspace,
} from '../src/index.js';
import { loadCorpus, loadSchemas, readSchema, type CorpusDocument } from './support/dsl-corpus.js';
import { repoRoot, resourcesDir } from './support/fixtures.js';

/**
 * DSL 1.0 一致性（M219）：模板、渲染请求与批次请求。规则同 dsl-schema.test.ts：
 * Schema 拒绝的引擎一定拒绝；引擎拒绝而 Schema 接受的，只能是 docs/dsl/ 中列明的语义检查。
 */

/** Schema 表达不了、只看一份文档就能判断的语义检查（docs/dsl/template.md 与 requests.md「Schema 之外的检查」）。 */
const SEMANTIC_CHECKS: readonly { readonly name: string; readonly matches: (p: Problem) => boolean }[] = [
  { name: '元素名称重复', matches: (p) => p.code === ProblemCodes.templateDuplicateElementName },
  { name: '网格行列越界', matches: (p) => p.code === ProblemCodes.templateInvalid && /网格只有 \d+ (行|列)/.test(p.message) },
  { name: '尺寸上下限颠倒', matches: (p) => p.code === ProblemCodes.templateInvalid && /(min\w+ 不能大于 max\w+|sizeRange)/.test(p.message) },
  { name: '循环切片起止颠倒', matches: (p) => p.code === ProblemCodes.templateInvalid && p.message.includes('slice.start 不能大于 slice.end') },
  { name: '参数约束或缺省值不合规', matches: (p) => p.code === ProblemCodes.templateInvalid && /(约束 \w+ 不能大于|不是合法的正则表达式|的缺省值)/.test(p.message) },
  { name: '展示格式不合法', matches: (p) => p.code === ProblemCodes.templateInvalid && /^(插槽 |splitPart 的 format：)/.test(p.message) },
  { name: '缩字下限低于画板的值', matches: (p) => p.code === ProblemCodes.templateInvalid && /minFontSize 不能低于(画板的 minFontSize| [\d.]+ mm（缺省值)/.test(p.message) },
  { name: '出图像素超限', matches: (p) => p.code === ProblemCodes.requestOutputTooLarge },
  { name: '渲染项标识重复', matches: (p) => p.code === ProblemCodes.requestInvalid && p.message.startsWith('渲染项标识重复') },
];

/**
 * 状态样式的覆盖值要与元素合并后才能检查（S5），Schema 只约束覆盖了哪些键。判断方法：去掉所有 states 后问题消失。
 */
function fromStateOverrides(document: unknown, source: string): boolean {
  const withoutStates = JSON.parse(JSON.stringify(document), (key, value) => (key === 'states' ? undefined : value));
  return checkDslDocument(withoutStates, source).problems.every((p) => p.level !== 'severe');
}

/** 引擎拒绝而 Schema 接受时，每个严重问题都必须属于列明的语义检查。 */
function onlySemantic(document: unknown, source: string, severe: readonly Problem[]): boolean {
  return severe.every((p) => SEMANTIC_CHECKS.some((check) => check.matches(p))) || fromStateOverrides(document, source);
}

let corpus: CorpusDocument[] = [];
let schemas: Record<DslDocumentKind, ValidateFunction>;

beforeAll(async () => {
  schemas = await loadSchemas();
  corpus = await loadCorpus();
});

const KINDS = ['template', 'renderRequest', 'batchRequest'] as const;

describe('语料与 Schema 一致', () => {
  it.each(KINDS)('仓库中的 %s：引擎接受的都通过 Schema，Schema 拒绝的引擎都拒绝', (kind) => {
    const documents = corpus.filter((c) => c.kind === kind);
    expect(documents.length).toBeGreaterThan(0);
    const disagreements: string[] = [];
    for (const { source, document } of documents) {
      const schemaOk = schemas[kind](document);
      const severe = checkDslDocument(document, source).problems.filter((p) => p.level === 'severe');
      if (severe.length === 0 && !schemaOk) disagreements.push(`${source}：引擎接受，Schema 拒绝 ${JSON.stringify(schemas[kind].errors?.slice(0, 3))}`);
      if (severe.length > 0 && schemaOk && !onlySemantic(document, source, severe)) disagreements.push(`${source}：Schema 接受，引擎因非语义问题拒绝 ${severe.map((p) => p.message).join('；')}`);
    }
    expect(disagreements).toEqual([]);
  });

  it('请求 Schema 内嵌的数据集文档结构与 dataset.schema.json 一致', async () => {
    const { $schema: _s, $id: _i, title: _t, description: _d, ...dataset } = await readSchema('dataset');
    for (const kind of ['renderRequest', 'batchRequest'] as const) {
      expect((await readSchema(kind)).$defs.datasetDocument).toEqual(dataset);
    }
  });
});

type Mutation = readonly [label: string, mutate: (doc: any) => boolean];
type ParentMode = 'free' | 'stack' | 'grid';

/** 深度优先找第一个满足条件的元素；同时给出它所在容器的布局。 */
function findElement(doc: any, match: (element: any, parentMode: ParentMode) => boolean): any {
  const visit = (container: any): any => {
    const mode: ParentMode = container?.layout?.mode ?? 'free';
    for (const element of Array.isArray(container?.children) ? container.children : []) {
      if (!element || typeof element !== 'object') continue;
      if (match(element, mode)) return element;
      const inner = visit(element);
      if (inner) return inner;
    }
    return undefined;
  };
  return visit(doc.artboard);
}

const on = (match: (element: any, parentMode: ParentMode) => boolean, mutate: (element: any) => unknown) => (doc: any) => {
  const element = findElement(doc, match);
  if (!element) return false;
  mutate(element);
  return true;
};
const ofType = (type: string, extra: (element: any) => boolean = () => true) => (element: any) => element.type === type && extra(element);
const isVertical = (element: any) => element.writingMode === 'vertical';
const isColumnLoop = (element: any) => element.itemLayout?.direction === 'column';
const onDeclaration = (key: 'parameters' | 'derived' | 'checks', match: (item: any) => boolean, mutate: (item: any) => unknown) => (doc: any) => {
  const item = Array.isArray(doc[key]) ? doc[key].find(match) : undefined;
  if (!item) return false;
  mutate(item);
  return true;
};
const firstCase = (element: any) => Object.values(element.states.cases)[0] as any;
const firstSlot = (element: any) => element.content.find((c: any) => c.slot !== undefined);

const TEMPLATE_MUTATIONS: readonly Mutation[] = [
  ['根上未知键', (d) => ((d.extra = 1), true)],
  ['dslVersion 不对', (d) => ((d.dslVersion = 'renderweave-template/2'), true)],
  ['name 为空', (d) => ((d.name = ''), true)],
  ['缺 base', (d) => (delete d.base, true)],
  ['base 上未知键', (d) => ((d.base.extra = 1), true)],
  ['base 版本为 0', (d) => ((d.base.version = 0), true)],
  ['缺 artboard', (d) => (delete d.artboard, true)],
  ['artboard 上未知键', (d) => ((d.artboard.extra = 1), true)],
  ['缺 sizeRange', (d) => (delete d.artboard.sizeRange, true)],
  ['sizeRange 上未知键', (d) => ((d.artboard.sizeRange.extra = 1), true)],
  ['范围上未知键', (d) => ((d.artboard.sizeRange.width.extra = 1), true)],
  ['范围下限为 0', (d) => ((d.artboard.sizeRange.width.min = 0), true)],
  ['size 不是 hug', (d) => ((d.artboard.size = 'fill'), true)],
  ['children 为 null', (d) => ((d.artboard.children = null), true)],
  ['布局模式未知', (d) => ((d.artboard.layout = { mode: 'flex' }), true)],
  ['parameters 不是列表', (d) => ((d.parameters = {}), true)],
  ['参数上未知键', onDeclaration('parameters', () => true, (p) => (p.extra = 1))],
  ['参数 visibility 未知', onDeclaration('parameters', () => true, (p) => (p.visibility = 'private'))],
  ['参数 type 未知', onDeclaration('parameters', () => true, (p) => (p.type = 'string'))],
  ['参数名称含点', onDeclaration('parameters', () => true, (p) => (p.name = 'a.b'))],
  ['内部参数缺缺省值', onDeclaration('parameters', (p) => p.visibility === 'internal', (p) => delete p.default)],
  ['数值参数缺省值为文本', onDeclaration('parameters', (p) => p.type === 'number', (p) => (p.default = 'x'))],
  ['数值参数写长度约束', onDeclaration('parameters', (p) => p.type === 'number', (p) => (p.constraints = { minLength: 1 }))],
  ['颜色参数缺省值不是颜色', onDeclaration('parameters', (p) => p.type === 'color', (p) => (p.default = 'red'))],
  ['派生变量 op 未知', onDeclaration('derived', () => true, (v) => (v.op = 'concat'))],
  ['派生变量 type 未知', onDeclaration('derived', () => true, (v) => (v.type = 'string'))],
  ['派生变量多出其他运算的键', onDeclaration('derived', (v) => v.op === 'branch', (v) => (v.of = { var: 'x' }))],
  ['分支缺 otherwise', onDeclaration('derived', (v) => v.op === 'branch', (v) => delete v.otherwise)],
  ['条件比较未知', onDeclaration('derived', (v) => v.op === 'branch' && v.branches[0].when.op !== undefined, (v) => (v.branches[0].when.op = 'like'))],
  ['一元比较带 right', onDeclaration('derived', (v) => v.op === 'branch' && v.branches[0].when.right !== undefined, (v) => (v.branches[0].when.op = 'empty'))],
  ['复合条件 all 为空列表', onDeclaration('derived', (v) => v.op === 'branch', (v) => (v.branches[0].when = { all: [] }))],
  ['复合条件 any 为空列表', onDeclaration('derived', (v) => v.op === 'branch', (v) => (v.branches[0].when = { any: [] }))],
  ['复合条件同时写 all 与 any', onDeclaration('derived', (v) => v.op === 'branch' && v.branches[0].when.all !== undefined, (v) => (v.branches[0].when.any = v.branches[0].when.all))],
  ['复合条件嵌套复合条件', onDeclaration('derived', (v) => v.op === 'branch' && v.branches[0].when.all !== undefined, (v) => (v.branches[0].when.all[0] = { any: v.branches[0].when.all }))],
  ['splitPart 缺 delimiter', onDeclaration('derived', (v) => v.op === 'splitPart', (v) => delete v.delimiter)],
  ['splitPart 的 delimiter 为空文本', onDeclaration('derived', (v) => v.op === 'splitPart', (v) => (v.delimiter = ''))],
  ['splitPart 混写其他运算的键', onDeclaration('derived', (v) => v.op === 'splitPart', (v) => (v.list = { var: 'x' }))],
  ['乘除取模混写其他运算的键', onDeclaration('derived', (v) => v.op === 'mod' || v.op === 'multiply' || v.op === 'divide', (v) => (v.of = { var: 'x' }))],
  ['运算数写成裸值', onDeclaration('derived', (v) => v.op === 'add' || v.op === 'subtract', (v) => (v.left = 5))],
  ['结果为 ref 却缺 ref', onDeclaration('derived', (v) => v.type === 'ref', (v) => delete v.ref)],
  ['派生 ref 上未知键', onDeclaration('derived', (v) => v.type === 'ref', (v) => (v.ref.extra = 1))],
  ['取项 position 未知', onDeclaration('derived', (v) => v.op === 'pickItem', (v) => (v.position = 'middle'))],
  ['检查项等级未知', onDeclaration('checks', () => true, (c) => (c.level = 'warn'))],
  ['检查项缺 message', onDeclaration('checks', () => true, (c) => delete c.message)],
  ['检查项 displayName 为空', onDeclaration('checks', () => true, (c) => (c.displayName = ''))],
  ['元素上未知键', on(() => true, (e) => (e.extra = 1))],
  ['元素类型未知', on(() => true, (e) => (e.type = 'circle'))],
  ['元素名称含斜杠', on(() => true, (e) => (e.name = 'a/b'))],
  ['元素名称为空', on(() => true, (e) => (e.name = ''))],
  ['visible 不是布尔', on(() => true, (e) => (e.visible = 'yes'))],
  ['opacity 超出 1', on(() => true, (e) => (e.opacity = 2))],
  ['rotation 不是数', on(() => true, (e) => (e.rotation = 'a'))],
  ['place 为 null', on(() => true, (e) => (e.place = null))],
  ['自由布局中写网格位置', on((_e, mode) => mode === 'free', (e) => (e.place = { ...e.place, row: 1 }))],
  ['自由布局同时写 left 与 right', on((_e, mode) => mode === 'free', (e) => (e.place = { ...e.place, left: 1, right: 1 }))],
  ['堆叠布局中写 left', on((_e, mode) => mode === 'stack', (e) => (e.place = { ...e.place, left: 1 }))],
  ['网格中缺 row', on((_e, mode) => mode === 'grid', (e) => delete e.place.row)],
  ['宽度写法未知', on((_e, mode) => mode !== 'grid', (e) => (e.place = { ...e.place, width: 'auto' }))],
  ['状态样式缺 by', on((e) => e.states, (e) => delete e.states.by)],
  ['状态样式覆盖 type', on((e) => e.states, (e) => (firstCase(e).type = 'rect'))],
  ['状态样式覆盖未知键', on((e) => e.states, (e) => (firstCase(e).colr = '#000000'))],
  ['填充颜色写法不对', on((e) => e.fill !== undefined, (e) => (e.fill = '#12'))],
  ['描边缺宽度', on((e) => e.stroke !== undefined && e.type !== 'text', (e) => delete e.stroke.width)],
  ['描边虚线为空', on((e) => e.stroke !== undefined && e.type !== 'text', (e) => (e.stroke.dash = []))],
  ['圆角为负', on((e) => e.type === 'rect' || e.type === 'container', (e) => (e.cornerRadius = -1))],
  ['内边距键未知', on((e) => e.type === 'container' || e.type === 'text', (e) => (e.padding = { foo: 1 }))],
  ['clip 不是布尔', on(ofType('container'), (e) => (e.clip = 'yes'))],
  ['堆叠布局缺 direction', on((e) => e.layout?.mode === 'stack', (e) => delete e.layout.direction)],
  ['堆叠布局 wrap 不是布尔', on((e) => e.layout?.mode === 'stack', (e) => (e.layout.wrap = 'yes'))],
  ['堆叠布局 wrap 绑定变量', on((e) => e.layout?.mode === 'stack', (e) => (e.layout.wrap = { var: 'x' }))],
  ['堆叠布局 crossGap 为负', on((e) => e.layout?.mode === 'stack', (e) => (e.layout.crossGap = -1))],
  ['网格行为空', on((e) => e.layout?.mode === 'grid', (e) => (e.layout.rows = []))],
  ['网格轨道写法未知', on((e) => e.layout?.mode === 'grid', (e) => (e.layout.rows[0] = { fixed: -1 }))],
  ['文字缺字体', on(ofType('text'), (e) => delete e.font)],
  ['文字字体绑定变量', on(ofType('text'), (e) => (e.font = { var: 'x' }))],
  ['字号为 0', on(ofType('text'), (e) => (e.fontSize = 0))],
  ['写了 fontWeight', on(ofType('text'), (e) => (e.fontWeight = 700))],
  ['content 不是列表', on(ofType('text'), (e) => (e.content = 'abc'))],
  ['片段同时写 text 与 slot', on(ofType('text'), (e) => (e.content[0] = { text: 'a', slot: 'b' }))],
  ['片段上未知键', on(ofType('text'), (e) => (e.content[0] = { ...e.content[0], weight: 1 }))],
  ['插槽路径含空段', on(ofType('text', (e) => firstSlot(e) !== undefined), (e) => (firstSlot(e).slot = 'a..b'))],
  ['书写方向未知', on(ofType('text'), (e) => (e.writingMode = 'diagonal'))],
  ['横排用 verticalAlign 两端分布', on(ofType('text', (e) => !isVertical(e)), (e) => (e.verticalAlign = 'distribute'))],
  ['竖排用 spaceEvenly', on(ofType('text', isVertical), (e) => (e.horizontalAlign = 'spaceEvenly'))],
  ['竖排片段写倾斜', on(ofType('text', isVertical), (e) => (e.content[0] = { ...e.content[0], slant: 10 }))],
  ['竖排倾斜', on(ofType('text', isVertical), (e) => (e.slant = 10))],
  ['fit 上未知键', on(ofType('text'), (e) => (e.fit = { ...e.fit, extra: 1 }))],
  ['fit 步骤未知', on(ofType('text'), (e) => (e.fit = { ...e.fit, steps: ['squeeze'] }))],
  ['文字 letterSpacing 不是数', on(ofType('text'), (e) => (e.letterSpacing = '1'))],
  ['横排先缩字后压缩', on(ofType('text', (e) => !isVertical(e)), (e) => (e.fit = { steps: ['shrink', 'compressGlyphs'] }))],
  ['横排先压缩后收紧字距', on(ofType('text', (e) => !isVertical(e)), (e) => (e.fit = { steps: ['compressGlyphs', 'tightenSpacing'] }))],
  ['横排收紧字距后跳过压缩直接缩字', on(ofType('text', (e) => !isVertical(e)), (e) => (e.fit = { steps: ['tightenSpacing', 'shrink'] }))],
  ['竖排只压缩字形', on(ofType('text', isVertical), (e) => (e.fit = { steps: ['compressGlyphs'] }))],
  ['压缩下限低于 0.6', on(ofType('text'), (e) => (e.fit = { ...e.fit, compressMin: 0.5 }))],
  ['最小字号低于 1.5', on(ofType('text', (e) => !isVertical(e)), (e) => (e.fit = { steps: ['compressGlyphs', 'shrink'], minFontSize: 1 }))],
  ['画板最小字号低于 1.5', (d) => ((d.artboard.minFontSize = 1), true)],
  ['画板最小字号不是数', (d) => ((d.artboard.minFontSize = '3'), true)],
  ['没有 shrink 却写最小字号', on(ofType('text', (e) => !isVertical(e)), (e) => (e.fit = { steps: ['compressGlyphs'], minFontSize: 6 }))],
  ['收紧字距与压缩但没有 shrink 却写最小字号', on(ofType('text', (e) => !isVertical(e)), (e) => (e.fit = { steps: ['tightenSpacing', 'compressGlyphs'], minFontSize: 6 }))],
  ['缩字组用于横排', on(ofType('text', (e) => !isVertical(e)), (e) => (e.fit = { widthOverflow: { shrinkGroup: 'g' } }))],
  ['缩字组名首尾有空白', on(ofType('text', isVertical), (e) => (e.fit = { ...e.fit, widthOverflow: { shrinkGroup: ' g' } }))],
  ['倾斜超过 45 度', on(ofType('text', (e) => !isVertical(e)), (e) => (e.slant = 60))],
  ['文字描边写虚线', on(ofType('text'), (e) => (e.stroke = { color: '#000000', width: 0.2, dash: [1] }))],
  ['图片来源不是资源引用', on(ofType('image'), (e) => (e.source = 'logo.png'))],
  ['图片适配未知', on(ofType('image'), (e) => (e.fit = 'stretch'))],
  ['循环缺 list', on(ofType('loop'), (e) => delete e.list)],
  ['循环 list 不是变量', on(ofType('loop'), (e) => (e.list = 'stops'))],
  ['循环缺 itemLayout', on(ofType('loop'), (e) => delete e.itemLayout)],
  ['循环 widths 写法未知', on(ofType('loop'), (e) => (e.itemLayout.widths = 'auto'))],
  ['循环方向未知', on(ofType('loop'), (e) => (e.itemLayout.direction = 'diagonal'))],
  ['横向循环改为纵向仍写 widths', on(ofType('loop', (e) => e.itemLayout.widths !== undefined), (e) => (e.itemLayout.direction = 'column'))],
  ['横向循环写 heights', on(ofType('loop', (e) => e.itemLayout.widths !== undefined), (e) => (e.itemLayout.heights = 'equal'))],
  ['纵向循环写 widths', on(ofType('loop', isColumnLoop), (e) => (e.itemLayout.widths = 'equal'))],
  ['纵向循环缺 heights', on(ofType('loop', isColumnLoop), (e) => delete e.itemLayout.heights)],
  ['纵向循环 heights 写法未知', on(ofType('loop', isColumnLoop), (e) => (e.itemLayout.heights = 'auto'))],
  ['纵向合并循环 heights 不是 equal', on(ofType('loop', isColumnLoop), (e) => ((e.mergeBy = 'title'), (e.itemLayout.heights = 'content'), (e.itemLayout.spanBy = 'groupSize')))],
  ['纵向循环只写 spanBy', on(ofType('loop', isColumnLoop), (e) => (e.itemLayout.spanBy = 'groupSize'))],
  ['只写 spanBy 不写 mergeBy', on(ofType('loop', (e) => !e.mergeBy), (e) => (e.itemLayout.spanBy = 'groupSize'))],
  ['合并循环 widths 不是 equal', on(ofType('loop', (e) => e.mergeBy), (e) => (e.itemLayout.widths = 'content'))],
  ['循环 itemLayout.wrap 不是布尔', on(ofType('loop'), (e) => (e.itemLayout.wrap = 'yes'))],
  ['循环 itemLayout.wrap 绑定变量', on(ofType('loop'), (e) => (e.itemLayout.wrap = { var: 'x' }))],
  ['循环 itemLayout.crossGap 为负', on(ofType('loop'), (e) => (e.itemLayout.crossGap = -1))],
  ['循环开启 wrap 时 widths 取 equal', on(ofType('loop', (e) => e.itemLayout.widths !== undefined), (e) => ((e.itemLayout.widths = 'equal'), (e.itemLayout.wrap = true)))],
  ['纵向循环开启 wrap 时 heights 取 equal', on(ofType('loop', isColumnLoop), (e) => ((e.itemLayout.heights = 'equal'), (e.itemLayout.wrap = true)))],
  ['循环开启 wrap 时同时写 mergeBy', on(ofType('loop', (e) => e.itemLayout.widths === 'content'), (e) => ((e.mergeBy = 'value'), (e.itemLayout.wrap = true)))],
  ['循环 reverse 不是布尔', on(ofType('loop'), (e) => (e.reverse = 'yes'))],
  ['循环 slice 为空对象', on(ofType('loop'), (e) => (e.slice = {}))],
  ['循环 slice 上未知键', on(ofType('loop'), (e) => (e.slice = { start: 1, extra: 2 }))],
  ['循环 slice.start 为 0', on(ofType('loop'), (e) => (e.slice = { start: 0 }))],
  ['循环 slice.end 不是整数', on(ofType('loop'), (e) => (e.slice = { end: 1.5 }))],
  ['循环参数写成裸值', on(ofType('loop'), (e) => (e.args = { ...e.args, foo: 1 }))],
  ['调用 data 写法未知', on(ofType('call'), (e) => (e.data = 'all'))],
  ['调用参数用循环信息', on(ofType('call'), (e) => (e.args = { ...e.args, x: { loop: 'index' } }))],
  ['条形码格式未知', on(ofType('barcode'), (e) => (e.format = 'QR'))],
  ['条形码显示文字却没字体', on(ofType('barcode'), (e) => ((e.showText = true), delete e.font))],
  ['二维码纠错等级未知', on(ofType('qrcode'), (e) => (e.errorCorrectionLevel = 'X'))],
  ['二维码内容不是文本', on(ofType('qrcode'), (e) => (e.content = 5))],
  ['线条缺描边', on(ofType('line'), (e) => delete e.stroke)],
  ['线条端点不是点', on(ofType('line'), (e) => (e.from = [1]))],
  ['线条未写 viewBox 却写 fit', on(ofType('line', (e) => e.viewBox === undefined), (e) => (e.fit = 'fill'))],
  ['多边形少于 3 点', on(ofType('polygon'), (e) => (e.points = e.points.slice(0, 2)))],
  ['多边形未写 viewBox 却写 fit', on(ofType('polygon', (e) => e.viewBox === undefined), (e) => (e.fit = 'contain'))],
  ['路径 d 为空白', on(ofType('path'), (e) => (e.d = '  '))],
  ['路径填充规则未知', on(ofType('path'), (e) => (e.fillRule = 'winding'))],
  ['路径未写 viewBox 却写 fit', on(ofType('path', (e) => e.viewBox === undefined), (e) => (e.fit = 'cover'))],
  ['图形 viewBox 少于 4 项', on(ofType('path', (e) => e.viewBox !== undefined), (e) => (e.viewBox = [0, 0, 10]))],
  ['图形 viewBox 宽度为 0', on(ofType('path', (e) => e.viewBox !== undefined), (e) => (e.viewBox = [0, 0, 0, 10]))],
  ['图形 viewBox 高度为负', on(ofType('path', (e) => e.viewBox !== undefined), (e) => (e.viewBox = [0, 0, 10, -1]))],
  ['图形 viewBox 项不是数', on(ofType('path', (e) => e.viewBox !== undefined), (e) => (e.viewBox = [0, 0, '10', 10]))],
  ['图形 fit 未知', on(ofType('path', (e) => e.viewBox !== undefined), (e) => (e.fit = 'stretch'))],
  ['椭圆写圆角', on(ofType('ellipse'), (e) => (e.cornerRadius = 1))],
  ['矩形写 viewBox', on(ofType('rect'), (e) => (e.viewBox = [0, 0, 10, 10]))],
];

const REQUEST_MUTATIONS: readonly Mutation[] = [
  ['根上未知键', (d) => ((d.extra = 1), true)],
  ['template 为空', (d) => ((d.template = ''), true)],
  ['缺 mode', (d) => (delete d.mode, true)],
  ['mode 未知', (d) => ((d.mode = 'preview'), true)],
  ['缺 output', (d) => (delete d.output, true)],
  ['output 上未知键', (d) => ((d.output.extra = 1), true)],
  ['宽度为 0', (d) => ((d.output.width = 0), true)],
  ['图片格式未知', (d) => ((d.output.format = 'gif'), true)],
  ['数据集同时写 id 与 inline', (d) => ((d.dataset = { id: 'x', inline: {} }), true)],
  ['数据集选择上未知键', (d) => ((d.dataset = { ...d.dataset, extra: 1 }), true)],
  ['数据集 id 为空', (d) => ((d.dataset = { id: '' }), true)],
  ['内联数据集根上未知键', (d) => (d.dataset.inline ? ((d.dataset.inline.extra = 1), true) : false)],
  ['parameters 为 null', (d) => ((d.parameters = null), true)],
];

const BATCH_MUTATIONS: readonly Mutation[] = [
  ['根上未知键', (d) => ((d.extra = 1), true)],
  ['mode 未知', (d) => ((d.mode = 'preview'), true)],
  ['缺 items', (d) => (delete d.items, true)],
  ['items 为空', (d) => ((d.items = []), true)],
  ['渲染项缺 id', (d) => (delete d.items[0].id, true)],
  ['渲染项上未知键', (d) => ((d.items[0].extra = 1), true)],
  ['渲染项各自写 mode', (d) => ((d.items[0].mode = 'final'), true)],
  ['渲染项缺 output', (d) => (delete d.items[0].output, true)],
  ['渲染项数据集写法未知', (d) => ((d.items[0].dataset = 'ds'), true)],
];

describe('结构错误被 Schema 与引擎同时拒绝', () => {
  const cases = [
    ['template', TEMPLATE_MUTATIONS],
    ['renderRequest', REQUEST_MUTATIONS],
    ['batchRequest', BATCH_MUTATIONS],
  ] as const;

  it.each(cases)('%s 的变异样本', (kind, mutations) => {
    const valid = corpus.filter((c) => c.kind === kind && checkDslDocument(c.document).problems.every((p) => p.level !== 'severe'));
    expect(valid.length).toBeGreaterThan(0);
    const applied = new Set<string>();
    const escapes: string[] = [];
    for (const { source, document } of valid) {
      for (const [label, mutate] of mutations) {
        const mutant = structuredClone(document);
        if (!mutate(mutant)) continue;
        applied.add(label);
        const schemaRejects = !schemas[kind](mutant);
        const engineRejects = checkDslDocument(mutant, source).problems.some((p) => p.level === 'severe');
        if (!schemaRejects || !engineRejects) escapes.push(`${source}「${label}」：Schema ${schemaRejects ? '拒绝' : '接受'}，引擎${engineRejects ? '拒绝' : '接受'}`);
      }
    }
    expect([...new Set(escapes.map((e) => e.replace(/^[^「]*/, '')))]).toEqual([]);
    // 每种变异至少在一份语料上用到，否则说明语料（含参考文档的示例）缺少对应写法。
    expect(mutations.map(([label]) => label).filter((label) => !applied.has(label))).toEqual([]);
  });
});

describe('Schema 之外的语义检查（只看一份文档）', () => {
  const template = (artboard: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    dslVersion: 'renderweave-template/1', name: '样例', base: { name: '空数据定义', version: 1 },
    artboard: { sizeRange: { width: { min: 10, max: 100 }, height: { min: 10, max: 100 } }, ...artboard }, ...extra,
  });
  const text = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'text', name, content: [{ text: '字' }], font: 'res:font-hei-regular', fontSize: 5, ...extra });
  const output = { width: 10, height: 10, dpi: 120, format: 'png' };
  const cases: readonly [string, Record<string, unknown>][] = [
    ['元素名称重复', template({ children: [text('甲'), text('甲', { place: { top: 6 } })] })],
    ['网格行列越界', template({ layout: { mode: 'grid', rows: [{ fixed: 5 }], columns: [{ fixed: 5 }] }, children: [text('甲', { place: { row: 2, column: 1 } })] })],
    ['尺寸上下限颠倒', template({ children: [text('甲', { place: { minWidth: 5, maxWidth: 2 } })] })],
    ['尺寸上下限颠倒', template({ sizeRange: { width: { min: 50, max: 10 }, height: { min: 10, max: 100 } } })],
    ['循环切片起止颠倒', template({ children: [{ type: 'loop', name: '列', list: { var: 'items' }, template: '子', slice: { start: 5, end: 3 }, itemLayout: { widths: 'equal' } }] })],
    ['参数约束或缺省值不合规', template({}, { parameters: [{ name: 'n', displayName: '数', visibility: 'internal', type: 'number', constraints: { min: 5, max: 1 }, default: 3 }] })],
    ['参数约束或缺省值不合规', template({}, { parameters: [{ name: 'n', displayName: '数', visibility: 'internal', type: 'number', constraints: { max: 1 }, default: 3 }] })],
    ['参数约束或缺省值不合规', template({}, { parameters: [{ name: 'd', displayName: '日', visibility: 'internal', type: 'date', default: '2026-02-30' }] })],
    ['展示格式不合法', template({ children: [text('甲', { content: [{ slot: 'value', format: '0.#0' }] })] }, { base: { name: '单值·数值', version: 1 } })],
    ['展示格式不合法', template({}, { derived: [{ name: 'part', displayName: '段', type: 'text', op: 'splitPart', of: { var: 'value' }, format: '0.#0', delimiter: '.', position: 'first' }] })],
    ['缩字下限低于画板的值', template({ minFontSize: 3, children: [text('甲', { fit: { steps: ['compressGlyphs', 'shrink'], minFontSize: 2.5 } })] })],
    ['缩字下限低于画板的值', template({ children: [text('甲', { fit: { steps: ['compressGlyphs', 'shrink'], minFontSize: 4 } })] })],
    ['出图像素超限', { template: '样例', dataset: { id: 'x' }, output: { width: 1500, height: 165, dpi: 400, format: 'png' }, mode: 'final' }],
    ['渲染项标识重复', { template: '样例', mode: 'final', items: [{ id: 'a', dataset: { id: 'x' }, output }, { id: 'a', dataset: { id: 'x' }, output }] }],
  ];

  it.each(cases)('%s：Schema 接受，引擎拒绝并归入该类', (category, document) => {
    const kind = dslDocumentKind(document)!;
    expect(schemas[kind](document), JSON.stringify(schemas[kind].errors)).toBe(true);
    const severe = checkDslDocument(document).problems.filter((p) => p.level === 'severe');
    expect(severe.length).toBeGreaterThan(0);
    const check = SEMANTIC_CHECKS.find((c) => c.name === category)!;
    expect(severe.every(check.matches), JSON.stringify(severe)).toBe(true);
  });

  it('状态样式覆盖后不合规：Schema 接受，去掉 states 后引擎接受', () => {
    const document = template({ children: [text('甲', { slant: 8, states: { by: { var: 'flag' }, cases: { true: { writingMode: 'vertical' } } } })] },
      { parameters: [{ name: 'flag', displayName: '开关', visibility: 'public', type: 'boolean' }] });
    expect(schemas.template(document)).toBe(true);
    expect(checkDslDocument(document).problems.some((p) => p.level === 'severe')).toBe(true);
    expect(fromStateOverrides(document, '样例')).toBe(true);
  });

  it('清单中的每一类都有用例', () => {
    expect(new Set(cases.map(([category]) => category))).toEqual(new Set(SEMANTIC_CHECKS.map((c) => c.name)));
  });

  it('letterSpacing（字面值与变量绑定）及横排 tightenSpacing 各步骤组合通过 Schema 与引擎检查', () => {
    const doc = template(
      {
        children: [
          text('正字距与仅收紧', { letterSpacing: 1.5, fit: { steps: ['tightenSpacing'] } }),
          text('负字距与收紧加压缩', {
            place: { top: 6 },
            letterSpacing: -0.5,
            fit: { steps: ['tightenSpacing', 'compressGlyphs'] },
          }),
          text('绑定字距与三步适配', {
            place: { top: 12 },
            letterSpacing: { var: 'tracking' },
            fit: { steps: ['tightenSpacing', 'compressGlyphs', 'shrink'], minFontSize: 5 },
            states: { by: { var: 'flag' }, cases: { true: { letterSpacing: 0.8 } } },
          }),
        ],
      },
      {
        parameters: [
          { name: 'tracking', displayName: '字距', visibility: 'public', type: 'number', default: 1 },
          { name: 'flag', displayName: '开关', visibility: 'public', type: 'boolean', default: false },
        ],
      },
    );
    expect(schemas.template(doc), JSON.stringify(schemas.template.errors)).toBe(true);
    expect(checkDslDocument(doc).problems).toEqual([]);
  });

  it('竖排文本的文字片段与变量插槽单独设 font、fontSize 与 color 通过 Schema 与引擎检查', () => {
    const doc = template(
      {
        children: [
          text('竖排混排', {
            writingMode: 'vertical',
            verticalAlign: 'distribute',
            content: [
              { slot: 'mainName', font: 'res:font-hei-bold', fontSize: 10, color: '#1F2328' },
              { text: '（北门）', font: 'res:font-hei-regular', fontSize: { var: 'subSize' }, color: '#57606A' },
            ],
          }),
        ],
      },
      {
        parameters: [
          { name: 'mainName', displayName: '主站名', visibility: 'public', type: 'text', default: '田贝' },
          { name: 'subSize', displayName: '副名号', visibility: 'public', type: 'number', default: 7 },
        ],
      },
    );
    expect(schemas.template(doc), JSON.stringify(schemas.template.errors)).toBe(true);
    expect(checkDslDocument(doc).problems).toEqual([]);
  });
});

describe('参考文档', () => {
  async function jsonBlocks(file: string): Promise<Record<string, unknown>[]> {
    const text = await readFile(join(repoRoot, file), 'utf8');
    return [...text.matchAll(/```json\n([\s\S]*?)```/g)].flatMap((m) => {
      try {
        return [JSON.parse(m[1]!) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  }

  /** 按参考中的数据定义、模板与数据集组成工作区。 */
  async function referenceWorkspace(definitionDoc: string, templateDoc: string): Promise<{ workspace: Workspace; dataset: DatasetDocument }> {
    const definitionBlocks = await jsonBlocks(definitionDoc);
    const entries: StaticSchemaEntry[] = [];
    for (const document of definitionBlocks.filter((d) => dslDocumentKind(d) === 'definition')) {
      const { published, problems } = publishStaticSchema(document, entries);
      expect(problems).toEqual([]);
      entries.push(published!);
    }
    const dataset = definitionBlocks.find((d) => dslDocumentKind(d) === 'dataset') as unknown as DatasetDocument;
    const templates = (await jsonBlocks(templateDoc)).filter((d) => dslDocumentKind(d) === 'template').map((document) => ({ name: document['name'] as string, document }));
    expect(templates.length).toBeGreaterThan(1);
    const { repository } = await openResourceRepository(resourcesDir);
    return {
      workspace: { staticSchemas: entries, templates, datasets: [{ id: dataset.dataset.id!, document: dataset }], resources: repository, problems: [] },
      dataset,
    };
  }

  const badgeOutput = { width: 90, height: 130, dpi: 120, format: 'png' };

  it('人读参考的会议胸牌示例出图 0 问题，requests.md 的渲染请求示例照样出图', async () => {
    const { workspace, dataset } = await referenceWorkspace('docs/dsl/data-definition.md', 'docs/dsl/template.md');
    expect(workspace.templates.map((t) => t.name).sort()).toEqual(['会场格', '场次行', '标准胸牌', '标签格']);
    const inline = await render(workspace, { template: '标准胸牌', dataset: { inline: dataset }, output: badgeOutput, mode: 'final' });
    expect(inline.problems).toEqual([]);
    expect(inline.image).toBeDefined();
    const request = (await jsonBlocks('docs/dsl/requests.md')).find((d) => dslDocumentKind(d) === 'renderRequest')!;
    expect((await render(workspace, request)).problems).toEqual([]);
  });

  it('Agent 参考的简易胸牌示例出图 0 问题', async () => {
    const { workspace, dataset } = await referenceWorkspace('agent/reference/data-definition.md', 'agent/reference/template.md');
    const result = await render(workspace, { template: '简易胸牌', dataset: { inline: dataset }, output: badgeOutput, mode: 'final' });
    expect(result.problems).toEqual([]);
  });

  it('两份模板参考覆盖 Schema 中的全部元素类型与属性', async () => {
    const schema = await readSchema('template');
    const defs = schema.$defs;
    const types: string[] = defs.element.properties.type.enum;
    const keywords = new Set<string>([
      ...Object.keys(schema.properties),
      ...types,
      ...types.flatMap((type) => Object.keys(defs[`${type}Element`].properties)),
      ...Object.keys(defs.artboard.properties),
      ...Object.keys(defs.fit.properties),
      ...Object.keys(defs.placeInGrid.properties),
      ...Object.keys(defs.placeInFree.properties),
      ...Object.keys(defs.derived.properties),
      ...defs.derived.properties.op.enum,
      ...defs.condition.properties.op.enum,
      'all',
      'any',
      ...defs.loopOperand.properties.loop.enum,
      ...Object.keys(defs.loopSlice.properties),
      ...Object.keys(defs.loopElement.properties.itemLayout.properties),
      ...defs.parameter.properties.type.enum,
    ]);
    for (const file of ['docs/dsl/template.md', 'agent/reference/template.md']) {
      const text = await readFile(join(repoRoot, file), 'utf8');
      expect([...keywords].filter((keyword) => !text.includes(keyword)), file).toEqual([]);
    }
  });
});
