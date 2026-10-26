import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { copyWorkspaceFixture, repoRoot, resourcesDir, singleTextDir, m402Dir } from './support/fixtures.js';
import { loadCanvasKit } from '../src/canvaskit.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'rw-behavior-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const json = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));
const read = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), 'scripts/agent-eval/run.ts', ...args], { cwd: repoRoot, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); }); child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

it('换字段后从评估 CLI 核对实际文字：合法绑定通过，零严重问题的写死值失败', async () => {
  const workspace = join(dir, 'field-workspace'); await copyWorkspaceFixture(singleTextDir, workspace);
  const policy = join(dir, 'fields.json');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'field-calibration', authority: '维护者预登记：将问候内容改为 World',
    cases: [{ id: 'field', category: 'field', change: 'message 从 Hello 改为 World',
      request: { template: '问候牌', dataset: { inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message: 'World' } } }, parameters: {}, output: { width: 160, height: 40, dpi: 60, format: 'png' }, mode: 'draft' },
      facts: [{ id: 'message', kind: 'texts', selector: '问候牌/问候语', expected: ['World'], order: 'x' }] }] });
  const run = async (name: string) => {
    const out = join(dir, name);
    const result = await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out]);
    return { ...result, report: await read(join(out, 'behavior.json')) };
  };
  const good = await run('field-good');
  expect(good.code, good.stderr).toBe(0);
  expect(good.report).toMatchObject({ status: 'pass', cases: [{ status: 'pass', facts: [{ id: 'message', status: 'pass', actual: ['World'] }] }] });
  const templateFile = join(workspace, 'template-greeting.json'), template = await read(templateFile);
  template.artboard.children[0].content = [{ text: 'Hello' }]; await json(templateFile, template);
  const bad = await run('field-bad');
  expect(bad.code, bad.stderr).toBe(1);
  expect(bad.report).toMatchObject({ status: 'fail', cases: [{ technical: { severe: 0 }, facts: [{ status: 'fail', actual: ['Hello'] }] }] });
  expect(bad.report.policy.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await read(join(dir, 'field-bad', 'field', 'request.json'))).toMatchObject({ dataset: { inline: { data: { message: 'World' } } } });
});

it('列表插入、删除、同名出现按实际实例及空间顺序核查，拒绝截尾、反序和误合并', async () => {
  const workspace = join(dir, 'list-workspace'); await copyWorkspaceFixture(m402Dir, workspace);
  const original = await read(join(workspace, 'template-route-sign.json'));
  const dataset = await read(join(workspace, 'dataset-m402.json'));
  const policy = join(dir, 'list.json');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'list-calibration', authority: '独立业务顺序：Alpha → Beta → Alpha → Alpha → Gamma；缩短后 Alpha → Gamma',
    cases: [ ['grown', ['Alpha', 'Beta', 'Alpha', 'Alpha', 'Gamma']], ['short', ['Alpha', 'Gamma']] ].map(([id, names]) => ({ id, category: 'list', change: '增删停靠站点并保留合法同名项',
      request: { template: '标准线路单边', dataset: { inline: { ...dataset, data: { ...dataset.data, stops: (names as string[]).map((name) => ({ name, road: 'Road' })) } } }, parameters: { currentIndex: 0 }, output: { width: 740, height: 165, dpi: 30, format: 'png' }, mode: 'draft' },
      facts: [{ id: 'stops', kind: 'texts', selector: '标准线路单边/站点面板/站点列[*]/名称区/站名', expected: names, order: 'x' }] })) });
  const run = async (name: string) => {
    const out = join(dir, name); const result = await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out]);
    return { ...result, report: await read(join(out, 'behavior.json')) };
  };
  const good = await run('list-good'); expect(good.code, JSON.stringify(good)).toBe(0);
  for (const [name, change] of Object.entries({ truncated: { slice: { start: 1, end: 2 } }, missingLast: { slice: { start: 1, end: 4 } }, reversed: { reverse: true }, merged: { mergeBy: 'name', itemLayout: { direction: 'row', widths: 'equal', spanBy: 'groupSize' } } })) {
    const candidate = structuredClone(original); Object.assign(candidate.artboard.children[1].children[0], change);
    await json(join(workspace, 'template-route-sign.json'), candidate);
    const bad = await run(`list-${name}`);
    expect(bad.code, JSON.stringify(bad)).toBe(1);
    expect(bad.report.cases[0].technical.severe, JSON.stringify(bad.report.cases[0].technical)).toBe(0);
    expect(bad.report.cases[0].facts[0].status).toBe('fail');
  }
});

it('模板参数改变后核查实际状态和下一站，忽略参数的合法模板失败', async () => {
  const workspace = join(dir, 'parameter-workspace'); await copyWorkspaceFixture(m402Dir, workspace);
  const dataset = await read(join(workspace, 'dataset-m402.json')), policy = join(dir, 'parameter.json');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'parameter-calibration', authority: '本站 1 时首站红、第二站黑；本站 2 时首站灰、第二站红',
    cases: [1, 2].map((index) => ({ id: `current-${index}`, category: 'parameter', change: `本站改为 ${index}`,
      request: { template: '标准线路单边', dataset: { inline: { ...dataset, data: { ...dataset.data, stops: [{ name: 'Alpha', road: 'Road' }, { name: 'Beta', road: 'Road' }, { name: 'Gamma', road: 'Road' }] } } }, parameters: { currentIndex: index }, output: { width: 740, height: 165, dpi: 30, format: 'png' }, mode: 'draft' },
      facts: [{ id: 'states', kind: 'colors', selector: '标准线路单边/站点面板/站点列[*]/名称区/站名', order: 'x', expected: index === 1 ? [['#E60012'], ['#333333'], ['#333333']] : [['#C8C8C8'], ['#E60012'], ['#333333']] },
        { id: 'next', kind: 'texts', selector: '标准线路单边/底栏/下一站区/下一站', order: 'x', expected: [index === 1 ? '下一站：Beta' : '下一站：Gamma'] }] })) });
  const run = async (name: string) => {
    const out = join(dir, name); const result = await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out]);
    return { ...result, report: await read(join(out, 'behavior.json')) };
  };
  const good = await run('parameter-good'); expect(good.code, JSON.stringify(good)).toBe(0);
  const file = join(workspace, 'template-route-sign.json'), template = await read(file);
  template.artboard.children[1].children[0].args.currentIndex = { value: 0 }; await json(file, template);
  const bad = await run('parameter-bad'); expect(bad.code).toBe(1);
  expect(bad.report.cases[0].technical.severe).toBe(0);
  expect(bad.report.cases[0].facts[0].status).toBe('fail');
});

it('可选信息缺失时隐藏且释放预登记空间，空白占位仍被拒绝', async () => {
  const workspace = join(dir, 'optional-workspace'); await copyWorkspaceFixture(singleTextDir, workspace);
  const schema = await read(join(workspace, 'schema-greeting-v1.json')); schema.fields.push({ name: 'note', displayName: '注记', type: 'text' }); await json(join(workspace, 'schema-greeting-v1.json'), schema);
  const compiled = await read(join(workspace, 'compiled-greeting-v1.schema.json')); compiled.properties.note = { type: 'string' }; await json(join(workspace, 'compiled-greeting-v1.schema.json'), compiled);
  const template = await read(join(workspace, 'template-greeting.json'));
  template.derived = [{ name: 'hasNote', displayName: '有注记', type: 'boolean', op: 'branch', branches: [{ when: { left: { var: 'note' }, op: 'empty' }, then: { value: false } }], otherwise: { value: true } }];
  const text = { type: 'text', font: 'res:font-hei-medium', fontSize: 8, place: { width: { fixed: 40 }, height: { fixed: 20 } } };
  template.artboard.layout = { mode: 'stack', direction: 'row' };
  template.artboard.children = [{ ...text, name: '注记', visible: { var: 'hasNote' }, content: [{ slot: 'note' }] }, { ...text, name: '问候语', content: [{ slot: 'message' }] }];
  await json(join(workspace, 'template-greeting.json'), template);
  const policy = join(dir, 'optional.json');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'optional-calibration', authority: '注记有值时占左侧40mm，缺值时问候语左移到x=0，其他样式保留',
    cases: [true, false].map((present) => ({ id: present ? 'present' : 'absent', category: 'optional', change: present ? '填入 note' : '移除 note',
      request: { template: '问候牌', dataset: { inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message: 'World', ...(present ? { note: 'Note' } : {}) } } }, parameters: {}, output: { width: 160, height: 40, dpi: 60, format: 'png' }, mode: 'draft' },
      facts: [{ id: 'note', kind: 'visibility', selector: '问候牌/注记', expected: present }, { id: 'reflow', kind: 'box', selector: '问候牌/问候语', expected: { x: present ? 40 : 0, y: 0 }, toleranceMm: 0.01 }] })) });
  const run = async (name: string) => {
    const out = join(dir, name); const result = await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out]);
    return { ...result, report: await read(join(out, 'behavior.json')) };
  };
  const good = await run('optional-good'); expect(good.code, JSON.stringify(good)).toBe(0);
  template.artboard.children[0] = { type: 'container', name: '注记', place: text.place, layout: { mode: 'free' }, children: [{ ...template.artboard.children[0], name: '注记文字' }] };
  await json(join(workspace, 'template-greeting.json'), template);
  const bad = await run('optional-bad'); expect(bad.code, JSON.stringify(bad)).toBe(1);
  expect(bad.report.cases[1].technical.severe).toBe(0);
  expect(bad.report.cases[1].facts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'reflow', status: 'fail' })]));
});

it('长文本在两个目标尺寸内保留完整文字和核准适配，移出画板或过度缩字失败', async () => {
  const workspace = join(dir, 'fit-workspace'); await copyWorkspaceFixture(singleTextDir, workspace);
  const file = join(workspace, 'template-greeting.json'), template = await read(file);
  const text = template.artboard.children[0]; text.place = { left: 8, top: 5, width: 'fill', height: { fixed: 20 } }; text.verticalAlign = 'center';
  text.fit = { steps: ['compressGlyphs', 'shrink'], minFontSize: 5, compressMin: 0.6 }; template.artboard.minFontSize = 5;
  await json(file, template);
  const policy = join(dir, 'fit.json');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'fit-calibration', authority: '完整保留 Long station name，字号5–10mm，压缩不低于0.6，文字墨迹在画板内',
    cases: [80, 160].map((width) => ({ id: `width-${width}`, category: 'fit', change: `替换为长文本并将目标宽度设为${width}mm`,
      request: { template: '问候牌', dataset: { inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message: 'Long station name' } } }, parameters: {}, output: { width, height: 40, dpi: 60, format: 'png' }, mode: 'draft' },
      facts: [{ id: 'content', kind: 'texts', selector: '问候牌/问候语', expected: ['Long station name'], order: 'x' },
        { id: 'fit', kind: 'fit', selector: '问候牌/问候语', expected: { minFontSize: 5, maxFontSize: 10, minCompression: 0.6 } }] })) });
  const run = async (name: string) => {
    const out = join(dir, name); const result = await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out]);
    return { ...result, report: await read(join(out, 'behavior.json')) };
  };
  const good = await run('fit-good'); expect(good.code, JSON.stringify(good)).toBe(0);
  template.artboard.minFontSize = 1.5; text.fontSize = 2; text.fit.minFontSize = 1.5; await json(file, template);
  const tiny = await run('fit-tiny'); expect(tiny.code).toBe(1); expect(tiny.report.cases[0].technical.severe).toBe(0);
  text.fontSize = 10; text.fit.minFontSize = 5; text.place.left = 400; text.place.width = { fixed: 144 }; await json(file, template);
  const outside = await run('fit-outside'); expect(outside.code).toBe(1); expect(outside.report.cases[0].facts[1].status).toBe('fail');
  text.place.left = 8; text.place.width = 'fill'; text.color = '#E6001200'; await json(file, template);
  const transparentInk = await run('fit-transparent-ink'); expect(transparentInk.code).toBe(1);
  expect(transparentInk.report.cases[0].facts[1]).toMatchObject({ status: 'fail', actual: [{ visibility: { status: 'invisible', reasons: ['transparent'] } }] });
  text.color = '#E60012'; text.opacity = 0; await json(file, template);
  const transparent = await run('fit-transparent'); expect(transparent.code).toBe(1);
  expect(transparent.report.cases[0].facts[1]).toMatchObject({ status: 'fail', actual: [{ visibility: { status: 'invisible', reasons: ['transparent'] } }] });
});

it('fit拒绝已证实完全遮挡和裁切，部分遮挡、部分裁切与复杂变换仍未核查', async () => {
  const workspace = join(dir, 'fit-visibility-workspace'); await copyWorkspaceFixture(singleTextDir, workspace);
  const file = join(workspace, 'template-greeting.json'), template = await read(file);
  const text = template.artboard.children[0];
  text.place = { left: 8, top: 5, width: { fixed: 140 }, height: { fixed: 20 } };
  const cover = { type: 'rect', name: '遮挡', fill: '#FFFFFF', place: { left: 0, top: 0, width: { fixed: 160 }, height: { fixed: 40 } } };
  const clip = (width: number) => ({ type: 'container', name: '裁切', clip: true, layout: { mode: 'free' },
    place: { left: 0, top: 0, width: { fixed: width }, height: { fixed: 40 } }, children: [text] });
  const policy = join(dir, 'fit-visibility.json');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'fit-visibility', authority: '独立预期：文字须满足字号和完整适配；完全不可见不能通过，复杂或部分遮挡不自动通过',
    cases: [{ id: 'visible', category: 'fit', change: '将内容改为 Long station name，目标尺寸160×40mm',
      request: { template: '问候牌', dataset: { inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message: 'Long station name' } } }, parameters: {}, output: { width: 160, height: 40, dpi: 60, format: 'png' }, mode: 'draft' },
      facts: [{ id: 'fit', kind: 'fit', selector: '问候牌/*问候语', expected: { minFontSize: 5, maxFontSize: 10, minCompression: 0.6 } }] }] });
  const run = async (name: string, children: unknown[]) => {
    template.artboard.children = children; await json(file, template);
    const out = join(dir, name), result = await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out]);
    return { ...result, report: await read(join(out, 'behavior.json')) };
  };
  const normal = await run('fit-visible-control', [cover, text]);
  expect(normal.code, JSON.stringify(normal)).toBe(0);
  expect(normal.report.cases[0].facts[0]).toMatchObject({ status: 'pass', actual: [{ visibility: { status: 'unknown' } }] });
  for (const [name, children, reason] of [
    ['fully-covered', [text, cover], 'occluded'], ['fully-clipped', [clip(4)], 'clipped'],
  ] as const) {
    const result = await run('fit-' + name, [...children]);
    expect(result.code, JSON.stringify(result)).toBe(1);
    expect(result.report.cases[0].technical.severe).toBe(0);
    expect(result.report.cases[0].facts[0]).toMatchObject({ status: 'fail', actual: [{ visibility: { status: 'invisible', reasons: [reason] } }] });
  }
  for (const [name, children] of [
    ['partial-cover', [text, { ...cover, place: { ...cover.place, width: { fixed: 35 } } }]],
    ['translucent-cover', [text, { ...cover, opacity: 0.5 }]],
    ['partial-clip', [clip(35)]], ['rotated', [{ ...text, rotation: 10 }]],
  ] as const) {
    const result = await run('fit-' + name, [...children]);
    expect(result.code, JSON.stringify(result)).toBe(3);
    expect(result.report.cases[0].facts[0]).toMatchObject({ status: 'notChecked', actual: [{ visibility: { status: 'unknown' } }] });
  }
});

it('同名图片换内容后按核准区域像素验收，名称正确或整图改变都不能掩盖错误图案', async () => {
  const ck = await loadCanvasKit();
  async function patch(file: string, left: string, right: string) {
    const surface = ck.MakeSurface(10, 10)!, paint = new ck.Paint();
    paint.setColor(ck.parseColorString(left)); surface.getCanvas().drawRect(ck.XYWHRect(0, 0, 5, 10), paint);
    paint.setColor(ck.parseColorString(right)); surface.getCanvas().drawRect(ck.XYWHRect(5, 0, 5, 10), paint);
    const image = surface.makeImageSnapshot(), bytes = image.encodeToBytes()!; await writeFile(file, bytes);
    image.delete(); paint.delete(); surface.delete();
    return createHash('sha256').update(bytes).digest('hex');
  }
  const workspace = join(dir, 'image-workspace'); await copyWorkspaceFixture(singleTextDir, workspace);
  const resources = join(dir, 'image-resources'); await mkdir(resources);
  const first = join(resources, 'first.png'), second = join(resources, 'second.png'), wrong = join(resources, 'wrong.png');
  const firstHash = await patch(first, '#FF0000', '#0000FF'), secondHash = await patch(second, '#0000FF', '#FF0000'); await patch(wrong, '#00FF00', '#00FF00');
  await json(join(resources, 'resources.json'), { resources: [{ id: 'badge', kind: 'image', file: 'first.png' }] });
  const file = join(workspace, 'template-greeting.json'), template = await read(file);
  template.artboard.children = [{ name: '图案', type: 'image', source: 'res:badge', fit: 'fill', place: { left: 2, top: 2, width: { fixed: 10 }, height: { fixed: 10 } } }]; await json(file, template);
  const policy = join(dir, 'image.json');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'image-calibration', authority: '核准10×10图案：首次左红右蓝；资源替换后左蓝右红',
    cases: [[first, firstHash], [second, secondHash]].map(([file, sha256], index) => ({ id: `image-${index}`, category: 'image', change: `同名资源badge采用核准版本${index}`,
      resources: [{ id: 'badge', file }],
      request: { template: '问候牌', dataset: { id: 'ds-greeting' }, parameters: {}, output: { width: 50, height: 20, dpi: 25.4, format: 'png' }, mode: 'draft' },
      facts: [{ id: 'approved-content', kind: 'pixels', expected: { file, sha256 }, regionMm: { x: 2, y: 2, width: 10, height: 10 }, tolerance: 0 }] })) });
  const run = async (name: string) => { const out = join(dir, name); const result = await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resources, '--out', out]); return { ...result, report: await read(join(out, 'behavior.json')) }; };
  const good = await run('image-good'); expect(good.code, JSON.stringify(good)).toBe(0);
  await json(join(resources, 'resources.json'), { resources: [{ id: 'badge', kind: 'image', file: 'first.png' }, { id: 'wrong', kind: 'image', file: 'wrong.png' }] });
  template.artboard.children[0].source = 'res:wrong'; await json(file, template);
  const bad = await run('image-bad'); expect(bad.code).toBe(1); expect(bad.report.cases[0].technical.severe).toBe(0);
  expect(bad.report.cases[0].facts[0]).toMatchObject({ status: 'fail', actual: { mismatchedPixels: 100 } });
  expect(bad.report.cases[0].evidence.resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'wrong', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
  template.artboard.children[0].source = 'res:badge'; await json(file, template);
  await writeFile(first, await readFile(wrong));
  const changedApproval = await run('image-changed-approval'); expect(changedApproval.code).toBe(3);
  expect(changedApproval.report.cases[0].facts[0]).toMatchObject({ status: 'notChecked', reason: expect.stringContaining('预登记哈希') });
});

it('匹配实例在所选排序轴重叠时保留顺序歧义，不能按内部遍历顺序制造通过', async () => {
  const workspace = join(dir, 'ambiguous-workspace'); await copyWorkspaceFixture(singleTextDir, workspace);
  const file = join(workspace, 'template-greeting.json'), template = await read(file);
  template.artboard.children.push({ ...template.artboard.children[0], name: '问候语副本' }); await json(file, template);
  const policy = join(dir, 'ambiguous.json'), out = join(dir, 'ambiguous-out');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'ambiguous-order', authority: '独立要求显示两个World且必须有可区分的横向位置', cases: [{ id: 'overlap', category: 'list', change: '核查两个同名内容实例的顺序',
    request: { template: '问候牌', dataset: { inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message: 'World' } } }, parameters: {}, output: { width: 160, height: 40, dpi: 60, format: 'png' }, mode: 'draft' },
    facts: [{ id: 'order', kind: 'texts', selector: '问候牌/问候语*', order: 'x', expected: ['World', 'World'] }] }] });
  expect(await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out])).toMatchObject({ code: 3 });
  expect((await read(join(out, 'behavior.json'))).cases[0].facts[0]).toMatchObject({ status: 'notChecked', reason: expect.stringContaining('顺序歧义') });
});

it('修改同时证明目标完成与非目标保留，未修改、越界属性和未经声明的排布变化分别失败', async () => {
  const workspace = join(dir, 'revision-workspace'), before = join(dir, 'revision-before');
  await copyWorkspaceFixture(singleTextDir, workspace); await copyWorkspaceFixture(singleTextDir, before);
  const file = join(workspace, 'template-greeting.json'), original = await read(file), policy = join(dir, 'revision.json');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'revision-calibration', authority: '只将问候语改为蓝色；位置、文字、背景均须保留',
    cases: [{ id: 'revision', category: 'revision', change: '问候语颜色从红色改为蓝色',
      request: { template: '问候牌', dataset: { id: 'ds-greeting' }, parameters: {}, output: { width: 160, height: 40, dpi: 60, format: 'png' }, mode: 'draft' },
      facts: [{ id: 'target', kind: 'colors', selector: '问候牌/问候语', order: 'x', expected: [['#0000FF']] }],
      revision: { beforeWorkspace: before, targets: ['target'], allowedChanges: [{ template: '问候牌', path: '问候牌/问候语', target: 'element', properties: ['color'] }], allowedOutputChanges: [{ selector: '问候牌/问候语', properties: ['colors'] }] } }] });
  // 第二份政策在执行前单独预登记，不能事后修改原政策来解释第一份实验失败。
  const declaredFile = join(dir, 'revision-with-reflow.json'), declared = await read(policy);
  declared.id = 'revision-with-reflow'; declared.authority = '蓝色文字允许移至x=12，其他内容不变';
  declared.cases[0].revision.allowedChanges[0].properties.push('place'); declared.cases[0].revision.allowedOutputChanges[0].properties.push('box'); await json(declaredFile, declared);
  const run = async (name: string, policyFile = policy) => { const out = join(dir, name); const result = await cli(['--behavior-policy', policyFile, '--workspace', workspace, '--resources', resourcesDir, '--out', out]); return { ...result, report: await read(join(out, 'behavior.json')) }; };
  const unmodified = await run('revision-unmodified'); expect(unmodified.code).toBe(1);
  const good = structuredClone(original); good.artboard.children[0].color = '#0000FF'; await json(file, good);
  const passed = await run('revision-good'); expect(passed.code, JSON.stringify(passed)).toBe(0);
  expect(passed.report.cases[0].revision).toMatchObject({ targets: 'pass', nonTargets: 'pass', violations: [] });
  good.artboard.fill = '#FFFFFF'; await json(file, good);
  const bad = await run('revision-background'); expect(bad.code).toBe(1);
  expect(bad.report.cases[0].revision).toMatchObject({ targets: 'pass', nonTargets: 'fail', violations: expect.arrayContaining([expect.objectContaining({ property: 'fill', path: '问候牌' })]) });
  good.artboard.fill = original.artboard.fill; good.artboard.children[0].place.left = 12; await json(file, good);
  const moved = await run('revision-moved'); expect(moved.code).toBe(1);
  expect(moved.report.cases[0].revision.outputViolations).toEqual(expect.arrayContaining([expect.objectContaining({ path: '问候牌/问候语', property: 'box' })]));
  const linked = await run('revision-allowed-reflow', declaredFile); expect(linked.code, JSON.stringify(linked)).toBe(0);
  expect(linked.report.policy.sha256).not.toBe(moved.report.policy.sha256);
});

it('无独立事实、不可测维度和复杂变换不自动通过；已有报告不能被另一份政策覆盖', async () => {
  const workspace = join(dir, 'unknown-workspace'); await copyWorkspaceFixture(singleTextDir, workspace);
  const request = { template: '问候牌', dataset: { id: 'ds-greeting' }, parameters: {}, output: { width: 160, height: 40, dpi: 60, format: 'png' }, mode: 'draft' };
  const policy = join(dir, 'unknown.json'), out = join(dir, 'unknown-out');
  await json(policy, { format: 'renderweave-behavior-policy/1', id: 'unknown', authority: '维护者已确认无可用OCR事实', cases: [{ id: 'missing', category: 'field', change: '检查问候语', request, facts: [{ id: 'not-measurable', kind: 'ocr-semantic-correctness' }] }] });
  expect(await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out])).toMatchObject({ code: 3 });
  const reportBytes = await readFile(join(out, 'behavior.json'), 'utf8');
  expect(JSON.parse(reportBytes)).toMatchObject({ status: 'notChecked', coverage: { complete: false }, cases: [{ facts: [{ status: 'notChecked' }] }] });
  expect(await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', out])).toMatchObject({ code: 2 });
  expect(await readFile(join(out, 'behavior.json'), 'utf8')).toBe(reportBytes);
  const noAuthority = await read(policy); delete noAuthority.authority; await json(policy, noAuthority);
  expect(await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', join(dir, 'no-authority')])).toMatchObject({ code: 3 });
  const empty = await read(policy); empty.authority = '独立事实尚未提供'; empty.cases[0].facts = []; await json(policy, empty);
  expect(await cli(['--behavior-policy', policy, '--workspace', workspace, '--resources', resourcesDir, '--out', join(dir, 'no-facts')])).toMatchObject({ code: 3 });
});
