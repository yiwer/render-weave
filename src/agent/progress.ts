/** 只读进度观测；候选绑定随已有宿主工具日志保存，不写业务工作目录。 */
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord } from '../util.js';
import { WorkingDirectory } from '../mcp/files.js';
import { sha256 } from './round-files.js';

export interface Progress {
  readonly stage: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly remaining: readonly string[];
  readonly next: readonly string[];
}
export type CandidateSnapshot = readonly { readonly path: string; readonly sha256: string }[];
export interface ReviewNote { readonly text: string; readonly sha256: string }
/** 固定的一份按需记录；不遍历 scratch，也不复制图片或任意外部路径。 */
export async function readReviewNote(root: string): Promise<ReviewNote | undefined> {
  try {
    if (!(await lstat(join(root, 'scratch'))).isDirectory()) return undefined;
    const file = join(root, 'scratch/visual-review.md'), info = await lstat(file);
    if (!info.isFile() || info.size > 16_000) return undefined;
    const text = await readFile(file, 'utf8');
    return { text, sha256: sha256(text) };
  } catch { return undefined; }
}
export function parseReviewNote(value: unknown): ReviewNote | undefined {
  return isRecord(value) && typeof value['text'] === 'string' && Buffer.byteLength(value['text']) <= 16_000 &&
    sha256(value['text']) === value['sha256'] ? { text: value['text'], sha256: value['sha256'] as string } : undefined;
}
const shortText = (value: unknown): value is string => typeof value === 'string' && value.length <= 500;
export function parseProgress(value: unknown): Progress | undefined {
  if (!isRecord(value) || !shortText(value['stage']) || !value['stage'].trim() || !shortText(value['summary']) || !value['summary'].trim()) return undefined;
  for (const key of ['decisions', 'remaining', 'next']) if (!Array.isArray(value[key]) || value[key].length > 12 || !value[key].every(shortText)) return undefined;
  return { stage: value['stage'], summary: value['summary'], decisions: value['decisions'] as string[],
    remaining: value['remaining'] as string[], next: value['next'] as string[] };
}

export async function readProgressState(root: string): Promise<{ status: 'ready' | 'missing' | 'invalid'; progress?: Progress; hint: string }> {
  try {
    const file = join(root, 'state.json'), info = await lstat(file);
    if (!info.isFile() || info.size > 24_000) return { status: 'invalid', hint: 'state.json 应为不超过 24000 字节的普通文件' };
    const progress = parseProgress(JSON.parse(await readFile(file, 'utf8')));
    return progress ? { status: 'ready', progress, hint: '进度为 Agent 自述；当前候选绑定随工具日志保存' } :
      { status: 'invalid', hint: '按 docs/core.md 的格式更新 state.json，再核查；阶段和摘要应非空' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ?
      { status: 'missing', hint: '先将本阶段选择、未解决项和下一步写入 state.json，再调用 check_outcome 建立检查点' } :
      { status: 'invalid', hint: 'state.json 无法读取或不是有效 JSON，修正后再核查' };
  }
}

export async function candidateSnapshot(dir: string): Promise<CandidateSnapshot | null> {
  try {
    const root = await WorkingDirectory.open(dirname(dir));
    dir = join(root.root, basename(dir));
    const paths: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      // 目录必须逐层检查，不能通过祖先目录联接枚举工作区外的内容。
      if (!(await lstat(folder)).isDirectory()) throw new Error('候选目录不是普通目录');
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const file = join(folder, entry.name);
        if (entry.isSymbolicLink()) throw new Error('候选目录含链接');
        if (entry.isDirectory()) await walk(file);
        else if (entry.name.endsWith('.json')) paths.push(file);
      }
    };
    await walk(dir);
    const files = [];
    for (const file of paths.sort()) {
      const path = relative(root.root, file).replaceAll('\\', '/');
      // 与所有 MCP 文件读取共用真实路径及单文件 32 MB 限制。
      files.push({ path, sha256: sha256(await root.readBytes(path)) });
    }
    return files;
  } catch { return null; }
}

/** 最近一次核查才代表当前检查点；不向前挑选“看起来匹配”的旧进度。 */
export async function progressFromLog(file: string, candidates: CandidateSnapshot | null): Promise<{ found: boolean; progress?: Progress; reviewNote?: ReviewNote; warning?: string }> {
  let latest: unknown;
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value) && value['tool'] === 'check_outcome' && Object.hasOwn(value, 'progressCheckpoint')) latest = value['progressCheckpoint'];
      } catch { /* 中断写入的最后一行不是完整检查点。 */ }
    }
  } catch { return { found: false }; }
  if (latest === undefined) return { found: false };
  if (isRecord(latest) && latest['status'] === 'ready' && candidates !== null &&
    JSON.stringify(latest['workingCandidates']) === JSON.stringify(candidates)) {
    const progress = parseProgress(latest['progress']);
    if (progress) return { found: true, progress, reviewNote: parseReviewNote(latest['reviewNote']) };
  }
  return { found: true, warning: '最近检查点缺少有效进度或候选已变化；旧进度未沿用，按当前候选重新核查' };
}
