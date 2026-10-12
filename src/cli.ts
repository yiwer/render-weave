/**
 * 命令行：
 * - render：对一个工作区执行渲染请求，把图片、问题清单与布局摘要写到输出目录。
 *   退出码：0 已出图；1 未出图（正式出图有严重问题，或请求、模板、数据集找不到）；2 用法错误或请求文件无法读取。
 * - publish：把数据定义发布为下一个版本的静态数据定义，写出带版本号的 DSL 与编译产物。
 *   退出码：0 已发布；1 有问题未发布；2 用法错误或文件无法读取。
 */
import { mkdir, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Problem } from './problems.js';
import { render, type RenderOptions } from './render.js';
import { publishStaticSchema } from './schema/publish.js';
import { describeError } from './util.js';
import { loadWorkspace, loadWorkspaceDocuments, parseJsonKeepingPrecision } from './workspace.js';
import { initializeResourceStore, importResources, openVersionedResourceStore, checkResourceReplacement, applyResourceReplacement } from './versioned-resources.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const ExitCodes = { ok: 0, failed: 1, usage: 2 } as const;

const USAGE = `用法：
  renderweave render --workspace <目录> --resources <目录> --request <文件> --out <目录>
  renderweave publish --definition <文件> --workspace <目录> --out <目录>
  renderweave resources-init --resources <新目录>
  renderweave resources-import --source <旧资源目录> --resources <版本仓库目录>
  renderweave resources-list --resources <版本仓库目录>
  renderweave resources-get --resources <目录> --id <资源ID> --version <内容版本>
  renderweave resources-check --resources <目录> --workspace <目录> --id <资源ID> --kind <image|font> --file <新内容文件> --out <检查报告.json> [--options <字体配置.json>]
  renderweave resources-apply --resources <目录> --workspace <目录> --file <新内容文件> --check <检查报告.json> [--options <字体配置.json>]

render
  --workspace   工作区目录：静态数据定义、编译产物、模板与数据集的 JSON 文件
  --resources   资源仓库目录（含 resources.json）
  --request     渲染请求 JSON 文件
  --out         输出目录：image.png 或 image.jpg、problems.json、layout.json
  --versions    可选，资源版本映射 JSON 文件，仅用于版本仓库

publish
  --definition  数据定义 DSL 文件（renderweave-schema/1）
  --workspace   已发布的静态数据定义所在的工作区：确定下一个版本号，并解析引用
  --out         输出目录：schema-<名称>-v<版本>.json 与 compiled-<名称>-v<版本>.schema.json
`;

type Options = Record<string, string | boolean | undefined>;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  render: ['workspace', 'resources', 'request', 'out'],
  publish: ['definition', 'workspace', 'out'],
  'resources-init': ['resources'],
  'resources-import': ['source', 'resources'],
  'resources-list': ['resources'],
  'resources-get': ['resources', 'id', 'version'],
  'resources-check': ['resources', 'workspace', 'id', 'kind', 'file', 'out'],
  'resources-apply': ['resources', 'workspace', 'file', 'check'],
};

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const names = command && Object.hasOwn(COMMAND_OPTIONS, command) ? COMMAND_OPTIONS[command] : undefined;
  if (!names) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  let values: Options;
  const optional = command === 'render' ? ['versions'] : command === 'resources-check' || command === 'resources-apply' ? ['options'] : [];
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: Object.fromEntries([...names, ...optional].map((name) => [name, { type: 'string' as const }])),
      strict: true,
    }));
  } catch (error) {
    io.stderr(`${describeError(error)}\n\n${USAGE}`);
    return ExitCodes.usage;
  }
  if (!names.every((name) => typeof values[name] === 'string' && values[name] !== '') ||
    optional.some((name) => values[name] !== undefined && values[name] === '')) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  const options = values as Record<string, string>;
  try {
    if (command === 'render') return await runRender(options, io);
    if (command === 'publish') return await runPublish(options, io);
    return await runResources(command!, options, io);
  } catch (error) {
    io.stderr(`命令执行失败：${describeError(error)}\n`);
    return ExitCodes.failed;
  }
}

async function runResources(command: string, options: Record<string, string>, io: CliIo): Promise<number> {
  const dir = options.resources!;
  if (command === 'resources-check' || command === 'resources-apply') {
    const renderOptions: RenderOptions | undefined = options.options ? JSON.parse(await readFile(options.options, 'utf8')) : undefined;
    const context = { dir, workspaceDir: options.workspace!, file: options.file!, renderOptions };
    if (command === 'resources-check') {
      if (options.kind !== 'image' && options.kind !== 'font') { io.stderr('--kind 必须是 image 或 font\n'); return ExitCodes.usage; }
      if (resolve(dirname(options.out!)) === resolve(options.workspace!)) { io.stderr('检查报告请保存到工作区外，避免改变被检查的工作区\n'); return ExitCodes.usage; }
      const result = await checkResourceReplacement({ ...context, id: options.id!, kind: options.kind });
      reportProblems(result.problems, io);
      if (!result.check) return ExitCodes.failed;
      await mkdir(dirname(options.out!), { recursive: true });
      await writePublishedFiles([{ path: options.out!, value: result.check }]);
      io.stdout(`${JSON.stringify(result.check, null, 2)}\n`);
    } else {
      const check: unknown = JSON.parse(await readFile(options.check!, 'utf8'));
      const result = await applyResourceReplacement({ ...context, check });
      reportProblems(result.problems, io);
      if (!result.replaced) return ExitCodes.failed;
      io.stdout(`${JSON.stringify(result.replaced, null, 2)}\n`);
    }
  } else if (command === 'resources-get') {
    const version = Number(options.version);
    if (!/^[1-9]\d*$/.test(options.version!) || !Number.isSafeInteger(version)) { io.stderr('--version 必须是正安全整数\n'); return ExitCodes.usage; }
    const opened = await openVersionedResourceStore(dir);
    reportProblems(opened.problems, io);
    if (!opened.store) return ExitCodes.failed;
    const info = opened.store.get(options.id!, version);
    if (!info) { io.stderr(`resource.versionNotFound：${options.id} v${version}\n`); return ExitCodes.failed; }
    io.stdout(`${JSON.stringify(info, null, 2)}\n`);
  } else if (command === 'resources-init') {
    const result = await initializeResourceStore(dir);
    reportProblems(result.problems, io);
    if (result.problems.some((item) => item.level === 'severe')) return ExitCodes.failed;
    io.stdout(`已准备资源版本仓库：${dir}\n`);
  } else if (command === 'resources-import') {
    const result = await importResources({ dir, sourceDir: options.source! });
    reportProblems(result.problems, io);
    if (result.problems.some((item) => item.level === 'severe')) return ExitCodes.failed;
    io.stdout(`${JSON.stringify(result.imported, null, 2)}\n`);
  } else {
    const result = await openVersionedResourceStore(dir);
    reportProblems(result.problems, io);
    if (!result.store) return ExitCodes.failed;
    io.stdout(`${JSON.stringify(result.store.list(), null, 2)}\n`);
  }
  return ExitCodes.ok;
}

async function runRender(options: Record<string, string>, io: CliIo): Promise<number> {
  const { workspace: workspaceDir, resources, request: requestFile, out } = options as Record<string, string>;
  await mkdir(out!, { recursive: true });
  // 一次调用开始即清除旧成果，文件读取失败也不能留下看似本次成功的图片。
  await Promise.all(['image.png', 'image.jpg', 'layout.json', 'problems.json'].map((file) => rm(join(out!, file), { force: true })));
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

  let workspace = await loadWorkspace({ dir: workspaceDir!, resourcesDir: resources! });
  if (options.versions) {
    const opened = await openVersionedResourceStore(resources!);
    if (!opened.store) { reportProblems(opened.problems, io); return ExitCodes.failed; }
    const pinned = opened.store.pin(JSON.parse(await readFile(options.versions, 'utf8')));
    if (!pinned.repository) { reportProblems(pinned.problems, io); return ExitCodes.failed; }
    workspace = { ...workspace, resources: pinned.repository };
  }
  const result = await render(workspace, request);

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
  const tooPrecise: string[] = [];
  try {
    definition = parseJsonKeepingPrecision(await readFile(definitionFile!, 'utf8'), tooPrecise);
  } catch (error) {
    io.stderr(`数据定义无法读取：${definitionFile}\n  ${describeError(error)}\n`);
    return ExitCodes.usage;
  }
  if (tooPrecise.length > 0) {
    io.stderr(`数据定义中的数值超过 15 位有效数字，按双精度读取会失真：${tooPrecise.join('、')}\n`);
    return ExitCodes.usage;
  }
  // 发布只需要已发布的静态数据定义，不读资源仓库。
  const workspace = await loadWorkspaceDocuments(workspaceDir!);
  if (workspace.problems.some((problem) => problem.level === 'severe')) {
    io.stdout(`未发布；${reportProblems(workspace.problems, io)}\n`);
    return ExitCodes.failed;
  }
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
  await writePublishedFiles([
    { path: schemaFile, value: published.definition },
    { path: compiledFile, value: published.compiled },
  ]);
  io.stdout(`已发布：${published.ref.name} v${version}\n  ${schemaFile}\n  ${compiledFile}\n`);
  return ExitCodes.ok;
}

/** 排他创建，绝不覆盖已有静态数据定义；可捕获的失败撤回本次创建的文件。 */
async function writePublishedFiles(files: readonly { path: string; value: unknown }[]): Promise<void> {
  const owned: { path: string; handle: FileHandle }[] = [];
  try {
    for (const file of files) owned.push({ path: file.path, handle: await open(file.path, 'wx') });
    for (let i = 0; i < files.length; i++) await owned[i]!.handle.writeFile(`${JSON.stringify(files[i]!.value, null, 2)}\n`);
  } catch (error) {
    // Windows 必须先关闭句柄才能撤回；只清理排他创建成功的文件。
    for (const file of owned) await file.handle.close();
    for (const file of owned) await rm(file.path, { force: true });
    throw error;
  } finally {
    for (const file of owned) await file.handle.close();
  }
}

function reportProblems(problems: readonly Problem[], io: CliIo): string {
  for (const problem of problems) {
    const where = Object.values(problem.location).slice(1).join(' / ');
    io.stderr(`[${problem.level === 'severe' ? '严重' : '提示'}] ${problem.code} ${where}：${problem.message}\n`);
  }
  const severeCount = problems.filter((problem) => problem.level === 'severe').length;
  return `问题 ${problems.length} 个（严重 ${severeCount}，提示 ${problems.length - severeCount}）`;
}
