/** 从已应用的候选准备渲染项；模板、数据、资源固定后交给既有交付引擎。 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { loadWorkspaceDocuments, type DatasetDocument } from '../workspace.js';
import { withLocalAccess } from '../local-access.js';
import { openVersionedResourceStore } from '../versioned-resources.js';
import { describeTemplate } from '../template/describe.js';
import { measureRender, type RenderOptions } from '../render.js';
import { freezeBatch, runFrozenBatch, type BatchSnapshot, type BatchSummary, type BatchItemResult } from '../output-records.js';
import { createLocalBatchOutput } from '../record-stores.js';
import { createExclusiveDirectory, fileInfo, jsonBytes, recordRoot, writeDurableFiles, type RecordFile } from '../record-files.js';
import { rendererBuildId } from '../renderer-build.js';
import { parseBatchEnvelope, MAX_BATCH_ITEMS, type BatchRenderRequest } from '../record-input.js';
import type { RenderRequest } from '../request.js';
import type { Problem } from '../problems.js';
import { readReview, type ReviewView } from './review.js';
import { writeAtomicJson } from './execution.js';
import { AgentUsageError, sha256 } from './round-files.js';
import { canonical } from './diff.js';

export interface AgentOutputPlan {
  readonly format: 'renderweave-output-plan/1';
  readonly mode: 'draft' | 'final';
  readonly groups: readonly {
    readonly id: string; readonly template: string; readonly datasets: 'all' | readonly string[];
    readonly output: Omit<RenderRequest['output'], 'format'> & { readonly format: 'png' | 'jpg' | 'jpeg' }; readonly parameters?: Readonly<Record<string, unknown>>;
    readonly forEach?: { readonly path: string; readonly parameter: string; readonly indexBase: 0 | 1;
      readonly skip?: readonly { readonly index: number; readonly reason: string }[] };
  }[];
  readonly skipped?: readonly { readonly datasetId: string; readonly reason: string }[];
}
export interface OutputPosition { readonly groupId: string; readonly datasetId: string; readonly path?: string; readonly index?: number }
export interface PreparedAgentOutput {
  readonly format: 'renderweave-prepared-output/1'; readonly state: 'prepared'; readonly build: string; readonly mode: 'draft' | 'final';
  readonly source: { readonly roundDir: string; readonly appliedSha256: string; readonly commitId: string };
  readonly files: readonly RecordFile[];
  readonly batches: readonly { readonly groupId: string; readonly snapshot: string; readonly request: string }[];
  readonly items: readonly (OutputPosition & { readonly id: string })[];
  readonly skipped: readonly (Omit<OutputPosition, 'groupId'> & { readonly groupId?: string; readonly reason: string })[];
}
export interface AgentOutputDelivery {
  readonly format: 'renderweave-agent-delivery/1'; readonly state: 'delivered' | 'previewed' | 'incomplete'; readonly mode: 'draft' | 'final';
  readonly preparedSha256: string; readonly summary: BatchSummary; readonly skipped: PreparedAgentOutput['skipped'];
  readonly batches: readonly { readonly groupId: string; readonly directory: string; readonly summary: BatchSummary; readonly problems: readonly Problem[] }[];
}
const nonempty = { type: 'string', minLength: 1, maxLength: 1024 };
const validatePlan = new Ajv2020({ allErrors: true, strict: true }).compile({
  type: 'object', additionalProperties: false, required: ['format', 'mode', 'groups'], properties: {
    format: { const: 'renderweave-output-plan/1' }, mode: { enum: ['draft', 'final'] },
    skipped: { type: 'array', maxItems: MAX_BATCH_ITEMS, items: { type: 'object', additionalProperties: false, required: ['datasetId', 'reason'], properties: { datasetId: nonempty, reason: nonempty } } },
    groups: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id', 'template', 'datasets', 'output'], properties: {
      id: nonempty, template: nonempty, datasets: { anyOf: [{ const: 'all' }, { type: 'array', minItems: 1, maxItems: MAX_BATCH_ITEMS, uniqueItems: true, items: nonempty }] },
      output: { type: 'object', additionalProperties: false, required: ['width','height','dpi','format'], properties: { width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 }, dpi: { type: 'number', exclusiveMinimum: 0 }, format: { enum: ['png','jpeg','jpg'] } } },
      parameters: { type: 'object' }, forEach: { type: 'object', additionalProperties: false, required: ['path','parameter','indexBase'], properties: {
        path: nonempty, parameter: nonempty, indexBase: { enum: [0,1] },
        skip: { type: 'array', maxItems: MAX_BATCH_ITEMS, items: { type: 'object', additionalProperties: false, required: ['index','reason'], properties: { index: { type: 'integer', minimum: 0, maximum: MAX_BATCH_ITEMS-1 }, reason: nonempty } } },
      } },
    } } },
  },
});
const refuse = (message: string): never => { throw new AgentUsageError(message); };
const ensure = (problems: readonly Problem[], stage: string) => {
  if (problems.some(p => p.level === 'severe')) refuse(`${stage}：${problems.map(p => p.message).join('；')}`);
};
async function appliedReview(roundDir: string): Promise<ReviewView> {
  const read = await readReview(roundDir); ensure(read.problems, '应用依据不可读取');
  const view = read.view;
  if (!view || view.round.task !== 'dataset-extraction' || view.review.status !== 'approved' || !view.applied?.commitId) return refuse('必须先完整审核并应用数据集轮次');
  ensure(view.problems, '审核依据不合格');
  if (!view.candidates.length || view.candidates.some(c => c.kind !== 'dataset' || c.dropped || !c.document)) return refuse('应用的候选集合不完整');
  return view;
}
function atPointer(data: unknown, path: string): unknown {
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) return refuse('列表路径必须是以 / 开始的 JSON Pointer');
  let value: any = data;
  for (const key of path.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value,key)) return refuse(`列表路径不存在：${path}`);
    value = value[key];
  }
  return value;
}
function expandPlan(plan: AgentOutputPlan, datasets: readonly DatasetDocument[]) {
  const known = new Map(datasets.map(d=>[d.dataset.id!,d])), used = new Set<string>(), skipped = [...(plan.skipped ?? [])] as PreparedAgentOutput['skipped'][number][];
  const skippedIds = new Set<string>(), groupIds = new Set<string>();
  for (const skip of skipped) {
    if (!known.has(skip.datasetId) || skippedIds.has(skip.datasetId) || !skip.reason.trim()) refuse('跳过数据集不存在、重复或缺少理由');
    skippedIds.add(skip.datasetId);
  }
  const items: PreparedAgentOutput['items'][number][] = [];
  const batches: { groupId: string; request: BatchRenderRequest }[] = [];
  let positions = 0;
  for (const group of plan.groups) {
    if (groupIds.has(group.id)) refuse('出图分组 ID 重复'); groupIds.add(group.id);
    const ids = group.datasets === 'all' ? [...known.keys()].filter(id=>!skippedIds.has(id)) : group.datasets;
    const generated: BatchRenderRequest['items'][number][] = [];
    for (const id of ids) {
      const doc = known.get(id); if (!doc || skippedIds.has(id)) refuse(`数据集不属于本次应用或与跳过声明冲突：${id}`);
      used.add(id);
      const iteration = group.forEach, list = iteration ? atPointer(doc!.data, iteration.path) : [null];
      if (!Array.isArray(list) || !list.length) return refuse(`展开路径不是非空列表：${id} ${iteration?.path ?? ''}；无须出图请明确跳过数据集`);
      const omitted = new Map<number,string>();
      for (const skip of iteration?.skip ?? []) {
        if (skip.index >= list.length || omitted.has(skip.index) || !skip.reason.trim()) refuse('跳过位置越界、重复或缺少理由');
        omitted.set(skip.index,skip.reason);
      }
      if (iteration && Object.hasOwn(group.parameters ?? {}, iteration.parameter)) refuse('列表位置参数不能同时指定常量值');
      for (let index=0; index<list.length; index++) {
        if (++positions > MAX_BATCH_ITEMS) refuse(`展开范围超过 ${MAX_BATCH_ITEMS} 个位置，请拆分计划`);
        const position = { groupId: group.id, datasetId: id, ...(iteration ? { path: iteration.path, index } : {}) };
        const reason = omitted.get(index);
        if (reason !== undefined) { skipped.push({...position,reason}); continue; }
        const itemId = JSON.stringify([group.id,id,iteration ? index : null]);
        generated.push({ id: itemId, dataset: { id }, parameters: { ...group.parameters, ...(iteration ? { [iteration.parameter]: index+iteration.indexBase } : {}) },
          output: { ...group.output, format: group.output.format==='jpg' ? 'jpeg' : group.output.format } });
        items.push({...position,id:itemId});
      }
    }
    if (generated.length) batches.push({ groupId: group.id, request: { template: group.template, mode: plan.mode, items: generated } });
  }
  for (const id of known.keys()) if (!used.has(id) && !skippedIds.has(id)) refuse(`数据集未出图也未说明跳过：${id}`);
  if (!items.length) refuse('计划没有可执行渲染项');
  return { items, skipped, batches };
}

export async function prepareAgentOutput(options: { roundDir: string; resources: string; plan: unknown; outDir: string; renderOptions?: RenderOptions }): Promise<PreparedAgentOutput> {
  const planInput = structuredClone(options.plan);
  const renderOptions = structuredClone(options.renderOptions);
  if (!validatePlan(planInput)) refuse(`出图计划不合格：${JSON.stringify(validatePlan.errors)}`);
  const plan = planInput as AgentOutputPlan;
  const roundDir = await realpath(options.roundDir), resourcesDir = await realpath(options.resources);
  const initial = await appliedReview(roundDir), workspaceDir = initial.applied!.workspace;
  return withLocalAccess([roundDir, workspaceDir, resourcesDir], async () => {
    const review = await appliedReview(roundDir);
    if (review.applied!.workspace !== workspaceDir) refuse('应用目标在准备期间改变');
    const documents = await loadWorkspaceDocuments(workspaceDir), basis = await loadWorkspaceDocuments(join(roundDir,'snapshot'));
    ensure(documents.problems,'工作空间不可读取');
    for (const fixed of basis.staticSchemas) {
      const current = documents.staticSchemas.find(s=>canonical(s.ref)===canonical(fixed.ref));
      if (!current || canonical(current.definition)!==canonical(fixed.definition) || canonical(current.compiled)!==canonical(fixed.compiled)) refuse('已审核的数据定义发生变化，请重新审核提取结果');
    }
    const datasets = review.candidates.map(c=>c.document as DatasetDocument);
    for (const doc of datasets) {
      const current = documents.datasets.find(d=>d.id===doc.dataset.id);
      if (!current || canonical(current.document)!==canonical(doc)) refuse(`应用后数据集已改变：${doc.dataset.id}`);
    }
    const expanded = expandPlan(plan,datasets), opened = await openVersionedResourceStore(resourcesDir);
    ensure(opened.problems,'资源仓库不合格'); if (!opened.store) return refuse('交付必须使用版本资源仓库');
    const files = new Map<string,Uint8Array>([['plan.json',jsonBytes(plan)]]);
    const batches: PreparedAgentOutput['batches'][number][] = [];
    for (const [index,batch] of expanded.batches.entries()) {
      const described = describeTemplate(documents.templates.find(t=>t.name===batch.request.template)?.document);
      ensure(described.problems,'模板不合格');
      const iteration = plan.groups.find(g=>g.id===batch.groupId)!.forEach;
      if (iteration && !described.template?.parameters.some(p=>p.name===iteration.parameter && p.type==='number')) refuse('列表位置必须绑定模板的对外数值参数');
      const pinned = opened.store.pin(); ensure(pinned.problems,'资源版本不能固定');
      if (!pinned.repository) return refuse('固定资源不可读取');
      const workspace = {...documents,resources:pinned.repository};
      for (const item of batch.request.items) {
        const {id:_id,...request} = item;
        ensure(measureRender(workspace,{...request,template:batch.request.template,mode:plan.mode}).problems,`渲染项 ${item.id} 不合格`);
      }
      const frozen = await freezeBatch({ workspace: documents, resources: opened.store, request: batch.request, renderOptions });
      ensure(frozen.problems,'批次不能固定'); if (!frozen.snapshot || !frozen.contents) return refuse('批次快照缺失');
      for (const item of frozen.snapshot.items) ensure(item.problems,`渲染项 ${item.id} 不能固定`);
      const number = String(index+1).padStart(3,'0'), snapshot = `batch-${number}.json`, request = `request-${number}.json`;
      files.set(snapshot,jsonBytes(frozen.snapshot)); files.set(request,jsonBytes(batch.request));
      for (const info of frozen.snapshot.resources) files.set(`asset-${info.sha256}.bin`,frozen.contents.get(info.id)!);
      batches.push({ groupId: batch.groupId, snapshot, request });
    }
    if (files.size>2048 || [...files.values()].some(b=>b.length>128*1024*1024) || [...files.values()].reduce((sum,b)=>sum+b.length,0)>512*1024*1024) refuse('准备内容超过文件数量或字节上限，请拆分计划');
    const manifest: PreparedAgentOutput = { format:'renderweave-prepared-output/1',state:'prepared',build:await rendererBuildId(),mode:plan.mode,
      source:{roundDir,commitId:review.applied!.commitId!,appliedSha256:sha256(await readFile(join(roundDir,'applied.json')))},
      files:[...files].map(([file,bytes])=>fileInfo(file,bytes)),batches,items:expanded.items,skipped:expanded.skipped };
    const out = await createExclusiveDirectory(options.outDir); await writeDurableFiles(out,files);
    await writeAtomicJson(join(out,'prepared.json'),manifest,true);
    return manifest;
  });
}

/** 读入完整副本并核对后才创建输出；交付期间不回读可变模板或当前资源版本。 */
export async function deliverAgentOutput(options: { preparedDir: string; outDir: string; signal?: AbortSignal;
  onItem?: (item: BatchItemResult, position: OutputPosition) => void | Promise<void> }): Promise<AgentOutputDelivery> {
  const root = await recordRoot(options.preparedDir);
  const read = async (file: string) => {
    if (!/^(prepared\.json|plan\.json|(?:batch|request)-\d{3}\.json|asset-[0-9a-f]{64}\.bin)$/.test(file)) return refuse('准备目录含非法文件路径');
    const path = join(root,file), stat = await lstat(path);
    if (!stat.isFile() || stat.size > 128*1024*1024 || await realpath(path)!==path) return refuse(`准备文件不是受控普通文件或过大：${file}`);
    return readFile(path);
  };
  const manifestBytes = await read('prepared.json'), manifest = JSON.parse(manifestBytes.toString('utf8')) as PreparedAgentOutput;
  if (manifest.format!=='renderweave-prepared-output/1' || manifest.state!=='prepared' || !Array.isArray(manifest.files) || !Array.isArray(manifest.batches)
      || manifest.files.length>2048 || manifest.batches.length<1 || manifest.batches.length>20 || !Array.isArray(manifest.items) || manifest.items.length>MAX_BATCH_ITEMS || !Array.isArray(manifest.skipped)) refuse('准备清单不完整');
  if (manifest.build!==await rendererBuildId()) refuse('引擎构建已改变，请重新准备出图');
  const files = new Map<string,Buffer>(); let total = 0;
  for (const file of manifest.files) {
    if (file.file==='prepared.json' || files.has(file.file)) refuse('准备清单含重复或自身引用');
    const bytes = await read(file.file); total += bytes.length;
    if (total>512*1024*1024 || bytes.length!==file.byteLength || sha256(bytes)!==file.sha256) refuse(`准备文件内容不匹配或总量超限：${file.file}`);
    files.set(file.file,bytes);
  }
  const snapshots = manifest.batches.map(batch=>JSON.parse(files.get(batch.snapshot)!.toString('utf8')) as BatchSnapshot);
  const ids: string[] = [];
  for (const [index,snapshot] of snapshots.entries()) {
    if (snapshot.format!=='renderweave-batch-snapshot/1' || snapshot.build!==manifest.build || snapshot.envelope.mode!==manifest.mode) refuse('固定批次身份不一致');
    const envelope = parseBatchEnvelope(snapshot.envelope), request = JSON.parse(files.get(manifest.batches[index]!.request)!.toString('utf8'));
    if (canonical(envelope)!==canonical(request) || snapshot.items.length!==envelope.items.length) refuse('批次请求与快照不一致');
    ids.push(...envelope.items.map(i=>i.id));
    for (const resource of snapshot.resources) {
      const bytes = files.get(`asset-${resource.sha256}.bin`);
      if (!bytes || sha256(bytes)!==resource.sha256 || bytes.length!==resource.byteLength) refuse('固定资源内容不一致');
    }
  }
  if (new Set(ids).size!==ids.length || canonical(ids)!==canonical(manifest.items.map(i=>i.id))) refuse('渲染项集合不完整');
  await withLocalAccess([manifest.source.roundDir], async()=>{
    const review = await appliedReview(manifest.source.roundDir);
    if (review.applied!.commitId!==manifest.source.commitId || sha256(await readFile(join(manifest.source.roundDir,'applied.json')))!==manifest.source.appliedSha256) refuse('原审核应用依据发生变化');
    const plan = JSON.parse(files.get('plan.json')!.toString('utf8'));
    if (!validatePlan(plan) || plan.mode!==manifest.mode) refuse('固定出图计划不合格');
    const datasets = review.candidates.map(c=>c.document as DatasetDocument), expected = expandPlan(plan,datasets);
    if (canonical(expected.items)!==canonical(manifest.items) || canonical(expected.skipped)!==canonical(manifest.skipped)
        || expected.batches.length!==snapshots.length) refuse('计划范围与固定渲染项不一致');
    const basis = await loadWorkspaceDocuments(join(manifest.source.roundDir,'snapshot'));
    for (const [index,snapshot] of snapshots.entries()) {
      if (expected.batches[index]!.groupId!==manifest.batches[index]!.groupId || canonical(expected.batches[index]!.request)!==canonical(snapshot.envelope)) refuse('计划与固定批次请求不一致');
      for (const doc of datasets) {
        if (canonical(snapshot.documents.datasets.find(d=>d.id===doc.dataset.id)?.document)!==canonical(doc)) refuse('固定数据与已审核应用的候选不一致');
      }
      for (const fixed of basis.staticSchemas) {
        const saved = snapshot.documents.staticSchemas.find(s=>canonical(s.ref)===canonical(fixed.ref));
        if (!saved || canonical(saved.definition)!==canonical(fixed.definition) || canonical(saved.compiled)!==canonical(fixed.compiled)) refuse('固定数据定义与审核依据不一致');
      }
    }
  });
  const out = await createExclusiveDirectory(options.outDir);
  await writeDurableFiles(out,new Map([['prepared.json',manifestBytes]]));
  const batches: AgentOutputDelivery['batches'][number][] = [];
  const summary: BatchSummary = {total:0,delivered:0,previewed:0,failed:0,notRun:0,severe:0,hints:0};
  for (const [index,snapshot] of snapshots.entries()) {
    const directory = String(index+1).padStart(4,'0'), batch = manifest.batches[index]!;
    const output = await createLocalBatchOutput(join(out,directory));
    const result = await runFrozenBatch({snapshot,output,contents:async info=>files.get(`asset-${info.sha256}.bin`)!,signal:options.signal,
      onItem:options.onItem ? item=>options.onItem!(item,manifest.items.find(i=>i.id===item.id)!) : undefined});
    for (const key of Object.keys(summary) as (keyof BatchSummary)[]) (summary as any)[key] += result.summary[key];
    batches.push({groupId:batch.groupId,directory,summary:result.summary,problems:result.problems});
  }
  const complete = summary.total===manifest.items.length && !summary.failed && !summary.notRun && batches.every(b=>!b.problems.some(p=>p.level==='severe'));
  const result: AgentOutputDelivery = {format:'renderweave-agent-delivery/1',state:complete ? manifest.mode==='final' ? 'delivered':'previewed' : 'incomplete',mode:manifest.mode,
    preparedSha256:sha256(manifestBytes),summary,skipped:manifest.skipped,batches};
  await writeAtomicJson(join(out,'delivery.json'),result,true);
  return result;
}
