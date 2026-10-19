/**
 * 代建推送的命令行一侧（票据 05，M264）：把本地工作区与资源版本仓库推送到出图服务上的一个租户。
 * 命令行只是客户端：列出本地文档与资源内容版本的身份和 SHA-256，交给服务算差异，上传服务缺少的内容，
 * 再请服务在一个事务里提交。新增、更新、冲突由服务按它的当前状态判定。
 * 代建令牌由调用方从环境变量取得，只放进请求头，不写进任何输出。
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Problem } from './problems.js';
import { describeError } from './util.js';
import { openVersionedResourceStore } from './versioned-resources.js';
import { classifyWorkspaceDocument, localWorkspaceDocuments, memoryWorkspaceDocuments, parseJsonKeepingPrecision, readWorkspaceDocuments } from './workspace.js';

/** 代建令牌所在的环境变量，缺省名称。 */
export const DEFAULT_TOKEN_ENV = 'RENDERWEAVE_AUTHORING_TOKEN';

export type PushDocumentKind = 'definition' | 'compiled' | 'template' | 'dataset';

/** 推送清单：每份文档与每个资源内容版本的身份、SHA-256 与字节数。内容另行上传。 */
export interface PushManifest {
  readonly documents: readonly { readonly kind: PushDocumentKind; readonly key: string; readonly sha256: string; readonly byteLength: number }[];
  readonly resources: readonly {
    readonly id: string;
    readonly kind: 'image' | 'font';
    readonly versions: readonly { readonly version: number; readonly sha256: string; readonly byteLength: number }[];
  }[];
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
}

export interface PushTarget {
  /** 出图服务的地址，如 http://127.0.0.1:8080。 */
  readonly server: string;
  readonly tenant: string;
  readonly token: string;
}

export interface PushOutcome {
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

class Unreachable extends Error {}

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
export async function pushWorkspace(options: PushTarget & { readonly workspace: string; readonly resources: string; readonly dryRun: boolean }): Promise<PushOutcome> {
  const local = await collect(options.workspace, options.resources);
  if (!local.manifest) return { pushed: false, skipped: local.skipped, problems: local.problems };
  try {
    const plan = await call(options, 'POST', '/push-plans', local.manifest);
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
    const commit = await call(options, 'POST', '/pushes', local.manifest);
    if (commit.status === 200) return { diff: commit.body as PushDiff, pushed: true, skipped: local.skipped, problems: [] };
    return { ...(commit.body?.diff ? { diff: commit.body.diff as PushDiff } : {}), pushed: false, skipped: local.skipped, problems: answerProblems(commit) };
  } catch (error) {
    return { pushed: false, skipped: local.skipped, problems: unreachable(error) };
  }
}

/** 服务端一个模板的修订：当前修订与全部修订。 */
export interface TemplateRevisions {
  readonly name: string;
  readonly currentRevision: number;
  readonly revisions: readonly { readonly revision: number; readonly sha256: string; readonly byteLength: number; readonly createdAt: string; readonly pushedBy: string }[];
}

/** 列出服务端一个模板的修订；给了 current 时先把当前修订指向它。 */
export async function templateRevisions(options: PushTarget & { readonly template: string; readonly current?: number }): Promise<{ template?: TemplateRevisions; problems: readonly ReportedProblem[] }> {
  try {
    if (options.current !== undefined) {
      const reply = await call(options, 'POST', '/template-current', { template: options.template, revision: options.current });
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
