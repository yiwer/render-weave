/** 短进度与宿主交接清单：自述不充当核查证据，变更时不携带旧状态。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRecord } from '../util.js';
import { openResourceRepository } from '../resources.js';
import { sha256 } from './round-files.js';
import { readRoundChain } from './review.js';

import { candidateSnapshot, parseProgress, parseReviewNote, progressFromLog, readProgressState, type Progress, type ReviewNote } from './progress.js';

export interface Handoff {
  readonly format: 'renderweave-handoff/1';
  readonly binding: string;
  readonly source: 'agent' | 'hostRecovery' | 'none';
  readonly reason: 'contextLimit' | 'roundEnd';
  readonly candidates: readonly { readonly path: string; readonly sha256: string }[];
  readonly workingCandidates: readonly { readonly path: string; readonly sha256: string }[] | null;
  readonly progress?: Progress;
  readonly progressWarning?: string;
  readonly progressSource?: 'checkpoint' | 'stateFile' | 'none';
  readonly reviewNote?: ReviewNote;
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

export async function saveHandoff(round: string, value: Omit<Handoff, 'format' | 'progress' | 'progressWarning' | 'workingCandidates' | 'progressSource' | 'reviewNote'>): Promise<string> {
  const workingCandidates = await candidateSnapshot(join(round, 'agent/candidates'));
  const checkpoint = await progressFromLog(join(round, 'logs/tools.jsonl'), workingCandidates);
  const fileState = checkpoint.found ? undefined : await readProgressState(join(round, 'agent'));
  const state = checkpoint.progress ?? fileState?.progress;
  let warning = checkpoint.warning ?? (fileState ? fileState.progress ? '进度来自 state.json，尚未经过工具检查点绑定' : fileState.hint : undefined);
  if (workingCandidates === null) warning = [warning, '候选快照不完整，续跑时不采用旧进度'].filter(Boolean).join('；');
  const progressSource = state ? checkpoint.progress ? 'checkpoint' : 'stateFile' : 'none';
  const handoff: Handoff = { format: 'renderweave-handoff/1', ...value, workingCandidates, progressSource, ...(state ? { progress: state } : {}),
    ...(checkpoint.reviewNote ? { reviewNote: checkpoint.reviewNote } : {}), ...(warning ? { progressWarning: warning } : {}) };
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
        const state = parseProgress(value['progress']);
        const reviewNote = state ? parseReviewNote(value['reviewNote']) : undefined;
        if (reviewNote) {
          const scratch = join(dirname(target), '../scratch');
          await mkdir(scratch, { recursive: true });
          await writeFile(join(scratch, 'visual-review.md'), reviewNote.text);
        }
        note = '上轮来源：' + String(value['source']) + '。以下仅为 Agent 进度自述；旧核查不表示本轮通过。\n' +
          (state ? '进度来源：' + String(value['progressSource'] ?? 'stateFile') + '。\n' + JSON.stringify(state, null, 2) : '没有可用进度摘要；从当前候选和上轮问题清单定位未完成工作。') +
          (typeof value['progressWarning'] === 'string' ? '\n交接提示：' + value['progressWarning'] : '') +
          (reviewNote ? '\n详细自述已恢复到 scratch/visual-review.md，涉及该区域时按需读取。' : '\n没有已绑定的详细记录；state 中的旧文件指针可能不可用，按当前候选重新测量。');
      }
    }
  } catch { /* 损坏或缺失的交接不阻止按原始资料恢复。 */ }
  await writeFile(target, '# 上轮交接\n\n' + note + '\n');
}
