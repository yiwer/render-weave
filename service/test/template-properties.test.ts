/**
 * 属性面板的生成规则（P1 票据 08）：只经"给文档与元素路径、得到可编辑项与写回结果"这一入口，写回的结果由引擎的 checkDslDocument 判断。
 * 文档是全元素牌（十二种元素），与模板设计页的浏览器用例共用。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { listItemPanel, propertyPanel, writeListItem, writeProperty, type Editor, type PropertyField, type PropertyPanel } from '../console/src/template/properties.js';
import type { JsonObject } from '../console/src/template/document.js';
import templateSchema from '../../schemas/template.schema.json' with { type: 'json' };
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE } from './seed.js';

const NAME = '全元素牌';
const defs = (templateSchema as unknown as { $defs: Record<string, { properties: Record<string, unknown> }> }).$defs;
let original: JsonObject;

const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
/** 深拷贝：断言"原文档没有被改"，也让每条用例从同一份内容开始。 */
const fresh = (): JsonObject => JSON.parse(JSON.stringify(original)) as JsonObject;
const panelOf = (document: JsonObject, path: string): PropertyPanel => {
  const panel = propertyPanel(document, path);
  if (!panel) throw new Error(`没有元素 ${path}`);
  return panel;
};

/** 面板里全部字段，嵌套的（分组、当前变体、列表项）也摊开。 */
function allFields(panel: PropertyPanel): PropertyField[] {
  const inner = (editor: Editor | undefined): PropertyField[] => {
    switch (editor?.kind) {
      case 'group': return editor.fields.flatMap(walk);
      case 'variants': return inner(editor.editor);
      case 'list': return editor.items.flatMap(walk);
      case 'map': return editor.entries.flatMap(walk);
      default: return [];
    }
  };
  const walk = (field: PropertyField): PropertyField[] => [field, ...inner(field.editor)];
  return panel.groups.flatMap((group) => group.fields.flatMap(walk));
}
const fieldOf = (document: JsonObject, path: string, key: string): PropertyField => {
  const found = allFields(panelOf(document, path)).find((field) => field.key === key);
  if (!found) throw new Error(`${path} 没有可编辑项 ${key}：${allFields(panelOf(document, path)).map((field) => field.key).join('、')}`);
  return found;
};
const elementOf = (document: JsonObject, path: string): JsonObject => {
  let node = document['artboard'] as JsonObject;
  for (const name of path.split('/').slice(1)) node = (node['children'] as JsonObject[]).find((child) => child['name'] === name)!;
  return node;
};
const at = (name: string) => `${NAME}/${name}`;

beforeAll(async () => {
  original = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  expect(severe(original)).toEqual([]);
});

describe('每种元素：按 Schema 生成可编辑项，写回后仍是合法的模板', () => {
  // 元素路径、Schema 里的类型定义、改哪个属性、改成什么、写回后在元素里怎么读。
  const cases: readonly (readonly [string, string, string, readonly (string | number)[], unknown])[] = [
    [NAME, 'artboard', 'artboard', ['fill'], '#FFF8EE'],
    [at('容器'), 'container', 'containerElement', ['padding'], 3],
    [at('容器/容器内文字'), 'text', 'textElement', ['fontSize'], 5.5],
    [at('循环'), 'loop', 'loopElement', ['itemLayout', 'gap'], 1],
    [at('调用'), 'call', 'callElement', ['opacity'], 0.5],
    [at('文字'), 'text', 'textElement', ['letterSpacing'], 0.2],
    [at('图片'), 'image', 'imageElement', ['fit'], 'cover'],
    [at('二维码'), 'qrcode', 'qrcodeElement', ['errorCorrectionLevel'], 'H'],
    [at('条码'), 'barcode', 'barcodeElement', ['foreground'], '#0B4EA2'],
    [at('矩形'), 'rect', 'rectElement', ['cornerRadius'], 3],
    [at('椭圆'), 'ellipse', 'ellipseElement', ['fill'], '#123456'],
    [at('线条'), 'line', 'lineElement', ['to', 1], 3],
    [at('多边形'), 'polygon', 'polygonElement', ['points', 1, 0], 15],
    [at('路径'), 'path', 'pathElement', ['fillRule'], 'evenodd'],
  ];

  it.each(cases)('%s（%s）', (path, type, definition, fieldPath, value) => {
    const document = fresh(), panel = panelOf(document, path);
    expect(panel.type).toBe(type);

    // 面板列出 Schema 里这个类型的全部属性（类型与子元素除外，位置尺寸摊开放）。
    const listed = new Set(panel.groups.flatMap((group) => group.fields.map((field) => String(field.path[0]))));
    for (const key of Object.keys(defs[definition]!.properties)) {
      if (key === 'type' || key === 'children') continue;
      expect([...listed], `${path} 的属性 ${key}`).toContain(key);
    }

    const written = writeProperty(document, path, fieldPath, value);
    expect(severe(written)).toEqual([]);
    let read: unknown = elementOf(written, path);
    for (const part of fieldPath) read = (read as Record<string | number, unknown>)[part];
    expect(read).toEqual(value);
    expect(document, '原文档不变').toEqual(original);
    // 别的元素一个字节也不动。
    const others = (doc: JsonObject) => JSON.stringify(doc, (key, item: unknown) => (item === elementOf(doc, path) ? null : key === 'artboard' && path === NAME ? null : item));
    expect(others(written)).toBe(others(document));
  });
});

describe('生成规则', () => {
  it('任何"或变量"的属性都能绑定变量：是一个变体，写回 { var }', () => {
    const document = fresh(), field = fieldOf(document, at('椭圆'), 'opacity');
    expect(field.editor.kind).toBe('variants');
    const variants = field.editor.kind === 'variants' ? field.editor.variants : [];
    const binding = variants.find((variant) => variant.label === '绑定变量');
    expect(binding, '有绑定变量这一项').toBeDefined();
    const bound = writeProperty(document, at('椭圆'), ['opacity'], { var: 'someOpacity' });
    expect(elementOf(bound, at('椭圆'))['opacity']).toEqual({ var: 'someOpacity' });
    expect(fieldOf(bound, at('椭圆'), 'opacity.var')).toMatchObject({ value: 'someOpacity' });
    expect(severe(bound)).toEqual([]);
  });

  it('条件显示：是、否与绑定变量，去掉就回到缺省', () => {
    const document = fresh(), path = at('矩形');
    const hidden = writeProperty(document, path, ['visible'], false);
    expect(severe(hidden)).toEqual([]);
    expect(elementOf(hidden, path)['visible']).toBe(false);
    const field = fieldOf(hidden, path, 'visible');
    expect(field.editor.kind === 'variants' && field.editor.variants.map((variant) => variant.label)).toEqual(['是', '否', '绑定变量']);
    const cleared = writeProperty(hidden, path, ['visible'], undefined);
    expect('visible' in elementOf(cleared, path)).toBe(false);
  });

  it('位置尺寸按父容器的排布生成：自由有左上，堆叠有外边距，网格的行列必填', () => {
    const document = fresh();
    const keys = (path: string) => (panelOf(document, path).groups.find((group) => group.name === '位置尺寸')?.fields ?? []).map((field) => field.key);
    expect(keys(at('矩形'))).toEqual(expect.arrayContaining(['place.left', 'place.top', 'place.width', 'place.height']));
    expect(keys(at('矩形'))).not.toContain('place.margin');
    expect(keys(at('容器/容器内文字'))).toContain('place.margin');
    expect(keys(at('容器/容器内文字'))).not.toContain('place.left');
    // 容器改成网格：子元素的 place 换成网格的，行列按顺序补上，文档仍然合法。
    const grid = writeProperty(document, at('容器'), ['layout'], { mode: 'grid', rows: ['hug'], columns: [{ fraction: 1 }] });
    expect(severe(grid)).toEqual([]);
    expect(elementOf(grid, at('容器/容器内文字'))['place']).toEqual({ height: 'fill', row: 1, column: 1 });
    expect(fieldOf(grid, at('容器/容器内文字'), 'place.row')).toMatchObject({ required: true, value: 1 });
    // 改回自由：网格的键去掉。
    const free = writeProperty(grid, at('容器'), ['layout'], { mode: 'free' });
    expect(severe(free)).toEqual([]);
    expect(elementOf(free, at('容器/容器内文字'))['place']).toEqual({ height: 'fill' });
  });

  it('互斥的属性写一边去掉另一边：place 的左与右', () => {
    const document = fresh(), path = at('矩形');
    const right = writeProperty(document, path, ['place', 'right'], 4);
    expect(elementOf(right, path)['place']).toEqual({ top: 80, width: { fixed: 22 }, height: { fixed: 14 }, right: 4 });
    expect(severe(right)).toEqual([]);
  });

  it('尺寸是几个变体：随内容、撑满、固定、按比例；换变体写入它的初始值，子项继续能改', () => {
    const document = fresh(), path = at('矩形'), field = fieldOf(document, path, 'place.width');
    expect(field.editor.kind === 'variants' && field.editor.variants.map((variant) => variant.label)).toEqual(['随内容', '撑满', '固定', '按比例撑满']);
    const fill = writeProperty(document, path, ['place', 'width'], 'fill');
    expect(severe(fill)).toEqual([]);
    expect(fieldOf(fill, path, 'place.width').editor).toMatchObject({ kind: 'variants', active: 1 });
    expect(fieldOf(document, path, 'place.width.fixed')).toMatchObject({ value: 22 });
    const wider = writeProperty(document, path, ['place', 'width', 'fixed'], 30);
    expect(elementOf(wider, path)['place']).toMatchObject({ width: { fixed: 30 } });
  });

  it('if/then 的收窄生效：竖排的对齐只列合法取值，改竖排时去掉因此失效的属性', () => {
    const document = fresh(), path = at('文字');
    const options = (doc: JsonObject) => {
      const { editor } = fieldOf(doc, path, 'horizontalAlign');
      return editor.kind === 'choice' ? editor.options.map((option) => option.value) : [];
    };
    expect(options(document)).toContain('distribute');
    const distributed = writeProperty(document, path, ['horizontalAlign'], 'distribute');
    const withWidth = writeProperty(distributed, path, ['fit', 'minFontSize'], 3);
    const withSteps = writeProperty(withWidth, path, ['fit', 'steps'], ['compressGlyphs', 'shrink']);
    expect(severe(withSteps)).toEqual([]);

    const vertical = writeProperty(withSteps, path, ['writingMode'], 'vertical');
    expect(severe(vertical)).toEqual([]);
    const element = elementOf(vertical, path);
    expect(element['writingMode']).toBe('vertical');
    expect('horizontalAlign' in element, '分散不是竖排的取值').toBe(false);
    expect(element['fit']).not.toHaveProperty('minFontSize');
    expect(options(vertical)).toEqual(['start', 'center', 'end']);
    expect(fieldOf(vertical, path, 'fit.steps').editor).toMatchObject({ kind: 'choice' });
  });

  it('缺省就无效的对象要先添加：描边写入初始值后合法，可以改子项，整个去掉回到原样', () => {
    const document = fresh(), path = at('椭圆'), field = fieldOf(document, path, 'stroke');
    expect(field.editor).toMatchObject({ kind: 'group', absent: true, initial: { color: '#000000', width: 1 } });
    const added = writeProperty(document, path, ['stroke'], field.editor.kind === 'group' ? field.editor.initial : undefined);
    expect(severe(added)).toEqual([]);
    const thicker = writeProperty(added, path, ['stroke', 'width'], 2);
    expect(elementOf(thicker, path)['stroke']).toEqual({ color: '#000000', width: 2 });
    expect(fieldOf(thicker, path, 'stroke.width')).toMatchObject({ required: true });
    expect('stroke' in elementOf(writeProperty(thicker, path, ['stroke'], undefined), path)).toBe(false);
  });

  it('写空的可选对象不留 {}：适配去掉最后一项后整个没了', () => {
    const document = fresh(), path = at('椭圆');
    const fit = writeProperty(document, at('文字'), ['fit'], { compressMin: 0.8 });
    expect(elementOf(writeProperty(fit, at('文字'), ['fit', 'compressMin'], undefined), at('文字'))).not.toHaveProperty('fit');
    // place 没有必填项：还没写过的元素也能直接填子项。
    const noPlace = writeProperty(document, path, ['place'], undefined);
    expect(fieldOf(noPlace, path, 'place.left')).toMatchObject({ value: undefined, required: false });
    expect(elementOf(writeProperty(noPlace, path, ['place', 'left'], 5), path)['place']).toEqual({ left: 5 });
  });

  it('文字的内容是片段列表：固定文字与字段两种，可以追加，片段里的属性各自能改', () => {
    const document = fresh(), path = at('容器/容器内文字'), field = fieldOf(document, path, 'content');
    expect(field.editor.kind).toBe('list');
    const append = field.editor.kind === 'list' ? field.editor.append : [];
    expect(append.map((option) => option.label)).toEqual(['固定文字', '字段']);
    const longer = writeProperty(document, path, ['content'], [...elementOf(document, path)['content'] as unknown[], append[0]!.value]);
    expect(severe(longer)).toEqual([]);
    const written = writeProperty(longer, path, ['content', 2, 'text'], ' 有限公司');
    expect((elementOf(written, path)['content'] as unknown[]).at(-1)).toEqual({ text: ' 有限公司' });
    expect(fieldOf(written, path, 'content.1.slot')).toMatchObject({ value: 'organization' });
    const formatted = writeProperty(written, path, ['content', 1, 'format'], '0');
    expect((elementOf(formatted, path)['content'] as unknown[])[1]).toEqual({ slot: 'organization', format: '0' });
    expect(severe(formatted)).toEqual([]);
  });

  it('状态样式：取决于变量，各取值只写覆盖的属性，覆盖项的编辑器按元素自身的属性生成', () => {
    const document = fresh(), path = at('椭圆'), field = fieldOf(document, path, 'states');
    expect(field.editor).toMatchObject({ kind: 'group', absent: true });
    const added = writeProperty(document, path, ['states'], { by: { var: 'role' }, cases: { 讲者: { fill: '#B4532A' } } });
    expect(severe(added)).toEqual([]);
    const cases = fieldOf(added, path, 'states.cases');
    expect(cases.editor).toMatchObject({ kind: 'map' });
    expect(cases.editor.kind === 'map' && cases.editor.overrides?.map((option) => option.label)).toEqual(expect.arrayContaining(['填充色', '描边', '不透明度']));
    expect(fieldOf(added, path, 'states.cases.讲者.fill').editor).toMatchObject({ kind: 'variants' });
    const changed = writeProperty(added, path, ['states', 'cases', '讲者', 'fill'], '#000000');
    expect(elementOf(changed, path)['states']).toEqual({ by: { var: 'role' }, cases: { 讲者: { fill: '#000000' } } });
  });

  it('循环容器的传入参数是键值：值是变量、固定值或循环位置', () => {
    const document = fresh(), path = at('循环');
    const written = writeProperty(document, path, ['args', 'accent'], { loop: 'index' });
    const field = fieldOf(written, path, 'args.accent');
    expect(field.editor.kind === 'variants' && field.editor.variants.map((variant) => variant.label)).toEqual(['绑定变量', '固定值', '循环位置']);
    expect(field.editor).toMatchObject({ active: 2 });
    expect(severe(writeProperty(written, path, ['args', 'accent'], undefined))).toEqual([]);
  });

  it('线条与路径的 fit 依赖视图框：没写视图框时标出来，写了就合法', () => {
    const document = fresh(), path = at('路径');
    expect(fieldOf(document, path, 'fit').needs).toEqual(['viewBox']);
    const framed = writeProperty(document, path, ['viewBox'], [0, 0, 40, 20]);
    expect(fieldOf(framed, path, 'fit').needs).toBeUndefined();
    const fitted = writeProperty(framed, path, ['fit'], 'contain');
    expect(severe(fitted)).toEqual([]);
    expect(fieldOf(fitted, path, 'viewBox.2')).toMatchObject({ required: true, value: 40, editor: { kind: 'number', exclusiveMin: 0 } });
  });

  it('画板的属性来自画板的 Schema：适用尺寸、缩字下限与子元素分开', () => {
    const document = fresh(), panel = panelOf(document, NAME);
    expect(panel.type).toBe('artboard');
    expect(fieldOf(document, NAME, 'minFontSize').editor).toMatchObject({ kind: 'number', min: 1.5 });
    expect(allFields(panel).map((field) => field.key)).not.toContain('children');
    const wider = writeProperty(document, NAME, ['sizeRange', 'width', 'max'], 130);
    expect(severe(wider)).toEqual([]);
    expect(fieldOf(wider, NAME, 'sizeRange.width.max')).toMatchObject({ value: 130, required: true });
  });

  it('不存在的元素没有面板，写回原样返回', () => {
    const document = fresh();
    expect(propertyPanel(document, at('没有这个'))).toBeUndefined();
    expect(writeProperty(document, at('没有这个'), ['fill'], '#000000')).toBe(document);
  });
});

describe('参数与检查项：同一套规则', () => {
  const parameter = (document: JsonObject, name: string) => (document['parameters'] as JsonObject[]).find((item) => item['name'] === name)!;
  const indexOf = (document: JsonObject, name: string) => (document['parameters'] as JsonObject[]).findIndex((item) => item['name'] === name);
  const field = (document: JsonObject, name: string, key: string) => {
    const found = listItemPanel(document, 'parameters', indexOf(document, name)).find((item) => item.key === key);
    if (!found) throw new Error(`参数没有可编辑项 ${key}`);
    return found;
  };

  it('显示名称、可见性、类型、约束与缺省值都可编辑；名称是身份，不在这里改', () => {
    const document = fresh(), keys = listItemPanel(document, 'parameters', 0).map((item) => item.key);
    expect(keys).toEqual(['displayName', 'visibility', 'type', 'constraints', 'default']);
    const renamed = writeListItem(document, 'parameters', indexOf(document, 'nameSize'), ['displayName'], '名字字号');
    expect(parameter(renamed, 'nameSize')['displayName']).toBe('名字字号');
    expect(severe(renamed)).toEqual([]);
  });

  it('约束按类型生成：数字有最小最大，颜色没有约束；改类型时去掉不再合法的约束与缺省值', () => {
    const document = fresh();
    const constraintKeys = (doc: JsonObject, name: string) => {
      const { editor } = field(doc, name, 'constraints');
      return editor.kind === 'group' ? editor.fields.map((item) => item.key) : [];
    };
    expect(constraintKeys(document, 'nameSize')).toEqual(['constraints.integer', 'constraints.min', 'constraints.max', 'constraints.enum']);
    expect(constraintKeys(document, 'accentColor')).toEqual([]);
    expect(field(document, 'accentColor', 'default').editor).toMatchObject({ kind: 'color' });
    const index = indexOf(document, 'nameSize');
    const max = writeListItem(document, 'parameters', index, ['constraints', 'max'], 20);
    expect(parameter(max, 'nameSize')['constraints']).toEqual({ min: 3, max: 20 });
    const text = writeListItem(max, 'parameters', index, ['type'], 'text');
    expect(parameter(text, 'nameSize')['type']).toBe('text');
    expect(parameter(text, 'nameSize')).not.toHaveProperty('constraints');
    expect(parameter(text, 'nameSize')).not.toHaveProperty('default');
  });

  it('内部参数必须有缺省值：改成内部时缺省值没写就补上', () => {
    const document = fresh(), index = indexOf(document, 'nameSize');
    const noDefault = writeListItem(document, 'parameters', index, ['default'], undefined);
    expect(field(noDefault, 'nameSize', 'default').required).toBe(false);
    const internal = writeListItem(noDefault, 'parameters', index, ['visibility'], 'internal');
    expect(parameter(internal, 'nameSize')).toHaveProperty('default');
    expect(field(internal, 'nameSize', 'default').required).toBe(true);
    expect(severe(internal)).toEqual([]);
  });

  it('检查项：等级、说明与条件都可编辑', () => {
    const document = fresh(), keys = listItemPanel(document, 'checks', 0).map((item) => item.key);
    expect(keys).toEqual(['displayName', 'problemWhen', 'level', 'message']);
    const raised = writeListItem(document, 'checks', 0, ['level'], 'severe');
    expect((raised['checks'] as JsonObject[])[0]!['level']).toBe('severe');
    expect(severe(raised)).toEqual([]);
  });
});

describe('穷举：每个元素的每个顶层属性，每个变体的初始值写回后结构都合法', () => {
  // 这些初始值要人再填一步才完整：资源引用没有合法的缺省值。
  const NEEDS_INPUT = new Set(['font', 'source']);
  const leaves = ['容器', '容器/容器内文字', '循环', '调用', '文字', '图片', '二维码', '条码', '矩形', '椭圆', '线条', '多边形', '路径'];

  it.each(leaves)('%s', (name) => {
    const path = at(name), document = fresh(), panel = panelOf(document, path), failures: string[] = [];
    const tryWrite = (field: PropertyField, label: string, value: unknown) => {
      const written = writeProperty(document, path, field.path, value);
      const found = severe(written);
      if (found.length) failures.push(`${field.key} = ${label}（${JSON.stringify(value)}）：${found.map((problem) => problem.message).join('；')}`);
    };
    for (const field of panel.groups.flatMap((group) => group.fields)) {
      if (NEEDS_INPUT.has(String(field.path[0])) || field.needs) continue;
      const { editor } = field;
      if (editor.kind === 'variants') editor.variants.forEach((variant) => { if (!(typeof variant.initial === 'string' && variant.initial === 'res:')) tryWrite(field, variant.label, variant.initial); });
      if (editor.kind === 'choice') editor.options.forEach((option) => tryWrite(field, option.label, option.value));
      if (editor.kind === 'group' && editor.absent) tryWrite(field, '初始值', editor.initial);
    }
    expect(failures).toEqual([]);
  });
});
