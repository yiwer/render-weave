/** 代建检查的内容身份与本轮资源副本；不承担工作区事务（ADR-0023）。 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { openResourceRepository, type ResourceRepository, type ResourceKind } from '../resources.js';
import { openVersionedResourceStore } from '../versioned-resources.js';
import { rendererBuildId } from '../renderer-build.js';
import type { Workspace } from '../workspace.js';
import { canonical } from './diff.js';
import { sha256 } from './round-files.js';

export interface ResourceIdentity {
  readonly id: string; readonly kind: ResourceKind; readonly sha256: string | null; readonly byteLength: number | null;
  readonly version?: number; readonly file?: string;
}
export interface ResourceSnapshotRef { readonly directory: string; readonly sha256: string }
export interface ResourceSnapshot { readonly format: 'renderweave-agent-resources/1'; readonly resources: readonly ResourceIdentity[] }
export interface ContentIdentity {
  readonly format: 'renderweave-content-identity/1'; readonly id: string; readonly engine: string; readonly criteria: 'authoring-check/1';
  readonly candidates: unknown; readonly workspace: string; readonly request: string; readonly reference: string;
  readonly resources: readonly ResourceIdentity[];
}
let build: Promise<string> | undefined;
const digest = (value: unknown) => sha256(canonical(value));

/** 固定目录只由宿主写入；每次重新检查另建目录，旧检查的字节一直可复查。 */
export async function captureResources(roundDir: string, source: string): Promise<ResourceSnapshotRef> {
  const { repository, problems } = await openResourceRepository(source);
  if (problems.some(p => p.level === 'severe')) throw new Error(problems.map(p => p.message).join('；'));
  const manifest = JSON.parse(await readFile(join(source, 'resources.json'), 'utf8'));
  const store = manifest.format ? (await openVersionedResourceStore(source)).store : undefined;
  const directory = `resources/${randomUUID()}`;
  await mkdir(join(roundDir, directory), { recursive: true });
  const resources: ResourceIdentity[] = [], files: unknown[] = [];
  for (const resource of repository.list()) {
    const info = store?.get(resource.id);
    const file = `${resource.id}.bin`;
    let bytes: Uint8Array | undefined;
    try { bytes = await repository.read(resource.id); } catch { /* 未使用的缺失资源不阻止任务；实际读取时明确报错。 */ }
    const identity: ResourceIdentity = { ...resource, sha256: bytes ? sha256(bytes) : null, byteLength: bytes?.length ?? null,
      ...(info ? { version: info.version } : { file: manifest.resources.find((entry: { id: string }) => entry.id === resource.id)?.file }) };
    resources.push(identity);
    files.push({ ...resource, file, ...(bytes ? { sha256: identity.sha256, byteLength: bytes.length } : {}) });
    if (bytes) await writeFile(join(roundDir, directory, file), bytes, { flag: 'wx' });
  }
  const snapshot: ResourceSnapshot = { format: 'renderweave-agent-resources/1', resources };
  const text = JSON.stringify(snapshot);
  await writeFile(join(roundDir, directory, 'identity.json'), text, { flag: 'wx' });
  await writeFile(join(roundDir, directory, 'resources.json'), JSON.stringify({ resources: files }), { flag: 'wx' });
  return { directory, sha256: sha256(text) };
}

export async function readResourceSnapshot(roundDir: string, ref: ResourceSnapshotRef): Promise<ResourceSnapshot> {
  if (!/^resources\/[a-z0-9-]+$/.test(ref.directory)) throw new Error('固定资源目录不合法');
  const bytes = await readFile(join(roundDir, ref.directory, 'identity.json'));
  if (sha256(bytes) !== ref.sha256) throw new Error('固定资源身份清单已损坏');
  return JSON.parse(bytes.toString('utf8')) as ResourceSnapshot;
}

/** 每次计算只计实际读取的资源，间接后备与 SVG 字体也经同一资源入口。 */
export function trackResources(repository: ResourceRepository, known: readonly ResourceIdentity[] = []) {
  const used = new Map<string, ResourceIdentity>(), errors: Problem[] = [];
  const reads = new Map<string, Promise<Uint8Array>>();
  const wrapped: ResourceRepository = {
    get(id) {
      const info = repository.get(id), saved = known.find(item => item.id === id);
      // 不存在的后备字体也影响选择；以后新增它不能沿用旧批准。
      if (!info) used.set(id, saved ?? { id, kind: 'font', sha256: null, byteLength: null });
      if (saved && ((saved.sha256 !== null && !info) || (info && info.kind !== saved.kind))) errors.push(severe(ProblemCodes.resourceUnreadable,
        { kind: 'input', source: `res:${id}` }, `固定资源 ${id} 的清单映射或种类与记录不符`));
      return info;
    }, list: () => repository.list(),
    read(id) {
      let pending = reads.get(id);
      if (!pending) {
        pending = (async () => {
          const saved = known.find(item => item.id === id), info = repository.get(id);
          try {
            const bytes = Uint8Array.from(await repository.read(id));
            const hash = sha256(bytes);
            if (saved && (hash !== saved.sha256 || bytes.length !== saved.byteLength || info?.kind !== saved.kind)) throw new Error(`资源 ${id} 的固定字节与记录不符`);
            used.set(id, { ...(saved ?? { id, kind: info?.kind ?? 'font',
              ...(info && 'version' in info && typeof info.version === 'number' ? { version: info.version } : {}) }), sha256: hash, byteLength: bytes.length });
            return bytes;
          } catch (error) {
            used.set(id, saved ?? { id, kind: info?.kind ?? 'font', sha256: null, byteLength: null });
            // 不存在的可选后备字体属于已记录的缺失；曾经固定成功的相关字节不能被忽略。
            if (saved && (info || saved.sha256 !== null)) errors.push(severe(ProblemCodes.resourceUnreadable, { kind: 'input', source: `res:${id}` }, `固定资源 ${id} 无法核对：${String(error)}`));
            throw error;
          }
        })();
        reads.set(id, pending);
      }
      return pending;
    },
  };
  return { repository: wrapped, errors, used: () => [...used.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

export async function contentIdentity(options: { workspace: Workspace; candidates: unknown; request?: unknown; reference?: unknown; resources: readonly ResourceIdentity[] }): Promise<ContentIdentity> {
  const value = { format: 'renderweave-content-identity/1' as const, engine: await (build ??= rendererBuildId()), criteria: 'authoring-check/1' as const,
    candidates: options.candidates, workspace: digest({ schemas: options.workspace.staticSchemas.map(({ definition, compiled }) => ({ definition, compiled })),
      templates: options.workspace.templates.map(({ name, document }) => ({ name, document })), datasets: options.workspace.datasets.map(({ id, document }) => ({ id, document })) }),
    request: digest(options.request ?? null), reference: digest(options.reference ?? null), resources: options.resources };
  return { ...value, id: digest(value) };
}

/** 只核对本次使用的映射、种类、版本和实际字节；不受无关资源或任意目录文件影响。 */
export async function resourceDifferences(source: string, identities: readonly ResourceIdentity[]): Promise<Problem[]> {
  const result: Problem[] = [];
  if (!identities.length) return result;
  try {
    const manifest = JSON.parse(await readFile(join(source, 'resources.json'), 'utf8'));
    const { repository, problems } = await openResourceRepository(source);
    if (problems.some(p => p.level === 'severe')) return problems;
    const store = manifest.format ? (await openVersionedResourceStore(source)).store : undefined;
    for (const expected of identities) {
      const info = repository.get(expected.id), version = store?.get(expected.id)?.version;
      const file = store ? undefined : manifest.resources.find((entry: { id: string }) => entry.id === expected.id)?.file;
      let actual: string | null = null, reason = '';
      try { if (info) actual = sha256(await repository.read(expected.id)); } catch (error) { reason = String(error); }
      if (expected.sha256 !== actual || info?.kind !== (expected.sha256 === null && !info ? undefined : expected.kind) || expected.version !== version || expected.file !== file) {
        result.push(severe(ProblemCodes.applyResourcesChanged, { kind: 'input', source: `res:${expected.id}` },
          `资源 ${expected.id} 已变化或无法核对：版本 ${expected.version ?? '旧目录'} → ${version ?? '旧目录'}；字节 ${expected.sha256 ?? '缺失'} → ${actual ?? '缺失'}；映射 ${expected.file ?? '-'} → ${file ?? '-'}${reason ? `；${reason}` : ''}。请在 agent review 撤回结论，重新检查预览、整体确认并核准；--overwrite 不能跳过资源核对`));
      }
    }
  } catch (error) { result.push(severe(ProblemCodes.applyResourcesChanged, { kind: 'input', source }, `当前资源无法核对：${String(error)}；请修复资源后重新审核`)); }
  return result;
}
