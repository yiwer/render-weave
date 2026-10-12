import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { loadWorkspace, parseRenderRequest, ProblemCodes, readPngInfo, render,
  type LayoutNode, type RenderRequest, type RenderResult, type Workspace } from '../src/index.js';
import { m402Dir, resourcesDir } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { decodePixels, pixelAtMm } from './support/pixels.js';

const flatten = (node: LayoutNode): LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const all = (result: RenderResult) => flatten(result.layout!.root);
const named = (result: RenderResult, name: string) => all(result).find((node) => node.name === name)!;
const names = (result: RenderResult) => all(result).filter((node) => node.name === '站名');
const columns = (result: RenderResult) => named(result, '站点列').children!;
let workspace: Workspace;
let request: RenderRequest;
let baseline: RenderResult;
const originals = new Map<string, string>();

beforeAll(async () => {
  for (const file of (await readdir(m402Dir)).filter((file) => file.endsWith('.json'))) {
    originals.set(file, await readFile(join(m402Dir, file), 'utf8'));
  }
  workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
  const parsed = parseRenderRequest(JSON.parse(await readFile(join(m402Dir, 'render-request-m402.json'), 'utf8')));
  expect(parsed.problems).toEqual([]);
  request = parsed.request!;
  baseline = await render(workspace, request);
});

function changedName(index: number, name: string): RenderRequest {
  const document = structuredClone(workspace.datasets[0]!.document);
  const data = document.data as { stops: { name: string }[] };
  data.stops[index - 1]!.name = name;
  return { ...request, dataset: { inline: document } };
}

function checkRoads(result: RenderResult) {
  const groups = named(result, '道路段列').children!;
  const starts = [1, 4, 5, 6, 8, 10, 11, 14, 22, 23, 25, 28, 29, 34, 35];
  expect(groups.map((node) => Number(node.path.match(/\[(\d+)\]$/)![1]))).toEqual(starts);
  for (const [i, group] of groups.entries()) {
    const first = columns(result)[starts[i]! - 1]!;
    const last = columns(result)[(starts[i + 1] ?? 36) - 2]!;
    expect(group.x).toBeCloseTo(first.x, 3);
    expect(group.x + group.width).toBeCloseTo(last.x + last.width, 2);
    expect(group.children!.find((n) => n.name === '分隔线')!.visible).toBe(i > 0);
  }
  for (const road of all(result).filter((n) => n.name === '道路名')) {
    expect(road.text!.overflow).toBe(false);
    expect(road.text!.width + 2 * road.text!.spacing).toBeCloseTo(road.width - 4, 2);
  }
}

async function checkHighlights(result: RenderResult, currentIndex: number) {
  const pixels = await decodePixels(result.image!.bytes);
  for (const [i, column] of columns(result).entries()) {
    const area = flatten(column).find((node) => node.name === '名称区')!;
    // 内边距中的无墨迹点，独立验证高亮确实绘制，而非只检查样式摘要。
    expect(pixelAtMm(pixels, area.x + 0.5, area.y + 0.5, 120))
      .toEqual(i + 1 === currentIndex ? [255, 240, 0, 255] : [255, 255, 255, 255]);
  }
}

describe('M402 完整工作区端到端验收', () => {
  it('直接加载 11 份原 JSON：两份静态数据定义及编译产物、五个模板、数据集和请求', async () => {
    const files = (await readdir(m402Dir)).filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(11);
    for (const file of files) expect(() => JSON.parse(originals.get(file)!)).not.toThrow();
    // 模板与数据集必须来自该目录的原文，不能用其他票据的裁剪演示替代。
    expect(workspace.problems).toEqual([]);
    expect(workspace.staticSchemas).toHaveLength(2);
    expect(workspace.staticSchemas.every((entry) => entry.definition && entry.compiled)).toBe(true);
    expect(workspace.templates).toHaveLength(5);
    expect(workspace.datasets).toHaveLength(1);
    for (const entry of [...workspace.templates, ...workspace.datasets]) {
      expect(resolve(entry.source!).startsWith(resolve(m402Dir))).toBe(true);
      expect(entry.document).toEqual(JSON.parse(await readFile(entry.source!, 'utf8')));
    }
  });

  it('本站 5：完整布局快照、golden、尺寸/DPI、高亮和全部道路边界通过', async () => {
    expect(request).toMatchObject({ parameters: { currentIndex: 5 }, mode: 'final' });
    expect(baseline.problems).toEqual([]);
    expect(readPngInfo(baseline.image!.bytes)).toEqual({ width: 3496, height: 780, dpi: 120 });
    expect(baseline.layout!.root.children!.map((n) => [n.name, n.y, n.height])).toEqual([
      ['顶栏', 0, 34], ['站点面板', 34, 100], ['道路带', 134, 10], ['底栏', 144, 21],
    ]);
    expect(names(baseline)).toHaveLength(35);
    expect(names(baseline).map((n) => n.text!.fragments[0]!.color)).toEqual([
      ...Array<string>(4).fill('#C8C8C8FF'), '#E60012FF', ...Array<string>(30).fill('#333333FF'),
    ]);
    expect(new Set(names(baseline).map((n) => n.text!.fontSize))).toEqual(new Set([10]));
    expect(named(baseline, '下一站').text!.content).toBe('下一站：田贝');
    expect(named(baseline, '下一站地标').image!.source).toBe('res:landmark-2');
    expect(named(baseline, '终点站').text!.content).toBe('万国城总站');
    const times = named(baseline, '班次列').children!;
    expect(times).toHaveLength(15);
    const timeText = times.map((time) => flatten(time).filter((n) => n.text).map((n) => n.text!.content).join(''));
    expect(timeText.slice(0, -1).every((text) => text.endsWith('/'))).toBe(true);
    expect(timeText.at(-1)).toBe('20:25');
    checkRoads(baseline);
    await checkHighlights(baseline, 5);
    await expect(`${JSON.stringify(baseline.layout, null, 2)}\n`).toMatchFileSnapshot('./snapshots/m402-full.layout.json');
    await expectMatchesGolden('m402-roads', baseline.image!.bytes);
  });

  it.each([0, 35])('本站 %i：状态与高亮正确，下一站整区隐藏', async (currentIndex) => {
    const result = await render(workspace, { ...request, parameters: { currentIndex } });
    expect(result.problems).toEqual([]);
    expect(named(result, '下一站区').visible).toBe(false);
    expect(named(result, '下一站区')).toMatchObject({ width: 0, height: 0 });
    expect(names(result).map((n) => n.text!.fragments[0]!.color)).toEqual(currentIndex === 0
      ? Array<string>(35).fill('#333333FF') : [...Array<string>(34).fill('#C8C8C8FF'), '#E60012FF']);
    checkRoads(result);
    await checkHighlights(result, currentIndex);
    await expectMatchesGolden(`m402-current-${currentIndex}`, result.image!.bytes);
  });

  it('本站 36：检查项报严重问题，正式不出图，草稿保留相同诊断', async () => {
    const input = { ...request, parameters: { currentIndex: 36 } };
    const final = await render(workspace, input);
    const draft = await render(workspace, { ...input, mode: 'draft' });
    expect(final.image).toBeUndefined();
    expect(final.layout).toBeDefined();
    expect(final.problems).toEqual([expect.objectContaining({ level: 'severe',
      code: ProblemCodes.checkFailed, location: { kind: 'check', template: '标准线路单边', name: '本站序号不能超过站点数' },
      message: '本站序号超过了停靠站点数' })]);
    expect(draft.problems).toEqual(final.problems);
    expect(draft.image).toBeDefined();
  });

  it('1500 mm：重新分配列宽，道路与站点对齐，字号和高度保持', async () => {
    const result = await render(workspace, { ...request, output: { ...request.output, width: 1500 } });
    expect(result.problems).toEqual([]);
    expect(readPngInfo(result.image!.bytes)).toEqual({ width: 7087, height: 780, dpi: 120 });
    expect(new Set(names(result).map((n) => n.text!.fontSize))).toEqual(new Set([10]));
    expect(columns(result)[0]!.width).toBeCloseTo(1454 / 35, 3);
    expect(named(result, '顶栏').height).toBe(34);
    expect(named(result, '终点站').text!.fontSize).toBe(named(baseline, '终点站').text!.fontSize);
    checkRoads(result);
    await expectMatchesGolden('m402-full-1500', result.image!.bytes);
  });

  it('第 9 站换为 11 字长站名：保留地标、统一字号，收距后仅纵向压缩', async () => {
    const longName = '深圳市龙岗区人民医院站';
    expect([...longName]).toHaveLength(11);
    const result = await render(workspace, changedName(9, longName));
    expect(result.problems).toEqual([]);
    const text = names(result)[8]!.text!;
    expect(text).toMatchObject({ content: longName, fontSize: 10, spacing: 0, overflow: false, shrinkGroup: 'stopNames' });
    expect(text.compression).toBeGreaterThanOrEqual(0.6);
    expect(text.compression).toBeLessThan(1);
    expect(new Set(names(result).map((n) => n.text!.fontSize))).toEqual(new Set([10]));
    expect(flatten(columns(result)[8]!).find((n) => n.name === '地标')!.visible).toBe(true);
    await expectMatchesGolden('m402-long-name', result.image!.bytes);
  });

  it('第 12 站含资源字体没有的汉字：精确定位，正式无图，草稿有图且问题相同', async () => {
    const input = changedName(12, '粤宝\u{31350}');
    const final = await render(workspace, input);
    const draft = await render(workspace, { ...input, mode: 'draft' });
    expect(final.image).toBeUndefined();
    expect(final.problems).toEqual([expect.objectContaining({ code: ProblemCodes.textGlyphMissing, level: 'severe',
      location: { kind: 'element', path: '标准线路单边/站点面板/站点列[12]/名称区/站名' } })]);
    expect(final.problems[0]!.message).toContain('U+31350');
    expect(draft.problems).toEqual(final.problems);
    expect(draft.image).toBeDefined();
  });

  it('CLI 一条命令读取原请求，输出与渲染入口逐字节一致', async () => {
    const out = await mkdtemp(join(tmpdir(), 'renderweave-m402-'));
    const messages: string[] = [];
    const code = await runCli(['render', '--workspace', m402Dir, '--resources', resourcesDir,
      '--request', join(m402Dir, 'render-request-m402.json'), '--out', out],
    { stdout: (text) => messages.push(text), stderr: (text) => messages.push(text) });
    expect(code).toBe(0);
    expect(messages.join('')).toContain('严重 0');
    expect(await readFile(join(out, 'image.png'))).toEqual(Buffer.from(baseline.image!.bytes));
    expect(JSON.parse(await readFile(join(out, 'problems.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(await readFile(join(out, 'layout.json'), 'utf8'))).toEqual(baseline.layout);
    for (const [file, original] of originals) expect(await readFile(join(m402Dir, file), 'utf8')).toBe(original);
  });
});
