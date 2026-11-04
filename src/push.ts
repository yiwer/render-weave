/**
 * 代建推送的命令行一侧（票据 05，M264）：把本地工作区与资源版本仓库推送到出图服务上的一个租户。
 * 命令行只是客户端：列出本地文档与资源内容版本的身份和 SHA-256，交给服务算差异，上传服务缺少的内容，
 * 再请服务在一个事务里提交。新增、更新、冲突由服务按它的当前状态判定。
 * 可以附带代建的轮次目录（票据 09）：各轮 round.json 里的 token 用量随清单交给服务，与推送同一事务记到该租户名下，只记不拦。
 * 代建令牌由调用方从环境变量取得，只放进请求头，不写进任何输出。
 *
 * 拉取（P1 票据 10，M348）把租户当前的模板、静态数据定义与编译产物写回本地工作区；本地已有而内容不同的先列出，overwrite 才覆盖。
 * 推送或拉取成功后在工作区的 .renderweave 目录记下各模板的修订号，下次推送带上，服务据此发现客户在网页上的改动。
 * 这份记录按租户分开，不是工作区文档：读工作区只看工作区这一层的 .json 文件，所以读工作区与渲染都看不到它。
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ProblemCodes, type Problem } from './problems.js';
import { describeError } from './util.js';
import { openVersionedResourceStore } from './versioned-resources.js';
import {
  classifyWorkspaceDocument, localWorkspaceDocuments, memoryWorkspaceDocuments, parseJsonKeepingPrecision, readWorkspaceDocuments, formatSchemaVersion, parseSchemaVersion,
} from './workspace.js';

/** 代建令牌所在的环境变量，缺省名称。 */
export const DEFAULT_TOKEN_ENV = 'RENDERWEAVE_AUTHORING_TOKEN';

export type PushDocumentKind = 'definition' | 'compiled' | 'template' | 'dataset';

/** round.json 里的四种 token（RoundUsage）。 */
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;
type TokenField = (typeof TOKEN_FIELDS)[number];

/** 一轮代建的 token 用量：round.json 的 SHA-256 是这一轮的身份，同一轮在一个租户只记一次。 */
export type PushRound = { readonly sha256: string; readonly task: string; readonly round: number } & Readonly<Partial<Record<TokenField, number>>>;

/** 推送清单：每份文档与每个资源内容版本的身份、SHA-256 与字节数。内容另行上传。可以附带代建轮次的 token 用量。 */
export interface PushManifest {
  readonly documents: readonly { readonly kind: PushDocumentKind; readonly key: string; readonly sha256: string; readonly byteLength: number; readonly baseRevision?: number }[];
  readonly resources: readonly {
    readonly id: string;
    readonly kind: 'image' | 'font';
    readonly versions: readonly { readonly version: number; readonly sha256: string; readonly byteLength: number }[];
  }[];
  readonly rounds?: readonly PushRound[];
}

/** 引擎的问题，或服务回答的问题；两者格式一致（问题码、等级、位置、说明）。 */
export interface ReportedProblem {
  readonly level: string;
  readonly code: string;
  readonly location: object;
  readonly message: string;
}

/** 服务给出的差异（服务端 push.ts 的 PushDiff）；命令行只展示，不解释。 */
export interface PushDiff {
  readonly summary: { readonly added: number; readonly updated: number; readonly unchanged: number; readonly conflicts: number };
  readonly documents: readonly { readonly kind: PushDocumentKind; readonly key: string; readonly status: string; readonly reason?: string; readonly currentRevision?: number; readonly revision?: number }[];
  readonly resources: readonly { readonly id: string; readonly kind: string; readonly status: string; readonly reason?: string; readonly localVersion: number; readonly serverVersion?: number }[];
  readonly uploads?: readonly string[];
  readonly pushId?: string;
  /** 只列差异时：写入碰到了打开审批策略的范围，提交会变成发布申请（P1 票据 11）。 */
  readonly approvalScopes?: readonly string[];
  /** 提交后：附了几轮、这次新记了几轮（其余已记过），以及新记的 token 合计。 */
  readonly usage?: { readonly rounds: number; readonly recorded: number; readonly tokens: Readonly<Record<TokenField, number>> };
}

export interface PushTarget {
  /** 出图服务的地址，如 http://127.0.0.1:8080。 */
  readonly server: string;
  readonly tenant: string;
  readonly token: string;
}

/** 推送变成的发布申请（P1 票据 11）。 */
export interface PushedRequest {
  readonly id: string;
  readonly status: string;
  readonly scopes: readonly string[];
}

export interface PushOutcome {
  /** 租户打开了审批策略：这次推送没有生效，成了一份待批准的发布申请。 */
  readonly request?: PushedRequest;
  /** 服务给出的差异；本地有严重问题、连不上服务或请求被拒绝时可能没有。 */
  readonly diff?: PushDiff;
  readonly pushed: boolean;
  /** 工作区里不属于推送内容的 JSON 文件（如渲染请求）。 */
  readonly skipped: readonly string[];
  readonly problems: readonly ReportedProblem[];
}

/** 本地要推送的内容：清单，以及按 SHA-256 取字节的方法（资源内容按需读取并核对完整性）。 */
interface LocalPush {
  readonly manifest?: PushManifest;
  readonly contents: ReadonlyMap<string, () => Promise<Uint8Array>>;
  readonly skipped: readonly string[];
  readonly problems: readonly Problem[];
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** 读出本地工作区与资源版本仓库。工作区有严重问题、资源目录不是版本仓库（M239）时不推送。 */
async function collect(workspaceDir: string, resourcesDir: string): Promise<LocalPush> {
  const contents = new Map<string, () => Promise<Uint8Array>>();
  const source = localWorkspaceDocuments(workspaceDir);
  const loaded: { source: string; bytes: Uint8Array }[] = [];
  try {
    for (const entry of await source.list()) loaded.push({ source: entry.source, bytes: await entry.read() });
  } catch {
    // 列不出或读不到时，按引擎读取工作区的同一套规则报问题。
    return { contents, skipped: [], problems: (await readWorkspaceDocuments(source)).problems };
  }
  const workspace = await readWorkspaceDocuments(memoryWorkspaceDocuments(loaded, workspaceDir));
  if (workspace.problems.some((problem) => problem.level === 'severe')) return { contents, skipped: [], problems: workspace.problems };

  const documents: PushManifest['documents'][number][] = [];
  const skipped: string[] = [];
  for (const { source: file, bytes } of loaded) {
    const found = classifyWorkspaceDocument(parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), []));
    if (found.kind === 'other' || found.kind === 'invalid') {
      skipped.push(basename(file));
      continue;
    }
    const hash = sha256(bytes);
    documents.push({ kind: found.kind, key: found.key, sha256: hash, byteLength: bytes.length });
    contents.set(hash, async () => bytes);
  }

  const opened = await openVersionedResourceStore(resourcesDir);
  if (!opened.store) return { contents, skipped, problems: opened.problems };
  const store = opened.store;
  const resources = store.list().map((current) => {
    const versions = [];
    for (let version = 1; version <= current.version; version++) {
      const info = store.get(current.id, version)!;
      versions.push({ version, sha256: info.sha256, byteLength: info.byteLength });
      contents.set(info.sha256, () => store.read(current.id, version));
    }
    return { id: current.id, kind: current.kind, versions };
  });
  return { manifest: { documents, resources }, contents, skipped, problems: workspace.problems };
}

const roundProblem = (source: string, message: string): Problem =>
  ({ level: 'severe', code: ProblemCodes.inputUnreadable, location: { kind: 'input', source }, message } as Problem);

/**
 * 读出要附带的代建轮次：给的目录本身是一轮（有 round.json），或它下面一层的各个子目录各是一轮。
 * round.json 要是 renderweave-round/1 轮次记录；token 缺了按 0 计。读不到或不是轮次记录时报问题，整次推送不进行。
 */
export async function readRounds(dir: string): Promise<{ rounds: PushRound[]; problems: Problem[] }> {
  const isFile = async (path: string) => (await stat(path).catch(() => undefined))?.isFile() ?? false;
  let dirs: string[];
  if (await isFile(join(dir, 'round.json'))) dirs = [dir];
  else {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { return { rounds: [], problems: [roundProblem(dir, `轮次目录无法读取：${describeError(error)}`)] }; }
    dirs = [];
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (await isFile(join(dir, entry.name, 'round.json'))) dirs.push(join(dir, entry.name));
    }
    if (!dirs.length) return { rounds: [], problems: [roundProblem(dir, '目录里没有轮次：既没有 round.json，下一层的子目录里也没有')] };
  }
  const rounds: PushRound[] = [], problems: Problem[] = [];
  for (const roundDir of dirs) {
    const file = join(roundDir, 'round.json');
    let bytes: Buffer, record: any;
    try {
      bytes = await readFile(file);
      record = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      problems.push(roundProblem(file, `round.json 无法读取：${describeError(error)}`));
      continue;
    }
    const counts = TOKEN_FIELDS.filter((field) => record?.run?.[field] !== undefined);
    if (record?.format !== 'renderweave-round/1' || typeof record.task !== 'string' || !Number.isSafeInteger(record.round) || record.round < 1 ||
      counts.some((field) => !Number.isSafeInteger(record.run[field]) || record.run[field] < 0)) {
      problems.push(roundProblem(file, 'round.json 不是 renderweave-round/1 轮次记录，或 token 用量不是非负整数'));
      continue;
    }
    rounds.push({ sha256: sha256(bytes), task: record.task, round: record.round, ...Object.fromEntries(counts.map((field) => [field, record.run[field]])) });
  }
  return { rounds, problems };
}

class Unreachable extends Error {}

/** 取字节的回答：内容不是 JSON；失败时 body 是解析出的问题清单。 */
async function callBytes(target: PushTarget, path: string): Promise<{ status: number; bytes: Uint8Array; body: any }> {
  const url = `${target.server.replace(/\/+$/, '')}/v1/authoring/tenants/${encodeURIComponent(target.tenant)}${path}`;
  let response: Response;
  try { response = await fetch(url, { headers: { authorization: `Bearer ${target.token}` } }); }
  catch (error) { throw new Unreachable(`无法连接出图服务 ${target.server}：${describeError(error)}`); }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status === 200) return { status: 200, bytes, body: undefined };
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { parsed = undefined; }
  return { status: response.status, bytes, body: parsed };
}

/** 调用出图服务。连不上时抛 Unreachable；回答不是 JSON 时 body 为 undefined。 */
async function call(target: PushTarget, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = `${target.server.replace(/\/+$/, '')}/v1/authoring/tenants/${encodeURIComponent(target.tenant)}${path}`;
  const binary = body instanceof Uint8Array;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${target.token}`, ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }) },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Unreachable(`无法连接出图服务 ${target.server}：${describeError(error)}`);
  }
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, body: parsed };
}

/** 服务的回答不合预期时，转成一个问题；回答带问题清单时原样返回。 */
function answerProblems(reply: { status: number; body: any }): ReportedProblem[] {
  if (Array.isArray(reply.body?.problems) && reply.body.problems.length) return reply.body.problems;
  return [{ level: 'severe', code: 'service.unexpectedResponse', location: { kind: 'input', source: 'response' }, message: `出图服务回答 HTTP ${reply.status}，没有问题清单` }];
}

const unreachable = (error: unknown): ReportedProblem[] => {
  if (!(error instanceof Unreachable)) throw error;
  return [{ level: 'severe', code: 'service.unreachable', location: { kind: 'input', source: 'server' }, message: error.message }];
};

/**
 * 推送：先请服务算差异；只看差异时到此为止。否则上传服务缺少的内容，再请服务提交。
 * 有冲突时不上传内容，仍交给服务判定：服务整体拒绝，保持原样，并记审计。
 */
export async function pushWorkspace(options: PushTarget & { readonly workspace: string; readonly resources: string; readonly dryRun: boolean; readonly rounds?: string }): Promise<PushOutcome> {
  const local = await collect(options.workspace, options.resources);
  if (!local.manifest) return { pushed: false, skipped: local.skipped, problems: local.problems };
  const recorded = await readRevisionRecord(options.workspace, options.tenant);
  let manifest: PushManifest = {
    ...local.manifest,
    documents: local.manifest.documents.map((document) => {
      const baseRevision = document.kind === 'template' ? recorded[document.key] : undefined;
      return baseRevision === undefined ? document : { ...document, baseRevision };
    }),
  };
  if (options.rounds !== undefined) {
    const read = await readRounds(options.rounds);
    if (read.problems.length) return { pushed: false, skipped: local.skipped, problems: read.problems };
    manifest = { ...manifest, rounds: read.rounds };
  }
  try {
    const plan = await call(options, 'POST', '/push-plans', manifest);
    if (plan.status !== 200) return { pushed: false, skipped: local.skipped, problems: answerProblems(plan) };
    const planned = plan.body as PushDiff;
    if (options.dryRun) return { diff: planned, pushed: false, skipped: local.skipped, problems: [] };
    if (planned.summary.conflicts === 0) {
      for (const hash of planned.uploads ?? []) {
        const read = local.contents.get(hash);
        if (!read) continue;
        const uploaded = await call(options, 'PUT', `/contents/${hash}`, await read());
        if (uploaded.status !== 204) return { diff: planned, pushed: false, skipped: local.skipped, problems: answerProblems(uploaded) };
      }
    }
    const commit = await call(options, 'POST', '/pushes', manifest);
    // 整份推送变成了发布申请：服务端还没有新修订，本地记录不动；批准后 pull 取回。
    if (commit.status === 202) return { diff: commit.body as PushDiff, pushed: false, request: (commit.body as { request: PushedRequest }).request, skipped: local.skipped, problems: [] };
    if (commit.status === 200) {
      const pushed = commit.body as PushDiff;
      await recordRevisions(options.workspace, options.tenant, Object.fromEntries(pushed.documents.flatMap((document) => {
        const revision = document.kind === 'template' ? document.revision ?? document.currentRevision : undefined;
        return revision === undefined ? [] : [[document.key, revision]];
      })));
      return { diff: pushed, pushed: true, skipped: local.skipped, problems: [] };
    }
    return { ...(commit.body?.diff ? { diff: commit.body.diff as PushDiff } : {}), pushed: false, skipped: local.skipped, problems: answerProblems(commit) };
  } catch (error) {
    return { pushed: false, skipped: local.skipped, problems: unreachable(error) };
  }
}

/** 本地记下的各模板修订号：工作区的 .renderweave 目录下，按租户一个文件。不是工作区文档。 */
const recordFile = (workspace: string, tenant: string) => join(workspace, '.renderweave', `template-revisions-${tenant.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

/** 读不到或读不了时当作没记过：推送不带基于的修订，由服务按当前修订的来源判定。 */
async function readRevisionRecord(workspace: string, tenant: string): Promise<Readonly<Record<string, number>>> {
  try {
    const record = JSON.parse(await readFile(recordFile(workspace, tenant), 'utf8'));
    return record?.format === 'renderweave-template-revisions/1' ? record.templates as Record<string, number> : {};
  } catch { return {}; }
}

/** 合并进本地记录；写临时文件再改名，中途退出不会留下半份。 */
async function recordRevisions(workspace: string, tenant: string, revisions: Readonly<Record<string, number>>): Promise<void> {
  const file = recordFile(workspace, tenant);
  await mkdir(join(workspace, '.renderweave'), { recursive: true });
  const record = { format: 'renderweave-template-revisions/1', tenant, templates: { ...await readRevisionRecord(workspace, tenant), ...revisions } };
  await writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

export interface PullOutcome {
  /** 写进工作区的文件：新建的与覆盖的。 */
  readonly written: readonly string[];
  readonly unchanged: number;
  /** 本地已有而内容不同的文件；没有 overwrite 时一个文件也不写。 */
  readonly conflicts: readonly { readonly kind: PushDocumentKind; readonly key: string; readonly file: string }[];
  readonly pulled: boolean;
  readonly problems: readonly ReportedProblem[];
}

/** 新文件的文件名，沿用工作区的写法；键里 Windows 不能用的字符换成下划线。 */
function pulledFileName(kind: PushDocumentKind, key: string): string {
  const safe = (text: string) => text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  if (kind === 'template') return `template-${safe(key)}.json`;
  const at = key.lastIndexOf('@'), stem = safe(key.slice(0, at)), written = key.slice(at + 1), version = formatSchemaVersion(parseSchemaVersion(written) ?? written);
  return kind === 'definition' ? `schema-${stem}-${version}.json` : `compiled-${stem}-${version}.schema.json`;
}

/**
 * 拉取：读服务端的当前状态，把模板（当前修订）、静态数据定义与编译产物写回工作区。按身份找本地已有的文件，不看文件名。
 * 字节相同不动；不同的先列出，overwrite 才覆盖，否则一个文件也不写。成功后记下各模板的修订号。数据集与资源不拉：客户的数据不进代建工程师的本地。
 */
export async function pullWorkspace(options: PushTarget & { readonly workspace: string; readonly overwrite: boolean }): Promise<PullOutcome> {
  const failed = (problems: readonly ReportedProblem[]): PullOutcome => ({ written: [], unchanged: 0, conflicts: [], pulled: false, problems });
  try {
    const state = await call(options, 'GET', '/workspace');
    if (state.status !== 200) return failed(answerProblems(state));
    const remote = (state.body.documents as { kind: PushDocumentKind; key: string; sha256: string }[]).filter((document) => document.kind !== 'dataset');

    await mkdir(options.workspace, { recursive: true });
    const existing = new Map<string, { file: string; sha256: string }>();
    const source = localWorkspaceDocuments(options.workspace);
    for (const entry of await source.list()) {
      let bytes: Uint8Array, found: ReturnType<typeof classifyWorkspaceDocument>;
      try {
        bytes = await entry.read();
        found = classifyWorkspaceDocument(parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), []));
      } catch { continue; }
      if (found.kind === 'definition' || found.kind === 'compiled' || found.kind === 'template') existing.set(`${found.kind}:${found.key}`, { file: entry.source, sha256: sha256(bytes) });
    }

    const conflicts: { kind: PushDocumentKind; key: string; file: string }[] = [], writes: { file: string; hash: string }[] = [];
    let unchanged = 0;
    for (const document of remote) {
      const local = existing.get(`${document.kind}:${document.key}`);
      if (local?.sha256 === document.sha256) { unchanged++; continue; }
      if (local) conflicts.push({ kind: document.kind, key: document.key, file: local.file });
      writes.push({ file: local?.file ?? join(options.workspace, pulledFileName(document.kind, document.key)), hash: document.sha256 });
    }
    if (conflicts.length && !options.overwrite) return { written: [], unchanged, conflicts, pulled: false, problems: [] };

    const contents = new Map<string, Uint8Array>();
    for (const { hash } of writes) {
      if (contents.has(hash)) continue;
      const read = await callBytes(options, `/contents/${hash}`);
      if (read.status !== 200) return { written: [], unchanged, conflicts, pulled: false, problems: answerProblems({ status: read.status, body: read.body }) };
      contents.set(hash, read.bytes);
    }
    for (const { file, hash } of writes) {
      await writeFile(`${file}.tmp`, contents.get(hash)!);
      await rename(`${file}.tmp`, file);
    }
    const templates = state.body.templates as { name: string; currentRevision: number }[];
    await recordRevisions(options.workspace, options.tenant, Object.fromEntries(templates.map((template) => [template.name, template.currentRevision])));
    return { written: writes.map((item) => item.file), unchanged, conflicts, pulled: true, problems: [] };
  } catch (error) {
    if (error instanceof Unreachable) return failed(unreachable(error));
    return failed([{ level: 'severe', code: ProblemCodes.inputUnreadable, location: { kind: 'input', source: options.workspace }, message: `工作区无法读写：${describeError(error)}` }]);
  }
}

/** 服务端一个模板的修订：当前修订与全部修订。 */
export interface TemplateRevisions {
  readonly name: string;
  readonly currentRevision: number;
  readonly revisions: readonly { readonly revision: number; readonly sha256: string; readonly byteLength: number; readonly createdAt: string; readonly pushedBy: string }[];
}

/** 列出服务端一个模板的修订；给了 current 时先把当前修订指向它。 */
export async function templateRevisions(options: PushTarget & { readonly template: string; readonly current?: number }): Promise<{ template?: TemplateRevisions; request?: PushedRequest; problems: readonly ReportedProblem[] }> {
  try {
    if (options.current !== undefined) {
      const reply = await call(options, 'POST', '/template-current', { template: options.template, revision: options.current });
      // 租户打开了审批策略：这次指回没有生效，成了一份发布申请（P1 票据 11）。
      if (reply.status === 202) return { request: (reply.body as { request: PushedRequest }).request, problems: [] };
      return reply.status === 200 ? { template: reply.body as TemplateRevisions, problems: [] } : { problems: answerProblems(reply) };
    }
    const reply = await call(options, 'GET', '/workspace');
    if (reply.status !== 200) return { problems: answerProblems(reply) };
    const template = (reply.body.templates as TemplateRevisions[]).find((item) => item.name === options.template);
    if (template) return { template, problems: [] };
    return { problems: [{ level: 'severe', code: 'request.notFound', location: { kind: 'input', source: 'template' }, message: `租户里没有模板 ${options.template}` }] };
  } catch (error) {
    return { problems: unreachable(error) };
  }
}
