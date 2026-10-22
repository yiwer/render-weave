/** 短进度与宿主交接清单：自述不充当核查证据，变更时不携带旧状态。 */
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../util.js';
import { openResourceRepository } from '../resources.js';
import { sha256 } from './round-files.js';
import { readRoundChain } from './review.js';

interface Progress {
  readonly stage: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly remaining: readonly string[];
  readonly next: readonly string[];
}
export interface Handoff {
  readonly format: 'renderweave-handoff/1';
  readonly binding: string;
  readonly source: 'agent' | 'hostRecovery' | 'none';
  readonly reason: 'contextLimit' | 'roundEnd';
  readonly candidates: readonly { readonly path: string; readonly sha256: string }[];
  readonly workingCandidates: readonly { readonly path: string; readonly sha256: string }[] | null;
  readonly progress?: Progress;
  readonly progressWarning?: string;
}
const shortText = (value: unknown): value is string => typeof value === 'string' && value.length <= 500;
function progress(value: unknown): Progress | undefined {
  if (!isRecord(value) || !shortText(value['stage']) || !shortText(value['summary'])) return undefined;
  for (const key of ['decisions', 'remaining', 'next']) if (!Array.isArray(value[key]) || value[key].length > 12 || !value[key].every(shortText)) return undefined;
  return { stage: value['stage'], summary: value['summary'], decisions: value['decisions'] as string[],
    remaining: value['remaining'] as string[], next: value['next'] as string[] };
}

/** 资料指纹排除本轮反馈和交接视图；客户原文与完整章节仍参与指纹。 */
export async function materialFingerprint(docs: string): Promise<string> {
  const files: [string, string][] = [];
  for (const file of (await readdir(docs, { recursive: true })).map(String).sort()) {
    if (!/\.(md|json)$/.test(file) || ['feedback.md', 'feedback-history.md', 'handoff.md'].includes(file) || /^feedback-history[/\\]/.test(file)) continue;
    files.push([file.replaceAll('\\', '/'), sha256(await readFile(join(docs, file)))]);
  }
  return sha256(JSON.stringify(files));
}

/** 历轮反馈保留原文；客户约束不依赖 Agent 是否写进了 state。 */
export async function writeFeedbackHistory(previous: string, docs: string): Promise<void> {
  const index = ['# 历轮反馈', '', '本轮反馈优先；未被取代的历史约束仍有效。先核对有关反馈原文，不能以进度摘要代替客户要求。', ''];
  for (const link of await readRoundChain(previous)) {
    try {
      const bytes = await readFile(join(link.dir, 'feedback.md'));
      const path = 'feedback-history/round-' + link.round + '.md';
      await mkdir(join(docs, 'feedback-history'), { recursive: true });
      await writeFile(join(docs, path), bytes);
      index.push('- 第 ' + link.round + ' 轮：[' + path + '](' + path + ')');
    } catch (error) {
      if (link.round > 1 || link.missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') index.push('- 第 ' + link.round + ' 轮反馈无法读取，不能假定没有约束。');
    }
  }
  await writeFile(join(docs, 'feedback-history.md'), index.join('\n') + '\n');
}

/** 旧清单只有路径；内容也参与指纹，避免替换同名字体/图片后沿用进度。 */
export async function resourceFingerprint(dir: string): Promise<string> {
  const { repository } = await openResourceRepository(dir);
  const files: [string, string | null][] = [];
  for (const resource of repository.list()) {
    try { files.push([resource.id, sha256(await repository.read(resource.id))]); }
    catch { files.push([resource.id, null]); } // 无法读取仍交由正式检查报告，不伪造内容版本。
  }
  return sha256(JSON.stringify({ manifest: sha256(await readFile(join(dir, 'resources.json'))), files }));
}

async function candidateSnapshot(dir: string): Promise<Handoff['workingCandidates']> {
  const files = [];
  try {
    for (const file of (await readdir(dir, { recursive: true })).map(String).sort()) {
      if (!file.endsWith('.json')) continue;
      const info = await lstat(join(dir, file));
      if (info.isDirectory()) continue;
      if (!info.isFile()) return null; // 不跟随符号链接；不完整快照不能用于恢复摘要。
      files.push({ path: 'candidates/' + file.replaceAll('\\', '/'), sha256: sha256(await readFile(join(dir, file))) });
    }
    return files;
  } catch { return null; } // 交接观测失败不能阻断轮次记录落盘。
}

export async function saveHandoff(round: string, value: Omit<Handoff, 'format' | 'progress' | 'progressWarning' | 'workingCandidates'>): Promise<string> {
  let state: Progress | undefined, warning: string | undefined;
  try {
    const file = join(round, 'agent/state.json'), info = await lstat(file);
    if (!info.isFile() || info.size > 24_000) warning = 'state.json 不是普通小文件，未采用';
    else {
      state = progress(JSON.parse(await readFile(file, 'utf8')));
      if (!state) warning = 'state.json 格式不合格，未采用';
    }
  } catch (error) { warning = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Agent 未保存进度，按候选与原始要求继续' : 'state.json 无法读取，未采用'; }
  const workingCandidates = await candidateSnapshot(join(round, 'agent/candidates'));
  if (workingCandidates === null) warning = [warning, '候选快照不完整，续跑时不采用旧进度'].filter(Boolean).join('；');
  const handoff: Handoff = { format: 'renderweave-handoff/1', ...value, workingCandidates, ...(state ? { progress: state } : {}), ...(warning ? { progressWarning: warning } : {}) };
  const text = JSON.stringify(handoff, null, 2) + '\n';
  await writeFile(join(round, 'handoff.json'), text);
  await writeFile(join(round, 'handoff-feedback.md'), '继续上轮未完成工作。先核对原始项目要求与当前候选，再处理交接中的未解决项；重新运行检查，按本轮实际结果交回。\n');
  return sha256(text);
}

export async function restoreHandoff(previous: string, digest: string | undefined, binding: string,
  candidates: ReadonlyMap<string, Uint8Array>, target: string): Promise<void> {
  if (!digest) return;
  let note = '上轮交接已失效或损坏；以项目说明、当前候选和本轮反馈为准，重新核查。';
  try {
    const text = await readFile(join(previous, 'handoff.json'), 'utf8');
    if (sha256(text) === digest) {
      const value: unknown = JSON.parse(text);
      if (isRecord(value) && value['format'] === 'renderweave-handoff/1' && value['binding'] === binding && Array.isArray(value['workingCandidates']) &&
        value['workingCandidates'].length === candidates.size &&
        value['workingCandidates'].every((c) => isRecord(c) && typeof c['path'] === 'string' && candidates.has(c['path']) && sha256(candidates.get(c['path'])!) === c['sha256'])) {
        const state = progress(value['progress']);
        note = '上轮来源：' + String(value['source']) + '。以下仅为 Agent 进度自述；旧核查不表示本轮通过。\n' +
          (state ? JSON.stringify(state, null, 2) : '没有可用进度摘要；从当前候选和上轮问题清单定位未完成工作。');
      }
    }
  } catch { /* 损坏或缺失的交接不阻止按原始资料恢复。 */ }
  await writeFile(target, '# 上轮交接\n\n' + note + '\n');
}
