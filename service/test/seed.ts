/**
 * 测试准备：经租户的存储接口放入工作区文档与资源，效果与代建推送相同（来源"种类:键"、模板记修订）。
 * 只用于准备，被测的行为仍经开放 API 观察。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { DocumentKind, StoredDocument, TenantStorage } from '../src/backend.js';
import { classifyWorkspaceDocument, parseJsonKeepingPrecision, publishStaticSchema } from '../src/engine.js';

export const SINGLE_TEXT = fileURLToPath(new URL('../../fixtures/workspaces/single-text/', import.meta.url));
export const FONT_MEDIUM = fileURLToPath(new URL('../../fixtures/resources/fonts/SourceHanSansCN-Medium.otf', import.meta.url));
/** 问候牌样例工作区的四份文档。 */
export const GREETING_FILES = ['schema-greeting-v1.json', 'compiled-greeting-v1.schema.json', 'template-greeting.json', 'dataset-greeting.json'];

const bytesOf = (value: unknown) => new Uint8Array(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));

/** 放入一批文档（原始字节）：数据定义、编译产物与数据集新增，模板记一个新修订。 */
export async function seedDocuments(storage: TenantStorage, documents: readonly Uint8Array[]): Promise<void> {
  const stored: StoredDocument[] = [];
  for (const bytes of documents) {
    const found = classifyWorkspaceDocument(parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), []));
    if (found.kind === 'other' || found.kind === 'invalid') throw new Error('不是工作区文档');
    stored.push({ kind: found.kind as DocumentKind, key: found.key, sha256: await storage.contents.put(bytes), byteLength: bytes.length });
  }
  await storage.push(async () => ({
    documents: stored.filter((document) => document.kind !== 'template'),
    templates: stored.filter((document) => document.kind === 'template').map((document) => ({ name: document.key, sha256: document.sha256, byteLength: document.byteLength })),
    resources: [],
  }), { pushedBy: '测试准备', now: new Date() });
}

export const M402_DIR = fileURLToPath(new URL('../../docs/examples/m402-dsl/', import.meta.url));
export const RESOURCES_DIR = fileURLToPath(new URL('../../fixtures/resources/', import.meta.url));
/** M402 样例工作区的文档：两个数据定义、两份编译产物、五个模板与一个数据集。 */
export const M402_FILES = [
  'schema-route-sign-v1.json', 'compiled-route-sign-v1.schema.json', 'schema-stop-v1.json', 'compiled-stop-v1.schema.json',
  'template-route-sign.json', 'template-stop.json', 'template-stop-badge.json', 'template-road-segment.json', 'template-departure-time.json', 'dataset-m402.json',
];
/** M402 数据集与模板引用的图片，以及模板用的字体 font-hei-medium（也是引擎的后备字体之一）。 */
export const M402_RESOURCES: readonly { readonly id: string; readonly kind: 'image' | 'font'; readonly file: string }[] = [
  { id: 'route-no-m402', kind: 'image', file: 'images/m402/route-no-m402.png' },
  ...[1, 2, 3, 4].map((n) => ({ id: `landmark-${n}`, kind: 'image' as const, file: `images/m402/landmark-${n}.png` })),
  { id: 'icon-metro', kind: 'image', file: 'images/m402/icon-metro.png' },
  { id: 'icon-hospital', kind: 'image', file: 'images/m402/icon-hospital.png' },
  { id: 'font-hei-medium', kind: 'font', file: 'fonts/SourceHanSansCN-Medium.otf' },
];

/** M402 样例：十份文档与它引用的图片、字体，效果与代建推送相同。 */
export async function seedM402(storage: TenantStorage): Promise<void> {
  await seedDocuments(storage, await Promise.all(M402_FILES.map(async (file) => new Uint8Array(await readFile(`${M402_DIR}${file}`)))));
  const committed = await storage.resources.commit(await Promise.all(M402_RESOURCES.map(async ({ id, kind, file }) =>
    ({ type: 'create' as const, id, kind, bytes: new Uint8Array(await readFile(`${RESOURCES_DIR}${file}`)) }))));
  if (committed.problems.length) throw new Error(JSON.stringify(committed.problems));
}

/** 问候牌样例：四份文档；withFont 时另放入它用的字体 font-hei-medium。 */
export async function seedGreeting(storage: TenantStorage, options: { readonly withFont?: boolean } = {}): Promise<void> {
  await seedDocuments(storage, await Promise.all(GREETING_FILES.map(async (file) => new Uint8Array(await readFile(`${SINGLE_TEXT}${file}`)))));
  if (options.withFont) {
    const committed = await storage.resources.commit([{ type: 'create', id: 'font-hei-medium', kind: 'font', bytes: new Uint8Array(await readFile(FONT_MEDIUM)) }]);
    if (committed.problems.length) throw new Error(JSON.stringify(committed.problems));
  }
}

/**
 * 压力牌：一个纵向循环，每项一行文字（只用 font-hei-medium）。项数多时草稿要画很多问题边框，费时、内存不大，用来触发单项超时。
 * 压力细牌同样排布，字号 0.6 mm：2,000 项排进 2,000 mm 高也放得下，正式模式没有严重问题，会画完整张图（本机约 0.7 秒），
 * 批量交付的取消用它。数据集写在请求里，见 stressRequest。
 */
export async function seedStress(storage: TenantStorage): Promise<void> {
  const item = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '压力项', version: 1, displayName: '压力项',
    fields: [{ name: 'label', displayName: '标签', type: 'text' }] }, []);
  const itemEntry = { ref: item.published!.ref, definition: item.published!.definition, compiled: item.published!.compiled };
  const list = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '压力', version: 1, displayName: '压力',
    fields: [{ name: 'items', displayName: '列表', type: 'list', items: { type: 'ref', ref: { name: '压力项', version: 1 } } }] }, [itemEntry]);
  const range = { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } };
  await seedDocuments(storage, [item.published!.definition, item.published!.compiled, list.published!.definition, list.published!.compiled, {
    dslVersion: 'renderweave-template/1', name: '压力项卡', base: { name: '压力项', version: 1 },
    artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'row' }, children: [
      { type: 'text', name: '标签', content: [{ slot: 'label' }], font: 'res:font-hei-medium', fontSize: 2, color: '#333333', place: { width: 'fill', height: 'fill' } }] },
  }, {
    dslVersion: 'renderweave-template/1', name: '压力牌', base: { name: '压力', version: 1 },
    artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'row' }, children: [
      { type: 'loop', name: '列', list: { var: 'items' }, template: '压力项卡', args: {}, itemLayout: { direction: 'column', heights: 'equal' }, place: { width: 'fill', height: 'fill' } }] },
  }, {
    dslVersion: 'renderweave-template/1', name: '压力细项卡', base: { name: '压力项', version: 1 },
    artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'row' }, children: [
      { type: 'text', name: '标签', content: [{ slot: 'label' }], font: 'res:font-hei-medium', fontSize: 0.6, color: '#333333', place: { width: 'fill', height: 'fill' } }] },
  }, {
    dslVersion: 'renderweave-template/1', name: '压力细牌', base: { name: '压力', version: 1 },
    artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'row' }, children: [
      { type: 'loop', name: '列', list: { var: 'items' }, template: '压力细项卡', args: {}, itemLayout: { direction: 'column', heights: 'equal' }, place: { width: 'fill', height: 'fill' } }] },
  }].map(bytesOf));
}

/** padding 是每项标签另加的字数：项数受展开上限约束时，用更长的标签拉长排版用时。 */
export function stressRequest(items: number, options: { readonly padding?: number; readonly template?: '压力牌' | '压力细牌'; readonly height?: number } = {}): Record<string, unknown> {
  const { padding = 0, template = '压力牌', height = 200 } = options;
  return {
    template,
    dataset: { inline: { dataset: { staticSchema: { name: '压力', version: 1 } }, data: { items: Array.from({ length: items }, (_, i) => ({ label: `第 ${i + 1} 项${'站'.repeat(padding)}` })) } } },
    parameters: {},
    output: { width: 200, height, dpi: 120, format: 'png' },
  };
}

/** 问候牌的预览请求；不写 mode，预览只出草稿。 */
export function greetingPreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { template: '问候牌', dataset: { id: 'ds-greeting' }, parameters: {}, output: { width: 160, height: 40, dpi: 120, format: 'png' }, ...overrides };
}
