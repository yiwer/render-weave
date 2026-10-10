/**
 * 命令行：
 * - render：对一个工作区执行渲染请求，把图片、问题清单与布局摘要写到输出目录。
 *   退出码：0 已出图；1 未出图（正式出图有严重问题，或请求、模板、数据集找不到）；2 用法错误或请求文件无法读取。
 * - publish：把数据定义发布为下一个版本的静态数据定义，写出带版本号的 DSL 与编译产物。
 *   退出码：0 已发布；1 有问题未发布；2 用法错误或文件无法读取。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Problem } from './problems.js';
import { render } from './render.js';
import { publishStaticSchema } from './schema/publish.js';
import { describeError } from './util.js';
import { loadWorkspace, parseJsonKeepingPrecision } from './workspace.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const ExitCodes = { ok: 0, failed: 1, usage: 2 } as const;

const USAGE = `用法：
  renderweave render --workspace <目录> --resources <目录> --request <文件> --out <目录>
  renderweave publish --definition <文件> --workspace <目录> --out <目录>

render
  --workspace   工作区目录：静态数据定义、编译产物、模板与数据集的 JSON 文件
  --resources   资源仓库目录（含 resources.json）
  --request     渲染请求 JSON 文件
  --out         输出目录：image.png 或 image.jpg、problems.json、layout.json

publish
  --definition  数据定义 DSL 文件（renderweave-schema/1）
  --workspace   已发布的静态数据定义所在的工作区：确定下一个版本号，并解析引用
  --out         输出目录：schema-<名称>-v<版本>.json 与 compiled-<名称>-v<版本>.schema.json
`;

type Options = Record<string, string | boolean | undefined>;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const names = command === 'render' ? ['workspace', 'resources', 'request', 'out'] : command === 'publish' ? ['definition', 'workspace', 'out'] : undefined;
  if (!names) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  let values: Options;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: Object.fromEntries(names.map((name) => [name, { type: 'string' as const }])),
      strict: true,
    }));
  } catch (error) {
    io.stderr(`${describeError(error)}\n\n${USAGE}`);
    return ExitCodes.usage;
  }
  if (!names.every((name) => typeof values[name] === 'string')) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  const options = values as Record<string, string>;
  return command === 'render' ? runRender(options, io) : runPublish(options, io);
}

async function runRender(options: Record<string, string>, io: CliIo): Promise<number> {
  const { workspace: workspaceDir, resources, request: requestFile, out } = options as Record<string, string>;
  let request: unknown;
  const tooPrecise: string[] = [];
  try {
    request = parseJsonKeepingPrecision(await readFile(requestFile!, 'utf8'), tooPrecise);
  } catch (error) {
    io.stderr(`渲染请求无法读取：${requestFile}\n  ${describeError(error)}\n`);
    return ExitCodes.usage;
  }
  if (tooPrecise.length > 0) {
    io.stderr(`渲染请求中的数值超过 15 位有效数字，按双精度读取会失真：${tooPrecise.join('、')}\n`);
    return ExitCodes.usage;
  }

  const workspace = await loadWorkspace({ dir: workspaceDir!, resourcesDir: resources! });
  const result = await render(workspace, request);

  await mkdir(out!, { recursive: true });
  // 先清掉上一次的输出，避免这次未出图时留下旧图片造成误会。
  await Promise.all(['image.png', 'image.jpg', 'layout.json'].map((file) => rm(join(out!, file), { force: true })));
  await writeFile(join(out!, 'problems.json'), `${JSON.stringify(result.problems, null, 2)}\n`);
  if (result.layout) await writeFile(join(out!, 'layout.json'), `${JSON.stringify(result.layout, null, 2)}\n`);

  const summary = reportProblems(result.problems, io);
  if (!result.image) {
    io.stdout(`未出图；${summary}。详见 ${join(out!, 'problems.json')}\n`);
    return ExitCodes.failed;
  }
  const imageFile = join(out!, result.image.format === 'png' ? 'image.png' : 'image.jpg');
  await writeFile(imageFile, result.image.bytes);
  io.stdout(`已出图：${imageFile}（${result.image.widthPx} × ${result.image.heightPx} 像素，${result.image.dpi} DPI）；${summary}\n`);
  return ExitCodes.ok;
}

async function runPublish(options: Record<string, string>, io: CliIo): Promise<number> {
  const { definition: definitionFile, workspace: workspaceDir, out } = options as Record<string, string>;
  let definition: unknown;
  try {
    definition = JSON.parse(await readFile(definitionFile!, 'utf8'));
  } catch (error) {
    io.stderr(`数据定义无法读取：${definitionFile}\n  ${describeError(error)}\n`);
    return ExitCodes.usage;
  }
  // 发布只需要已发布的静态数据定义，不读资源仓库。
  const workspace = await loadWorkspace({ dir: workspaceDir!, resourcesDir: workspaceDir! });
  const { published, problems } = publishStaticSchema(definition, workspace.staticSchemas);
  const summary = reportProblems(problems, io);
  if (!published) {
    io.stdout(`未发布；${summary}\n`);
    return ExitCodes.failed;
  }
  // 文件名沿用定义文件名：去掉 schema- 前缀与 -v<版本> 后缀，如 schema-route-sign-v1.json → route-sign。
  const stem = basename(definitionFile!, '.json').replace(/^schema-/, '').replace(/-v\d+$/, '');
  const version = published.ref.version;
  await mkdir(out!, { recursive: true });
  const schemaFile = join(out!, `schema-${stem}-v${version}.json`);
  const compiledFile = join(out!, `compiled-${stem}-v${version}.schema.json`);
  await writeFile(schemaFile, `${JSON.stringify(published.definition, null, 2)}\n`);
  await writeFile(compiledFile, `${JSON.stringify(published.compiled, null, 2)}\n`);
  io.stdout(`已发布：${published.ref.name} v${version}\n  ${schemaFile}\n  ${compiledFile}\n`);
  return ExitCodes.ok;
}

function reportProblems(problems: readonly Problem[], io: CliIo): string {
  for (const problem of problems) {
    const where = Object.values(problem.location).slice(1).join(' / ');
    io.stderr(`[${problem.level === 'severe' ? '严重' : '提示'}] ${problem.code} ${where}：${problem.message}\n`);
  }
  const severeCount = problems.filter((problem) => problem.level === 'severe').length;
  return `问题 ${problems.length} 个（严重 ${severeCount}，提示 ${problems.length - severeCount}）`;
}
