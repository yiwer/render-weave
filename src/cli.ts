/**
 * 命令行：对一个工作区执行渲染请求，把图片、问题清单与布局摘要写到输出目录。
 *
 * 退出码：0 已出图；1 未出图（正式出图有严重问题，或请求、模板、数据集找不到）；2 用法错误或请求文件无法读取。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { render } from './render.js';
import { describeError } from './util.js';
import { loadWorkspace } from './workspace.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const ExitCodes = { imageWritten: 0, noImage: 1, usage: 2 } as const;

const USAGE = `用法：renderweave render --workspace <目录> --resources <目录> --request <文件> --out <目录>

  --workspace  工作区目录：静态数据定义、编译产物、模板与数据集的 JSON 文件
  --resources  资源仓库目录（含 resources.json）
  --request    渲染请求 JSON 文件
  --out        输出目录：image.png 或 image.jpg、problems.json、layout.json
`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'render') {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        workspace: { type: 'string' },
        resources: { type: 'string' },
        request: { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    io.stderr(`${describeError(error)}\n\n${USAGE}`);
    return ExitCodes.usage;
  }
  const { workspace: workspaceDir, resources, request: requestFile, out } = values;
  if (typeof workspaceDir !== 'string' || typeof resources !== 'string' || typeof requestFile !== 'string' || typeof out !== 'string') {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }

  let request: unknown;
  try {
    request = JSON.parse(await readFile(requestFile, 'utf8'));
  } catch (error) {
    io.stderr(`渲染请求无法读取：${requestFile}\n  ${describeError(error)}\n`);
    return ExitCodes.usage;
  }

  const workspace = await loadWorkspace({ dir: workspaceDir, resourcesDir: resources });
  const result = await render(workspace, request);

  await mkdir(out, { recursive: true });
  // 先清掉上一次的输出，避免这次未出图时留下旧图片造成误会。
  await Promise.all(['image.png', 'image.jpg', 'layout.json'].map((file) => rm(join(out, file), { force: true })));
  await writeFile(join(out, 'problems.json'), `${JSON.stringify(result.problems, null, 2)}\n`);
  if (result.layout) await writeFile(join(out, 'layout.json'), `${JSON.stringify(result.layout, null, 2)}\n`);

  const severeCount = result.problems.filter((problem) => problem.level === 'severe').length;
  const summary = `问题 ${result.problems.length} 个（严重 ${severeCount}，提示 ${result.problems.length - severeCount}）`;
  for (const problem of result.problems) {
    const where = Object.values(problem.location).slice(1).join(' / ');
    io.stderr(`[${problem.level === 'severe' ? '严重' : '提示'}] ${problem.code} ${where}：${problem.message}\n`);
  }
  if (!result.image) {
    io.stdout(`未出图；${summary}。详见 ${join(out, 'problems.json')}\n`);
    return ExitCodes.noImage;
  }
  const imageFile = join(out, result.image.format === 'png' ? 'image.png' : 'image.jpg');
  await writeFile(imageFile, result.image.bytes);
  io.stdout(
    `已出图：${imageFile}（${result.image.widthPx} × ${result.image.heightPx} 像素，${result.image.dpi} DPI）；${summary}\n`,
  );
  return ExitCodes.imageWritten;
}
