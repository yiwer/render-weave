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

/** 问候牌样例：四份文档；withFont 时另放入它用的字体 font-hei-medium。 */
export async function seedGreeting(storage: TenantStorage, options: { readonly withFont?: boolean } = {}): Promise<void> {
  await seedDocuments(storage, await Promise.all(GREETING_FILES.map(async (file) => new Uint8Array(await readFile(`${SINGLE_TEXT}${file}`)))));
  if (options.withFont) {
    const committed = await storage.resources.commit([{ type: 'create', id: 'font-hei-medium', kind: 'font', bytes: new Uint8Array(await readFile(FONT_MEDIUM)) }]);
    if (committed.problems.length) throw new Error(JSON.stringify(committed.problems));
  }
}

/**
 * 压力牌：一个纵向循环，每项一行文字（只用 font-hei-medium）。项数多时排版费时、内存不大，用来触发单项超时。
 * 数据集写在请求里，见 stressRequest。
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
  }].map(bytesOf));
}

export function stressRequest(items: number): Record<string, unknown> {
  return {
    template: '压力牌',
    dataset: { inline: { dataset: { staticSchema: { name: '压力', version: 1 } }, data: { items: Array.from({ length: items }, (_, i) => ({ label: `第 ${i + 1} 项` })) } } },
    parameters: {},
    output: { width: 200, height: 200, dpi: 120, format: 'png' },
  };
}

/** 问候牌的预览请求；不写 mode，预览只出草稿。 */
export function greetingPreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { template: '问候牌', dataset: { id: 'ds-greeting' }, parameters: {}, output: { width: 160, height: 40, dpi: 120, format: 'png' }, ...overrides };
}
