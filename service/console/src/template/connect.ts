/**
 * 连接数据（模板设计页第三轮票据 07）：把一个字段或变量连到已有的元素上。文字换成它的插槽，图片换来源，布尔绑显示。
 * 纯函数，不碰页面与接口：拖到元素上、右键菜单的"连接数据…"、"数据"页的"+"都走 connectData 这一处，写回逐字节相同。
 * 合不合类型在这里判断，拒绝时给一句写在落点的原因；写回结果合不合法由引擎的 checkDslDocument 判断（见 template-connect.test.ts）。
 */
import { canDisplay } from './content.js';
import { CATALOG } from './create.js';
import { elementAt, isObject, type JsonObject } from './document.js';
import { writeProperty } from './properties.js';

/** 能连上去的一份数据：字段、参数或派生变量。name 是写进 { var } 与插槽的名称。 */
export interface DataSource { readonly name: string; readonly label: string; readonly type: string }

/** 连上之后改的是哪一处：文字的内容、图片的来源、元素的显示。 */
export type ConnectEffect = 'content' | 'source' | 'visible';

export type Connected =
  | { readonly ok: true; readonly effect: ConnectEffect; readonly document: JsonObject; readonly summary: string }
  | { readonly ok: false; readonly reason: string };

const TYPE_LABELS: Readonly<Record<string, string>> = { text: '文本', number: '数值', date: '日期', time: '时刻', datetime: '时间', boolean: '布尔', image: '图片', color: '颜色', list: '列表', ref: '引用' };
const typeLabel = (type: string) => TYPE_LABELS[type] ?? type;
const kindLabel = (type: unknown) => CATALOG.find((item) => item.kind === type)?.label ?? '元素';
const lastOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** 这种元素接这种类型的数据，改的是哪一处；接不了是 undefined。布尔绑的是显示，哪种元素都行。 */
export function connectEffect(elementType: unknown, sourceType: string): ConnectEffect | undefined {
  if (sourceType === 'boolean') return 'visible';
  if (elementType === 'text' && canDisplay(sourceType)) return 'content';
  if (elementType === 'image' && sourceType === 'image') return 'source';
  return undefined;
}

const isVar = (value: unknown, name: string) => isObject(value) && value['var'] === name && Object.keys(value).length === 1;

/** 已经是连着它的样子：再连一次什么也不会变。 */
function alreadyConnected(element: JsonObject, effect: ConnectEffect, name: string): boolean {
  if (effect === 'visible') return isVar(element['visible'], name);
  if (effect === 'source') return isVar(element['source'], name);
  const content = element['content'];
  return Array.isArray(content) && content.length === 1 && isObject(content[0]) && content[0]['slot'] === name && Object.keys(content[0]).length === 1;
}

/**
 * 字段拖到一个元素上算什么：connect 是连到它上面（合不合类型由 connectData 说），inside 是放进它里面建新元素，
 * pass 是它既接不了数据也装不了元素，图上接着往外找容器，图层里只能放在它前后。
 */
export function fieldDropKind(elementType: unknown, isArtboard: boolean, fieldType: string): 'connect' | 'inside' | 'pass' {
  if (fieldType === 'boolean') return 'connect';
  if (isArtboard || elementType === 'container') return 'inside';
  return elementType === 'text' || elementType === 'image' ? 'connect' : 'pass';
}

/** 把 source 连到 template 里 path 这个元素上。原文档不变；类型不合、画板、已经连着都拒绝并说明原因。 */
export function connectData(document: JsonObject, template: string, path: string, source: DataSource): Connected {
  const located = path === template ? undefined : elementAt(document, path);
  const what = `「${source.label}」`;
  if (path === template) {
    return { ok: false, reason: source.type === 'boolean' ? `布尔类型的${what}绑的是元素的显示，画板没有显示条件：拖到一个元素上。` : '画板接不了数据：拖到一个元素上，或拖到空白处建一个新元素。' };
  }
  if (!located) return { ok: false, reason: '找不到这个元素，可能刚被删掉。' };
  const element = located.element, type = element['type'], name = `「${lastOf(path)}」`;
  const effect = connectEffect(type, source.type);
  if (!effect) {
    if (source.type === 'list') return { ok: false, reason: `${what}是列表，连不到${name}上：列表建的是循环容器，拖到空白处或容器里。` };
    if (source.type === 'ref') return { ok: false, reason: `${what}是引用，连不到${name}上：引用建的是子模板调用，拖到空白处或容器里。` };
    if (type === 'text') return { ok: false, reason: `${name}是文字，接不了${typeLabel(source.type)}类型的${what}${source.type === 'image' ? '：拖到图片上换来源，或拖到空白处建一个图片' : ''}。` };
    if (type === 'image') return { ok: false, reason: `${name}是图片，接不了${typeLabel(source.type)}类型的${what}${canDisplay(source.type) ? '：拖到文字上换内容，或拖到空白处建一个文字' : ''}。` };
    return { ok: false, reason: `${name}是${kindLabel(type)}，接不了${typeLabel(source.type)}类型的${what}：文字接文字类的数据，图片接图片，布尔绑显示。` };
  }
  if (alreadyConnected(element, effect, source.name)) return { ok: false, reason: `${name}已经连着${what}了。` };
  const called = `${what}（${source.name}）`;
  if (effect === 'visible') return { ok: true, effect, document: writeProperty(document, path, ['visible'], { var: source.name }), summary: `${name}按${called}决定显示。` };
  if (effect === 'source') return { ok: true, effect, document: writeProperty(document, path, ['source'], { var: source.name }), summary: `${name}的图片来源换成了${called}。` };
  return { ok: true, effect, document: writeProperty(document, path, ['content'], [{ slot: source.name }]), summary: `${name}的内容换成了${called}。` };
}

export interface ConnectChoice {
  readonly source: DataSource;
  readonly effect: ConnectEffect;
  /** 选了它会怎样，写在菜单这一行的右边。 */
  readonly what: string;
  /** 已经连着：列出来但不能再选。 */
  readonly current: boolean;
}

const EFFECT_TEXT: Readonly<Record<ConnectEffect, string>> = { content: '换内容', source: '换来源', visible: '绑显示' };

/** "连接数据…"里列哪些：作用域里类型和这个元素相符的字段与变量，顺序照 variables。画板与找不到的元素没有可连的。 */
export function connectChoices(document: JsonObject, template: string, path: string, variables: readonly DataSource[]): readonly ConnectChoice[] {
  const element = path === template ? undefined : elementAt(document, path)?.element;
  if (!element) return [];
  return variables.flatMap((source): ConnectChoice[] => {
    const effect = connectEffect(element['type'], source.type);
    return effect ? [{ source, effect, what: EFFECT_TEXT[effect], current: alreadyConnected(element, effect, source.name) }] : [];
  });
}
