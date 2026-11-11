/**
 * 改结构（模板设计页票据 12）：只经"给文档、模板名与元素路径，得到新文档与选中路径"这一入口，每个操作配自由、堆叠、网格三种父布局，
 * 写回的结果由引擎的 checkDslDocument 判断；原文档不变（撤销还原字节由编辑会话的用例管）。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { elementAt, flatElements, type JsonObject } from '../console/src/template/document.js';
import { callersOf, deleteElement, dropTarget, duplicateElement, moveElement, moveElementTo, nameProblem, renameElement, unwrapContainer, wrapInContainer, type Edited } from '../console/src/template/structure.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE, M402_DIR } from './seed.js';

const ALL = '全元素牌', ROUTE = '标准线路单边', STOP = '站点';
let all: JsonObject, route: JsonObject, stop: JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const json = (document: JsonObject) => JSON.stringify(document);
const names = (document: JsonObject, template: string) => flatElements(document, template).filter((node) => node.path !== template).map((node) => node.name);
const childNames = (document: JsonObject, path: string) => ((elementAt(document, path)?.element['children'] ?? []) as JsonObject[]).map((child) => child['name']);
const placeOf = (document: JsonObject, path: string) => elementAt(document, path)?.element['place'];

beforeAll(async () => {
  all = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  route = JSON.parse(await readFile(`${M402_DIR}template-route-sign.json`, 'utf8')) as JsonObject;
  stop = JSON.parse(await readFile(`${M402_DIR}template-stop.json`, 'utf8')) as JsonObject;
  for (const document of [all, route, stop]) expect(severe(document)).toEqual([]);
});

// 父容器的三种布局：全元素牌的画板是自由布局，M402 的顶栏是横向堆叠，M402 主模板的画板是四行网格。
const LAYOUTS = () => [
  { layout: '自由', document: all, template: ALL, path: `${ALL}/矩形`, parent: ALL },
  { layout: '堆叠', document: route, template: ROUTE, path: `${ROUTE}/顶栏/${String(childNames(route, `${ROUTE}/顶栏`)[1])}`, parent: `${ROUTE}/顶栏` },
  { layout: '网格', document: route, template: ROUTE, path: `${ROUTE}/道路带`, parent: ROUTE },
] as const;

describe.each(['自由', '堆叠', '网格'] as const)('父容器是%s布局', (layout) => {
  const at = () => LAYOUTS().find((item) => item.layout === layout)!;
  const valid = (edited: Edited | undefined) => {
    expect(edited).toBeDefined();
    expect(severe(edited!.document)).toEqual([]);
    const { template } = at(), list = names(edited!.document, template);
    expect(new Set(list).size, '元素名在模板内唯一').toBe(list.length);
    expect(elementAt(edited!.document, edited!.path), '选中路径存在').toBeDefined();
    return edited!;
  };

  it('复制：放在原件后面，连子元素一起起新名；原文档不变', () => {
    const { document, template, path, parent } = at(), before = json(document);
    const { document: next, path: copy } = valid(duplicateElement(document, template, path));
    const kids = childNames(next, parent);
    expect(kids.indexOf(copy.split('/').at(-1)!)).toBe(kids.indexOf(path.split('/').at(-1)!) + 1);
    expect(names(next, template).length).toBeGreaterThan(names(document, template).length);
    expect(json(document)).toBe(before);
  });

  it('删除：选中回到父容器', () => {
    const { document, template, path, parent } = at();
    const edited = valid(deleteElement(document, template, path));
    expect(edited.path).toBe(parent);
    expect(elementAt(edited.document, path)).toBeUndefined();
  });

  it('上移下移：顺序就是 DSL 的顺序；到头时不动', () => {
    const { document, template, path, parent } = at();
    const kids = childNames(document, parent), at0 = kids.indexOf(path.split('/').at(-1)!);
    const step = at0 > 0 ? -1 : 1;
    const moved = valid(moveElement(document, template, path, step));
    expect(childNames(moved.document, parent).indexOf(path.split('/').at(-1)!)).toBe(at0 + step);
    const first = `${parent}/${String(kids[0])}`;
    expect(moveElement(document, template, first, -1)).toBeUndefined();
  });

  it('包进容器：容器占原来的位置，图上的尺寸跟着原件走；再拆开，回到一样的结构', () => {
    const { document, template, path, parent } = at();
    const wrapped = valid(wrapInContainer(document, template, path));
    const container = elementAt(wrapped.document, wrapped.path)!.element;
    expect(container).toMatchObject({ type: 'container', layout: { mode: 'stack', direction: 'column' } });
    expect(container['place']).toEqual(placeOf(document, path));
    expect(childNames(wrapped.document, parent).indexOf(wrapped.path.split('/').at(-1)!)).toBe(childNames(document, parent).indexOf(path.split('/').at(-1)!));
    const unwrapped = valid(unwrapContainer(wrapped.document, template, wrapped.path));
    expect(unwrapped.path).toBe(path);
    expect(childNames(unwrapped.document, parent)).toEqual(childNames(document, parent));
  });

  it('重命名：重名与带斜杠的当场拒绝，不改文档', () => {
    const { document, template, path, parent } = at();
    const other = childNames(document, parent).find((name) => name !== path.split('/').at(-1)) ?? names(document, template).find((name) => name !== path.split('/').at(-1))!;
    expect(renameElement(document, template, path, String(other))).toEqual({ problem: expect.stringContaining('模板内唯一') });
    expect(renameElement(document, template, path, '甲/乙')).toEqual({ problem: expect.stringContaining('/') });
    const renamed = renameElement(document, template, path, '新名字') as Edited;
    valid(renamed);
    expect(renamed.path).toBe(`${parent}/新名字`);
  });
});

describe('换父容器', () => {
  it('从自由布局拖进横向堆叠：place 只留堆叠认识的键', () => {
    const moved = moveElementTo(all, ALL, `${ALL}/矩形`, `${ALL}/容器`, 0)!;
    expect(severe(moved.document)).toEqual([]);
    expect(moved.path).toBe(`${ALL}/容器/矩形`);
    expect(childNames(moved.document, `${ALL}/容器`)[0]).toBe('矩形');
    expect(Object.keys((placeOf(moved.document, moved.path) ?? {}) as object).every((key) => ['width', 'height', 'margin', 'alignSelf', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'].includes(key))).toBe(true);
  });

  it('拖进网格：行列补上，不超出网格的行数（排满了放最后一行，重叠由布局的问题清单说）', () => {
    const moved = moveElementTo(route, ROUTE, `${ROUTE}/顶栏/线路号`, ROUTE, 4)!;
    expect(severe(moved.document)).toEqual([]);
    expect(placeOf(moved.document, moved.path)).toMatchObject({ row: 4, column: 1 });
  });

  it('同一个容器里往后拖：放在目标位置之前', () => {
    const kids = childNames(route, ROUTE);
    const moved = moveElementTo(route, ROUTE, `${ROUTE}/${String(kids[0])}`, ROUTE, 3)!;
    expect(childNames(moved.document, ROUTE)).toEqual([kids[1], kids[2], kids[0], kids[3]]);
  });

  it('拖到一行的上半、下半或里面：换算成容器与位置', () => {
    const kids = childNames(route, ROUTE);
    expect(dropTarget(route, ROUTE, `${ROUTE}/${String(kids[1])}`, 'before')).toEqual({ target: ROUTE, index: 1 });
    expect(dropTarget(route, ROUTE, `${ROUTE}/${String(kids[1])}`, 'after')).toEqual({ target: ROUTE, index: 2 });
    expect(dropTarget(route, ROUTE, `${ROUTE}/顶栏`, 'inside')).toEqual({ target: `${ROUTE}/顶栏`, index: childNames(route, `${ROUTE}/顶栏`).length });
    expect(dropTarget(route, ROUTE, ROUTE, 'before'), '画板外面放不了').toBeUndefined();
    expect(dropTarget(all, ALL, `${ALL}/循环`, 'inside'), '循环里面放不了').toBeUndefined();
  });

  it('不能放进自己、自己的子孙，也不能放进循环与调用', () => {
    expect(moveElementTo(route, ROUTE, `${ROUTE}/站点面板`, `${ROUTE}/站点面板`, 0)).toBeUndefined();
    expect(moveElementTo(all, ALL, `${ALL}/文字`, `${ALL}/循环`, 0)).toBeUndefined();
    expect(moveElementTo(all, ALL, `${ALL}/文字`, `${ALL}/调用`, 0)).toBeUndefined();
  });
});

describe('名称与调用方', () => {
  it('名称在模板内唯一：别的容器里的同名也算重名；自己原来的名字不算', () => {
    expect(nameProblem(stop, STOP, `${STOP}/名称区/站名`, '站名')).toBeUndefined();
    expect(nameProblem(stop, STOP, `${STOP}/名称区/站名`, '地标')).toContain('模板内唯一');
    expect(nameProblem(stop, STOP, `${STOP}/名称区/站名`, ' ')).toContain('不能为空');
  });

  it('画板不能复制、删除、移动、包进容器或改名', () => {
    expect(duplicateElement(all, ALL, ALL)).toBeUndefined();
    expect(deleteElement(all, ALL, ALL)).toBeUndefined();
    expect(moveElement(all, ALL, ALL, 1)).toBeUndefined();
    expect(wrapInContainer(all, ALL, ALL)).toBeUndefined();
    expect(renameElement(all, ALL, ALL, '新')).toBeUndefined();
  });

  it('拆开只对容器：循环与调用不行', () => {
    expect(unwrapContainer(all, ALL, `${ALL}/循环`)).toBeUndefined();
  });

  it('列出调用这个模板的地方', () => {
    expect(callersOf(STOP, [{ name: ROUTE, document: route }, { name: STOP, document: stop }])).toEqual([`${ROUTE}/站点面板/站点列`]);
  });
});
