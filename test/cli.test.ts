import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCodes, runCli } from '../src/cli.js';
import { readPngInfo } from '../src/index.js';
import { greetingRequest, resourcesDir, singleTextDir } from './support/fixtures.js';

async function run(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function renderWith(request: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'renderweave-cli-'));
  const requestFile = join(dir, 'request.json');
  await writeFile(requestFile, JSON.stringify(request));
  const out = join(dir, 'out');
  const result = await run(['render', '--workspace', singleTextDir, '--resources', resourcesDir, '--request', requestFile, '--out', out]);
  return { ...result, out };
}

describe('命令行', () => {
  it('出图成功：写出图片、问题清单与布局摘要，退出码为 0', async () => {
    const { code, out, stdout } = await renderWith(greetingRequest());

    expect(code).toBe(ExitCodes.imageWritten);
    expect(readPngInfo(new Uint8Array(await readFile(join(out, 'image.png'))))).toEqual({ width: 756, height: 189, dpi: 120 });
    expect(JSON.parse(await readFile(join(out, 'problems.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(await readFile(join(out, 'layout.json'), 'utf8')).template).toBe('问候牌');
    expect(stdout).toContain('已出图');
  });

  it('正式出图因严重问题未出图：退出码为 1，不留下图片', async () => {
    const { code, out } = await renderWith(greetingRequest({ output: { width: 1600, height: 40, dpi: 120, format: 'png' } }));

    expect(code).toBe(ExitCodes.noImage);
    expect(existsSync(join(out, 'image.png'))).toBe(false);
    expect(JSON.parse(await readFile(join(out, 'problems.json'), 'utf8'))[0].code).toBe('render.sizeOutOfRange');
  });

  it('渲染请求文件无法读取或参数不全：退出码为 2', async () => {
    const missing = await run(['render', '--workspace', singleTextDir, '--resources', resourcesDir, '--request', join(tmpdir(), 'no-such.json'), '--out', tmpdir()]);
    const usage = await run(['render', '--workspace', singleTextDir]);

    expect(missing.code).toBe(ExitCodes.usage);
    expect(missing.stderr).toContain('渲染请求无法读取');
    expect(usage.code).toBe(ExitCodes.usage);
  });
});
