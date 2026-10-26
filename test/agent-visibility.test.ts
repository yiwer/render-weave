import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareReference, loadWorkspace, render, runAgentTask, type ReferenceBaseline, type Workspace } from '../src/index.js';
import { m402Dir, repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';
import { startMcp } from './support/mcp-client.js';

let workspace: Workspace;
let root: string;
beforeAll(async () => { workspace = await loadWorkspace({dir: m402Dir, resourcesDir}); root = await mkdtemp(join(tmpdir(), 'rw-visibility-')); });
afterAll(async () => { await rm(root, {recursive: true, force: true}); });
const text = (extra: Record<string, unknown> = {}) => ({type: 'text', name: '目标', font: 'res:font-hei-medium', fontSize: 10,
  color: '#000000', content: [{text: '科技园'}], place: {left: 10, top: 10, width: {fixed: 60}, height: {fixed: 30}}, ...extra});
const document = (children: unknown[]) => ({dslVersion: 'renderweave-template/1', name: '可见性', base: {name: '空数据定义', version: 1},
  artboard: {fill: '#FFFFFF', sizeRange: {width: {min: 10, max: 200}, height: {min: 10, max: 200}}, layout: {mode: 'free'}, children}});
const request = {template: '可见性', dataset: {inline: {dataset: {staticSchema: {name: '空数据定义', version: 1}}, data: {}}},
  parameters: {}, output: {width: 100, height: 60, dpi: 50, format: 'png'}, mode: 'draft'};
const baseline: ReferenceBaseline = {sampleWidthPx: 200, sampleHeightPx: 120, artboardWidthMm: 100, artboardHeightMm: 60,
  approvedRegions: [{id: 'target', name: '目标', targetPathPattern: '可见性/*目标', expectedText: '科技园', sampleRegion: {x: 20, y: 20, width: 120, height: 60}}]};
const compare = (children: unknown[], reference = baseline) => compareReference({workspace: {...workspace, templates: [{name: '可见性', document: document(children)}]}, request, baseline: reference});
const cover = (extra: Record<string, unknown> = {}) => ({type: 'rect', name: '遮挡', fill: '#FFFFFF', place: {left: 5, top: 5, width: {fixed: 80}, height: {fixed: 45}}, ...extra});

it('核准文字因父级累计透明度为零而不可见时明确报告，半透明对照不误报', async () => {
  const group = (opacity: number) => ({type: 'container', name: '分组', opacity, layout: {mode: 'free'},
    place: {left: 0, top: 0, width: {fixed: 90}, height: {fixed: 50}}, children: [text()]});
  const hidden = await compare([group(0)]);
  expect(hidden.report?.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'contentInvisible', path: '可见性/分组/目标'})]));
  expect(hidden.report?.regions[0]?.instances[0]).toMatchObject({visibility: {status: 'invisible', reasons: ['transparent']}});
  expect(hidden.report?.status).toBe('needsWork');
  const translucent = await compare([group(0.5)]);
  expect(translucent.report?.anomalies).toEqual([]);
  expect(translucent.report?.passed).toBe(false);
});

it('后绘制的不透明实心矩形完全遮挡被定位；先绘制、半透明、空心和裁切不足不能误报', async () => {
  const hidden = await compare([text(), cover()]);
  expect(hidden.report?.regions[0]?.instances[0]).toMatchObject({visibility: {status: 'invisible', reasons: ['occluded'],
    occluders: [expect.objectContaining({path: '可见性/遮挡'})]}});
  for (const children of [
    [cover(), text()],
    [text(), cover({opacity: 0.5})],
    [text(), cover({fill: undefined, stroke: {color: '#000000', width: 1}})],
    [text(), {type: 'container', name: '半透明组', opacity: 0.5, layout: {mode: 'free'}, place: {left: 0, top: 0, width: {fixed: 90}, height: {fixed: 50}}, children: [cover()]}],
    [text(), {type: 'container', name: '裁切组', clip: true, layout: {mode: 'free'}, place: {left: 0, top: 0, width: {fixed: 12}, height: {fixed: 50}}, children: [cover()]}],
  ]) {
    const safe = await compare(children);
    expect(safe.report?.anomalies.some(a => a.kind === 'contentInvisible')).toBe(false);
    expect(safe.report?.passed).toBe(false);
  }
});

it('画板及轴对齐父级裁切完全排除文字时报告裁掉，部分裁切保留未知', async () => {
  const outside = await compare([text({place: {left: 110, top: 10, width: {fixed: 60}, height: {fixed: 30}}})]);
  expect(outside.report?.regions[0]?.instances[0]).toMatchObject({visibility: {status: 'invisible', reasons: ['clipped']}});
  const clipped = (width: number) => ({type: 'container', name: '裁切', clip: true, layout: {mode: 'free'},
    place: {left: 0, top: 0, width: {fixed: width}, height: {fixed: 50}}, children: [text()]});
  const complete = await compare([clipped(5)]);
  expect(complete.report?.regions[0]?.instances[0]).toMatchObject({visibility: {status: 'invisible', reasons: ['clipped']}});
  expect(complete.report?.anomalies.some(a => a.kind === 'contentInvisible')).toBe(true);
  const partial = await compare([clipped(25)]);
  expect(partial.report?.anomalies.some(a => a.kind === 'contentInvisible')).toBe(false);
  expect(partial.report?.regions[0]?.instances[0]?.visibility?.status).toBe('unknown');
});

it('同样核查矩形实际绘制与文字颜色透明度，含子元素的容器不能只凭背景判不可见', async () => {
  const shapeBaseline = {...baseline, approvedRegions: [{...baseline.approvedRegions[0]!, expectedText: undefined}]};
  const outside = await compare([cover({name: '目标', place: {left: 110, top: 10, width: {fixed: 30}, height: {fixed: 20}}})], shapeBaseline);
  expect(outside.report?.regions[0]?.instances[0]).toMatchObject({visibility: {status: 'invisible', reasons: ['clipped']}});
  const transparentInk = await compare([text({color: '#00000000'})]);
  expect(transparentInk.report?.regions[0]?.instances[0]).toMatchObject({visibility: {status: 'invisible', reasons: ['transparent']}});
  const group = {type: 'container', name: '目标', fill: '#000000', layout: {mode: 'free'},
    place: {left: 110, top: 0, width: {fixed: 30}, height: {fixed: 30}}, children: [text({name: '越界文字', place: {left: -100, top: 10, width: {fixed: 60}, height: {fixed: 20}}})]};
  const overflow = await compare([group], shapeBaseline);
  expect(overflow.report?.anomalies.some(a => a.kind === 'contentInvisible')).toBe(false);
});

it('图片内容按核准字节核对，同名但换成另一图不能通过，缺少图片事实保持未核查', async () => {
  const approved = createHash('sha256').update(await workspace.resources.read('icon-metro')).digest('hex');
  const image = {type: 'image', name: '目标', source: 'res:icon-metro', fit: 'fill', place: {left: 10, top: 10, width: {fixed: 20}, height: {fixed: 20}}};
  const reference = {...baseline, approvedRegions: [{...baseline.approvedRegions[0]!, expectedText: undefined, expectedImageSha256: approved}]};
  const normal = await compare([image], reference);
  expect(normal.report?.regions[0]?.instances[0]).toMatchObject({imageContent: {status: 'matches', sha256: approved}});
  const changed = {...workspace, resources: {get: workspace.resources.get.bind(workspace.resources), list: workspace.resources.list.bind(workspace.resources),
    read: (id: string) => workspace.resources.read(id === 'icon-metro' ? 'icon-hospital' : id)}, templates: [{name: '可见性', document: document([image])}]};
  const wrong = await compareReference({workspace: changed, request, baseline: reference});
  expect(wrong.report?.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'imageContentMismatch', path: '可见性/目标'})]));
  expect(wrong.report?.reportId).not.toBe(normal.report?.reportId);
  const unknown = await compare([image], {...reference, approvedRegions: [{...reference.approvedRegions[0]!, expectedImageSha256: undefined}]});
  expect(unknown.report?.regions[0]?.instances[0]).toMatchObject({imageContent: {status: 'notChecked'}});
  expect(unknown.report?.passed).toBe(false);
});

it('图片、文字包围框、圆角与旋转不充当实心遮挡，复杂变换不冒称已测', async () => {
  for (const overlay of [
    {type: 'image', name: '图层', source: 'res:icon-metro', fit: 'fill', place: {left: 0, top: 0, width: {fixed: 90}, height: {fixed: 55}}},
    text({name: '字层', fontSize: 25, content: [{text: '覆盖图'}]}), cover({cornerRadius: 10}), cover({rotation: 10}),
  ]) {
    const result = await compare([text(), overlay]);
    expect(result.report?.anomalies.some(a => a.kind === 'contentInvisible')).toBe(false);
    expect(result.report?.regions[0]?.instances[0]?.unknown).toContain('部分遮挡、复杂变换、低对比与感知可读性未核查');
  }
  const rotated = await compare([text({rotation: 20}), cover()]);
  expect(rotated.report?.regions[0]?.instances[0]?.visibility?.status).toBe('unknown');
});

it('二维码右侧留白仍在画板上时不能按码区框误报完全裁掉', async () => {
  const result = await compare([{type: 'qrcode', name: '目标', content: 'test',
    place: {left: -26, top: 10, width: {fixed: 30}, height: {fixed: 30}}}],
  {...baseline, approvedRegions: [{...baseline.approvedRegions[0]!, expectedText: undefined}]});
  expect(result.report?.anomalies.some(a => a.kind === 'contentInvisible')).toBe(false);
});

it('核准区域匹配歧义保留未知，无效图片事实明确拒绝', async () => {
  const repeated = await compare([text(), text({name: '第二项'})], {...baseline,
    approvedRegions: [{...baseline.approvedRegions[0]!, targetPathPattern: undefined, targetText: '科技园'}]});
  expect(repeated.report?.regions[0]).toMatchObject({status: 'ambiguous', instances: []});
  expect(repeated.report?.passed).toBe(false);
  await expect(compare([text()], {...baseline, approvedRegions: [{...baseline.approvedRegions[0]!, expectedImageSha256: 'not-a-hash'}]})).rejects.toThrow();
});

it('真实MCP比较、交回检查与宿主终检的不可见证据一致，修改候选后旧ID失效', async () => {
  const live = await loadWorkspace({dir: singleTextDir, resourcesDir});
  const doc = (children: unknown[]) => ({...document(children), base: {name: '问候', version: 1}});
  const outputRequest = {...request, dataset: {id: 'ds-greeting'}};
  const normal = await render({...live, templates: [{name: '可见性', document: doc([text()])}]}, outputRequest);
  expect(normal.problems).toEqual([]);
  const sample = join(root, 'sample.png'), reference = join(root, 'reference.json'), requestFile = join(root, 'request.json'), brief = join(root, 'brief.md');
  await writeFile(sample, normal.image!.bytes);
  await writeFile(reference, JSON.stringify({...baseline, sampleWidthPx: normal.image!.widthPx, sampleHeightPx: normal.image!.heightPx}));
  await writeFile(requestFile, JSON.stringify(outputRequest)); await writeFile(brief, '保留科技园站名，可见文字完整。');
  const preset = join(root, 'preset'); await mkdir(join(preset, 'candidates'), {recursive: true});
  await writeFile(join(preset, 'candidates/main.json'), JSON.stringify(doc([text(), cover()])));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({candidates: ['candidates/main.json'], pending: [], notes: '受控不可见候选'}));
  const task = await runAgentTask({task: 'template-design', sample, reference, brief, workspace: singleTextDir, resources: resourcesDir,
    dataset: 'ds-greeting', request: requestFile, out: join(root, 'round'), key: 'offline-test', keyEnv: 'RW_TEST_KEY',
    claude: {command: process.execPath, args: [join(repoRoot, 'test/support/fake-claude.mjs'), preset]}});
  expect(task.check.verdict).toBe('qualified');
  expect(task.check.assessment.visual?.status).toBe('needsWork');
  expect(task.check.assessment.style?.passed).toBe(false);
  const session = startMcp(['--workspace',join(task.roundDir,'snapshot'),'--resources',join(task.roundDir,task.record.inputs.resourceSnapshot!.directory),
    '--root',join(task.roundDir,'agent'),'--outcome-context',join(task.roundDir,'logs/outcome-context.json')]);
  try {
    await session.request('initialize', {protocolVersion: '2025-06-18'});
    const compared = await session.callJson('compare_reference');
    const checked = await session.callJson('check_outcome');
    expect(compared.reportId).toBe(task.check.assessment.visual?.reportId);
    expect(checked.assessment.visual.reportId).toBe(compared.reportId);
    expect(checked.contentIdentity.id).toBe(task.check.contentIdentity?.id);
    expect(compared.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'contentInvisible'})]));
    expect(JSON.stringify(checked).length).toBeLessThanOrEqual(40000);
    await writeFile(join(task.roundDir, 'agent/candidates/main.json'), JSON.stringify(doc([text()])));
    const fixed = await session.callJson('compare_reference');
    expect(fixed.reportId).not.toBe(compared.reportId);
    expect(fixed.anomalies).toEqual([]);
  } finally { await session.close(); }
});
