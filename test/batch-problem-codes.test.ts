/**
 * 批量项与单次渲染对同一问题给出同一问题清单（阶段 4 票据 02，M203 遗留）。
 * 同一份有问题的输入分别走 render 与只有一项的批量交付，比较问题码、等级、位置与说明；
 * record.invalid 只留给记录本身不合法的情况。
 */
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMemoryBatch, createMemoryResourceBackend, createMemoryResourceRepository, freezeBatch, initializeResourceStore,
  localWorkspaceDocuments, readWorkspaceDocuments, render, runFrozenBatch, type VersionedResourceStore, type Workspace,
} from '../src/index.js';
import { runCli } from '../src/cli.js';
import { m402Dir } from './support/fixtures.js';

type RecordDocuments = Omit<Workspace, 'resources'>;

let root: string, documents: RecordDocuments, store: VersionedResourceStore, single: Record<string, any>;
const codes = (problems: readonly { code: string }[]) => problems.map((p) => p.code);

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-batch-codes-'));
  documents = await readWorkspaceDocuments(localWorkspaceDocuments(m402Dir));
  expect(documents.problems).toEqual([]);
  store = (await createMemoryResourceBackend().open()).store!;
  single = JSON.parse(await fs.readFile(join(m402Dir, 'render-request-m402.json'), 'utf8'));
});
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-batch-codes-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

/** M402 渲染项；降到 30 DPI 只为缩短测试。 */
const item = (dataset: unknown) => ({ dataset, parameters: { currentIndex: 2 }, output: { ...single.output, dpi: 30 } });
const withDataset = (docs: RecordDocuments): RecordDocuments => ({ ...docs, datasets: [...docs.datasets,
  { id: 'ds-v2', document: { dataset: { id: 'ds-v2', staticSchema: { name: '线路牌', version: 2 } }, data: {} } }] });
/** 只有数据定义原文、没有编译产物的静态定义。 */
const withUncompiled = (docs: RecordDocuments): RecordDocuments => {
  const stop = docs.staticSchemas.find((s) => s.ref.name === '停靠站点')!;
  return { ...docs, staticSchemas: [...docs.staticSchemas,
    { ref: { name: '站点草稿', version: 1 }, definition: { ...(stop.definition as object), name: '站点草稿' } }] };
};

const same = (docs: RecordDocuments) => docs;
/** 名称、渲染项的数据集、单次渲染必有的问题码、对工作区文档的改动。 */
const cases: readonly (readonly [string, unknown, string, (docs: RecordDocuments) => RecordDocuments])[] = [
  ['数据集不存在', { id: 'ds-missing' }, 'input.datasetNotFound', same],
  ['内联数据集的静态定义不存在', { inline: { dataset: { staticSchema: { name: '线路牌', version: 2 } }, data: {} } }, 'input.staticSchemaNotFound', same],
  ['已保存数据集的静态定义不存在', { id: 'ds-v2' }, 'input.staticSchemaNotFound', withDataset],
  ['静态定义没有编译产物', { inline: { dataset: { staticSchema: { name: '站点草稿', version: 1 } }, data: {} } }, 'input.compiledSchemaMissing', withUncompiled],
  ['数据集与模板的基准不符', { inline: { dataset: { staticSchema: { name: '停靠站点', version: 1 } }, data: {} } }, 'dataset.staticSchemaMismatch', same],
  ['内联数据集结构不合法', { inline: { dataset: {}, data: {} } }, 'request.invalid', same],
  ['内联数据不符合定义', { inline: { dataset: { staticSchema: { name: '线路牌', version: 1 } }, data: {} } }, 'dataset.requiredMissing', same],
];

describe.each(['final', 'draft'] as const)('%s 模式', (mode) => {
  it.each(cases)('%s：批量项与单次渲染的问题清单相同', async (_name, dataset, expected, change) => {
    const docs = change(documents);
    const direct = await render({ ...docs, resources: createMemoryResourceRepository([]) }, { template: single.template, mode, ...item(dataset) });
    expect(codes(direct.problems)).toContain(expected);

    const frozen = await freezeBatch({ workspace: docs, resources: store, request: { template: single.template, mode, items: [{ id: 'bad', ...item(dataset) }] } });
    expect(frozen.problems).toEqual([]);
    const { output } = createMemoryBatch();
    const result = await runFrozenBatch({ snapshot: frozen.snapshot!, contents: async (info) => frozen.contents!.get(info.id)!, output });
    expect(result.problems).toEqual([]);
    const [only] = result.items;
    expect(only!.problems).toEqual(direct.problems);
    expect(codes(only!.problems)).not.toContain('record.invalid');
    expect(only!.status).toBe(direct.image ? 'previewed' : 'failed');
  }, 60_000);
});

const withRoot = (mutate: (document: Record<string, any>) => void) => (docs: RecordDocuments): RecordDocuments => ({ ...docs,
  templates: docs.templates.map((entry) => {
    if (entry.name !== single.template) return entry;
    const document = structuredClone(entry.document) as Record<string, any>;
    mutate(document);
    return { ...entry, document };
  }) });
const rejections: readonly (readonly [string, string, string, (docs: RecordDocuments) => RecordDocuments])[] = [
  ['根模板不存在', '不存在的模板', 'input.templateNotFound', same],
  ['根模板的基准没有静态定义', '', 'input.staticSchemaNotFound', withRoot((document) => { document.base = { name: '线路牌', version: 9 }; })],
  ['被调模板不存在', '', 'input.templateNotFound', (docs) => ({ ...docs, templates: docs.templates.filter((t) => t.name !== '道路段') })],
  ['根模板无法通过静态读取', '', 'template.invalid', withRoot((document) => { document.artboard = 1; })],
  ['工作区有严重读取问题', '', 'input.unreadable', (docs) => ({ ...docs,
    problems: [{ level: 'severe', code: 'input.unreadable', location: { kind: 'input', source: 'broken.json' }, message: '工作区文件无法读取' }] })],
];

it.each(rejections)('整批拒绝（%s）：批次问题都是单次渲染同样会报的问题', async (_name, template, expected, change) => {
  const docs = change(documents), root = template || single.template;
  const direct = await render({ ...docs, resources: createMemoryResourceRepository([]) }, { template: root, mode: 'final', ...item(single.dataset) });
  const frozen = await freezeBatch({ workspace: docs, resources: store, request: { template: root, mode: 'final', items: [{ id: 'ok', ...item(single.dataset) }] } });
  expect(frozen.snapshot).toBeUndefined();
  expect(codes(frozen.problems)).toContain(expected);
  expect(codes(frozen.problems)).not.toContain('record.invalid');
  expect(direct.problems).toEqual(expect.arrayContaining([...frozen.problems]));
}, 60_000);

it('能展开却成不了自足记录（静态定义缺少原文）：单次渲染照常出图，批量交付仍报 record.invalid', async () => {
  const docs: RecordDocuments = { ...documents, staticSchemas: documents.staticSchemas.map(({ definition: _definition, ...entry }) => entry) };
  const direct = await render({ ...docs, resources: createMemoryResourceRepository([]) }, { template: single.template, mode: 'draft', ...item(single.dataset) });
  expect(direct.image).toBeDefined();
  const frozen = await freezeBatch({ workspace: docs, resources: store, request: { template: single.template, mode: 'final', items: [{ id: 'ok', ...item(single.dataset) }] } });
  expect(codes(frozen.problems)).toEqual(['record.invalid']);
}, 60_000);

it('CLI deliver：失败项的 problems.json 与单次渲染的问题清单相同', async () => {
  const resources = join(root, 'resources'), request = join(root, 'request.json'), out = join(root, 'batch');
  expect((await initializeResourceStore(resources)).problems).toEqual([]);
  const items = [{ id: 'no-dataset', ...item({ id: 'ds-missing' }) },
    { id: 'wrong-version', ...item({ inline: { dataset: { staticSchema: { name: '线路牌', version: 2 } }, data: {} } }) }];
  await fs.writeFile(request, JSON.stringify({ template: single.template, mode: 'final', items }));
  const io = { stdout: () => {}, stderr: () => {} };
  expect(await runCli(['deliver', '--workspace', m402Dir, '--resources', resources, '--request', request, '--out', out], io)).toBe(1);
  for (const [i, { id: _id, ...input }] of items.entries()) {
    const direct = await render({ ...documents, resources: createMemoryResourceRepository([]) }, { template: single.template, mode: 'final', ...input });
    const written = JSON.parse(await fs.readFile(join(out, String(i + 1).padStart(4, '0'), 'problems.json'), 'utf8'));
    expect(written).toEqual(direct.problems);
  }
}, 60_000);
