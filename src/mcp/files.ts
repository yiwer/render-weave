/**
 * 工具只能读本轮工作目录内的文件（ADR-0015、M53）。路径按真实路径判断，
 * 经符号链接或目录联接指向工作目录外的文件同样拒绝。
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { describeError } from '../util.js';
import { parseJsonKeepingPrecision } from '../workspace.js';

/** 工具输入有误：作为工具结果报告（isError），由 Agent 自行修正，不是协议错误。 */
export class ToolInputError extends Error {}

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export class WorkingDirectory {
  private constructor(readonly root: string, private readonly given: string) {}

  static async open(dir: string): Promise<WorkingDirectory> {
    const root = await realpath(dir);
    if (!(await stat(root)).isDirectory()) throw new Error(`工作目录不是目录：${dir}`);
    return new WorkingDirectory(root, resolve(dir));
  }

  /** 解析为工作目录内的真实路径；越界、不存在或不是文件时抛出 ToolInputError。 */
  async resolve(path: unknown): Promise<string> {
    if (typeof path !== 'string' || path.trim() === '') throw new ToolInputError('路径必须是非空文本');
    const outside = (base: string, target: string) => {
      const rel = relative(base, target);
      return rel === '' || rel.startsWith('..') || isAbsolute(rel);
    };
    // 先按字面拒绝，不触碰工作目录外的路径。工作目录的给定写法与真实路径都认：
    // Windows 上二者可能只差 8.3 短名（C:\Users\ADMINI~1）；最终以真实路径判断。
    const full = resolve(this.root, path);
    if (outside(this.root, full) && outside(this.given, full)) throw new ToolInputError(`只能读取工作目录内的文件：${path}`);
    let real: string;
    try {
      real = await realpath(full);
    } catch {
      throw new ToolInputError(`文件不存在：${path}`);
    }
    if (outside(this.root, real)) throw new ToolInputError(`只能读取工作目录内的文件：${path}`);
    const info = await stat(real);
    if (!info.isFile()) throw new ToolInputError(`不是文件：${path}`);
    if (info.size > MAX_FILE_BYTES) throw new ToolInputError(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB：${path}`);
    return real;
  }

  async readBytes(path: unknown): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await this.resolve(path)));
  }

  /** 读 JSON，并记下超过 15 位有效数字的数值原文（M112）。 */
  async readJson(path: unknown): Promise<{ document: unknown; tooPrecise: string[] }> {
    const text = Buffer.from(await this.readBytes(path)).toString('utf8');
    const tooPrecise: string[] = [];
    try {
      return { document: parseJsonKeepingPrecision(text, tooPrecise), tooPrecise };
    } catch (error) {
      throw new ToolInputError(`不是有效的 JSON：${String(path)}（${describeError(error)}）`);
    }
  }
}
