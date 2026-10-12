import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCodes, runCli } from '../src/cli.js';
import { resourcesDir, singleTextDir } from './support/fixtures.js';

async function run(args: string[]) {
  const messages: string[] = [];
  const code = await runCli(args, { stdout: (text) => messages.push(text), stderr: (text) => messages.push(text) });
  return { code, messages: messages.join('') };
}

async function publishing() {
  const dir = await mkdtemp(join(tmpdir(), 'renderweave-publish-audit-'));
  const workspace = join(dir, 'workspace');
  const out = join(dir, 'out');
  const definition = join(dir, 'schema-example.json');
  await mkdir(workspace);
  await mkdir(out);
  await writeFile(definition, JSON.stringify({ dslVersion: 'renderweave-schema/1', name: 'example', displayName: '样例', fields: [] }));
  const args = ['publish', '--definition', definition, '--workspace', workspace, '--out', out];
  return { dir, workspace, out, definition, args };
}

describe('命令行故障与已有成果保护', () => {
  it('发布不需要资源清单，空工作区可以发布首版', async () => {
    const { args, out } = await publishing();
    expect((await run(args)).code).toBe(ExitCodes.ok);
    expect(JSON.parse(await readFile(join(out, 'schema-example-v1.json'), 'utf8')).version).toBe(1);
  });

  it.each(['missing', 'malformed', 'duplicate'])('工作区 %s 时停止发布，不把不完整版本历史当成空历史', async (failure) => {
    const { args, workspace, out } = await publishing();
    if (failure === 'missing') args[4] = join(workspace, 'missing');
    if (failure === 'malformed') await writeFile(join(workspace, 'broken.json'), '{');
    if (failure === 'duplicate') {
      const schema = JSON.stringify({ dslVersion: 'renderweave-schema/1', name: 'example', version: 1, fields: [] });
      await writeFile(join(workspace, 'one.json'), schema);
      await writeFile(join(workspace, 'two.json'), schema);
    }
    const result = await run(args);
    expect(result.code).toBe(ExitCodes.failed);
    expect(result.messages).not.toContain('已发布：');
    expect(existsSync(join(out, 'schema-example-v1.json'))).toBe(false);
    expect(existsSync(join(out, 'schema-example-v2.json'))).toBe(false);
  });

  it.each(['schema-example-v1.json', 'compiled-example-v1.schema.json'])('已有 %s 不可覆盖，失败不留下另一半产物', async (file) => {
    const { args, out } = await publishing();
    await writeFile(join(out, file), '原有成果');
    const result = await run(args);
    expect(result.code).toBe(ExitCodes.failed);
    expect(await readFile(join(out, file), 'utf8')).toBe('原有成果');
    const other = file.startsWith('schema-') ? 'compiled-example-v1.schema.json' : 'schema-example-v1.json';
    expect(existsSync(join(out, other))).toBe(false);
  });

  it('并发向同一路径发布只有一个成功，产物成对且完整', async () => {
    const { args, out } = await publishing();
    const results = await Promise.all([run(args), run(args)]);
    expect(results.map((result) => result.code).sort()).toEqual([ExitCodes.ok, ExitCodes.failed]);
    expect(JSON.parse(await readFile(join(out, 'schema-example-v1.json'), 'utf8')).version).toBe(1);
    expect(JSON.parse(await readFile(join(out, 'compiled-example-v1.schema.json'), 'utf8')).title).toBe('example v1');
  });

  it('定义数值在 JSON 读取时失真前拒绝发布', async () => {
    const { args, definition } = await publishing();
    await writeFile(definition, '{"dslVersion":"renderweave-schema/1","name":"example","fields":[{"name":"value","displayName":"值","type":"number","constraints":{"max":1.00000000000000001}}]}');
    const result = await run(args);
    expect(result.code).toBe(ExitCodes.usage);
    expect(result.messages).toContain('15 位有效数字');
  });

  it('输出位置不可写时返回中文失败信息，不抛出未处理异常', async () => {
    const { args, out } = await publishing();
    const blocked = join(out, 'file');
    await writeFile(blocked, '保留');
    args[6] = blocked;
    const result = await run(args);
    expect(result.code).toBe(ExitCodes.failed);
    expect(result.messages).toContain('命令执行失败');
    expect(await readFile(blocked, 'utf8')).toBe('保留');
  });

  it('请求文件损坏时清除上次渲染成果，避免将旧图片当成本次输出', async () => {
    const { dir, out } = await publishing();
    const request = join(dir, 'request.json');
    await writeFile(request, '{');
    for (const file of ['image.png', 'image.jpg', 'layout.json', 'problems.json']) await writeFile(join(out, file), '旧输出');
    const result = await run(['render', '--workspace', singleTextDir, '--resources', resourcesDir, '--request', request, '--out', out]);
    expect(result.code).toBe(ExitCodes.usage);
    for (const file of ['image.png', 'image.jpg', 'layout.json', 'problems.json']) expect(existsSync(join(out, file))).toBe(false);
  });
});
