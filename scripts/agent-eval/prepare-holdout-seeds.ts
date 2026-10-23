/** 两份人工准备的已有模板；只验证公开出图与单点改色，不调用 Agent 或模型。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {diffTemplate, loadWorkspace, openResourceRepository, publishStaticSchema, render, type RenderResult} from '../../src/index.js';
import {decodePixels} from '../../test/support/pixels.js';

const SEEDS = [
  {id: 'stop-name-02', stopNameZh: '梧岗宝桐路口', stopNameEn: 'Wugang Baotong Rd Crossing'},
  {id: 'stop-name-03', stopNameZh: '无名站（龙岗-沿河路）', stopNameEn: 'This is English Name'},
] as const;
const FONT = 'font-hei-medium';
const BLUE = '#0154A4', BEFORE = '#172B4D', AFTER = '#FFFFFF';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});

export interface PreparedHoldoutSeed {
  readonly id: string;
  readonly workspace: string;
  readonly correctedWorkspace: string;
  readonly request: string;
  readonly requirement: string;
  readonly allowedChange: string;
  readonly beforePreview: string;
  readonly afterPreview: string;
  readonly validation: string;
}

/** out 必须不存在；所有派生产物留在新目录，失败也不覆盖或清理已有材料。 */
export async function prepareHoldoutSeeds(options: {out: string; resources: string}): Promise<{root: string; cases: PreparedHoldoutSeed[]}> {
  const root = resolve(options.out), resources = resolve(options.resources);
  await mkdir(dirname(root), {recursive: true});
  await mkdir(root);
  const resource = await openResourceRepository(resources);
  assert.deepEqual(resource.problems, []);
  assert.equal(resource.repository.get(FONT)?.kind, 'font');
  const fontIdentity = sha256(await resource.repository.read(FONT));
  const cases: PreparedHoldoutSeed[] = [];
  for (const seed of SEEDS) {
    const dir = join(root, seed.id), name = `holdout-${seed.id}`, datasetId = `ds-${name}`;
    const workspace = join(dir, 'workspace'), correctedWorkspace = join(dir, 'corrected-workspace');
    const previewDir = join(dir, 'preview'), validationDir = join(dir, 'validation');
    await mkdir(dir);
    for (const folder of [workspace, correctedWorkspace, previewDir, validationDir]) await mkdir(folder);
    const published = publishStaticSchema({dslVersion: 'renderweave-schema/1', name, displayName: '留出站名模板修改种子',
      fields: [{name: 'stopNameZh', displayName: '中文站名', type: 'text'}, {name: 'stopNameEn', displayName: '英文原文', type: 'text'}]}, []);
    assert.deepEqual(published.problems, []);
    assert.ok(published.published);
    const dataset = {dataset: {id: datasetId, name, staticSchema: {name, version: 1}, origin: {kind: 'manual', note: '留出修订种子；原文固定，非模型产物'}},
      data: {stopNameZh: seed.stopNameZh, stopNameEn: seed.stopNameEn}};
    const template = {dslVersion: 'renderweave-template/1', name, base: {name, version: 1}, artboard: {
      sizeRange: {width: {min: 350, max: 350}, height: {min: 950, max: 950}}, fill: BLUE, layout: {mode: 'free'}, children: [
        {type: 'text', name: 'stop-name-zh', content: [{slot: 'stopNameZh'}], font: `res:${FONT}`, fontSize: 62, color: AFTER,
          writingMode: 'vertical', verticalAlign: 'distribute', horizontalAlign: 'center',
          place: {left: 165, top: 120, width: {fixed: 100}, height: {fixed: 700}}},
        {type: 'text', name: 'stop-name-en', content: [{slot: 'stopNameEn'}], font: `res:${FONT}`, fontSize: 28, color: BEFORE,
          writingMode: 'horizontal', horizontalAlign: 'start', verticalAlign: 'center', rotation: 90,
          // 旋转绕框中心(120,470)，可见列位于 x=95..145、y=120..820；英文作为一整行旋转。
          place: {left: -230, top: 445, width: {fixed: 700}, height: {fixed: 50}}},
      ]}};
    const corrected = structuredClone(template);
    corrected.artboard.children[1]!.color = AFTER;
    const expectedChanges = [{path: `${name}/stop-name-en`, target: 'element', change: 'changed', properties: [{key: 'color', before: BEFORE, after: AFTER}]}];
    assert.deepEqual(diffTemplate(template, corrected), expectedChanges);
    const commonDocuments = {'schema.json': published.published.definition, 'compiled.json': published.published.compiled, 'dataset.json': dataset};
    for (const [file, value] of Object.entries(commonDocuments)) {
      await save(join(workspace, file), value);
      await save(join(correctedWorkspace, file), value);
      assert.deepEqual(await readFile(join(workspace, file)), await readFile(join(correctedWorkspace, file)));
    }
    await save(join(workspace, 'template.json'), template);
    await save(join(correctedWorkspace, 'template.json'), corrected);
    const requestValue = {template: name, dataset: {id: datasetId}, parameters: {}, output: {width: 350, height: 950, dpi: 120, format: 'png'}, mode: 'final'};
    const request = join(dir, 'request.json'), requirement = join(dir, 'requirement.md'), allowedChange = join(dir, 'allowed-change.json');
    await save(request, requestValue);
    await writeFile(requirement, `仅修改已有模板 ${name} 的 stop-name-en 元素颜色，从 ${BEFORE} 改为 ${AFTER}。\n\n` +
      `保留其他全部模板属性、元素、数据定义、数据集、文档、参数和请求；不增删元素，不改变字体、字号、位置、旋转、中文颜色或背景。\n` +
      `中文原文逐字保留：${seed.stopNameZh}\n英文原文逐字保留：${seed.stopNameEn}\n` +
      (seed.id === 'stop-name-03' ? '英文是既有占位文字，不翻译、不替换；中文全角括号和半角连字符原样保留。\n' : '') +
      '中文逐字竖排、英文整行顺时针旋转90度；画板350×950mm，背景#0154A4。交回前通过公开检查确认完整可渲染。\n', {flag: 'wx'});
    await save(allowedChange, {format: 'renderweave-holdout-seed-change/1', id: seed.id, template: name,
      status: 'awaiting-independent-human-approval', changes: expectedChanges,
      pointer: '/artboard/children/1/color', before: BEFORE, after: AFTER,
      preserve: ['all-other-template-properties', 'schema', 'compiled-schema', 'dataset', 'request', 'literal-text'],
      baselineTemplateSha256: sha256(await readFile(join(workspace, 'template.json'))),
      correctedTemplateSha256: sha256(await readFile(join(correctedWorkspace, 'template.json')))});
    const previewRequest = join(dir, 'preview-request.json');
    await save(previewRequest, {...requestValue, mode: 'draft', output: {...requestValue.output, dpi: 40}});
    const checks: unknown[] = [];
    for (const [variant, inputDir] of [['before', workspace], ['after', correctedWorkspace]] as const) {
      const loaded = await loadWorkspace({dir: inputDir, resourcesDir: resources});
      assert.deepEqual(loaded.problems, []);
      const final = await render(loaded, requestValue, {fallbackFonts: []});
      verifyRender(final, seed, variant === 'before' ? BEFORE : AFTER);
      const preview = await render(loaded, {...requestValue, mode: 'draft', output: {...requestValue.output, dpi: 40}}, {fallbackFonts: []});
      verifyRender(preview, seed, variant === 'before' ? BEFORE : AFTER);
      await writeRender(join(validationDir, variant), final);
      await writeRender(join(previewDir, variant), preview);
      checks.push({variant, mode: 'final', dpi: 120, problems: final.problems, imageSha256: sha256(final.image!.bytes),
        widthPx: final.image!.widthPx, heightPx: final.image!.heightPx,
        preview: {mode: 'draft', dpi: 40, imageSha256: sha256(preview.image!.bytes)}});
    }
    assert.notEqual(sha256(await readFile(join(validationDir, 'before/image.png'))), sha256(await readFile(join(validationDir, 'after/image.png'))));
    const validation = join(dir, 'validation.json');
    await save(validation, {format: 'renderweave-holdout-seed-validation/1', id: seed.id, source: 'human-prepared-existing-template',
      realModelObservations: 0, sourceImagesRead: false, approval: 'pending',
      pixelChecks: await Promise.all([validationDir, previewDir].map(directory => verifyPixels(directory))),
      checks, publicTemplateChanges: diffTemplate(template, corrected), commonDocumentBytesEqual: true,
      requestSha256: sha256(await readFile(request)), font: {id: FONT, sha256: fontIdentity},
      limits: ['种子布局和字号是人工准备值，不是源图字体或精确复刻的核准真值', '完整可渲染不代表独立业务审核已通过', '英文旋转的最终可见性仍由人工预览核对']});
    cases.push({id: seed.id, workspace, correctedWorkspace, request, requirement, allowedChange,
      beforePreview: join(previewDir, 'before/image.png'), afterPreview: join(previewDir, 'after/image.png'), validation});
  }
  await save(join(root, 'manifest.json'), {format: 'renderweave-holdout-seeds/1', status: 'awaiting-independent-human-approval', cases,
    realModelObservations: 0, source: 'human-prepared-existing-templates', resources, font: {id: FONT, sha256: fontIdentity}});
  return {root, cases};
}

async function writeRender(out: string, result: RenderResult) {
  await mkdir(out);
  await writeFile(join(out, 'image.png'), result.image!.bytes, {flag: 'wx'});
  await save(join(out, 'layout.json'), result.layout);
  await save(join(out, 'problems.json'), result.problems);
}

/** 只检查公开PNG，不读取或断言渲染器中间结构。 */
async function verifyPixels(directory: string) {
  const before = await decodePixels(await readFile(join(directory, 'before/image.png')));
  const after = await decodePixels(await readFile(join(directory, 'after/image.png')));
  assert.equal(before.width, after.width);
  assert.equal(before.height, after.height);
  let changedPixels = 0, fullColorChanges = 0, preservedChineseWhitePixels = 0;
  for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
    const index = (y * before.width + x) * 4;
    const a = before.data.subarray(index, index + 4), b = after.data.subarray(index, index + 4);
    if (!a.every((channel, at) => channel === b[at])) {
      changedPixels++;
      assert.ok(x >= Math.floor(95 / 350 * before.width) - 1 && x <= Math.ceil(145 / 350 * before.width) + 1);
      assert.ok(y >= Math.floor(120 / 950 * before.height) - 1 && y <= Math.ceil(820 / 950 * before.height) + 1);
      if (a[0] === 23 && a[1] === 43 && a[2] === 77 && a[3] === 255 && b.every(channel => channel === 255)) fullColorChanges++;
    }
    if (x > before.width / 2 && a.every(channel => channel === 255) && b.every(channel => channel === 255)) preservedChineseWhitePixels++;
  }
  assert.ok(changedPixels > 0 && fullColorChanges > 0 && preservedChineseWhitePixels > 0);
  return {directory, widthPx: before.width, heightPx: before.height, changedPixels, fullColorChanges, preservedChineseWhitePixels,
    outsideAllowedEnglishColumnUnchanged: true};
}
function verifyRender(result: RenderResult, seed: typeof SEEDS[number], color: string) {
  assert.deepEqual(result.problems, []);
  assert.ok(result.image);
  const children = result.layout?.root.children;
  assert.equal(children?.length, 2);
  const zh = children!.find(node => node.name === 'stop-name-zh')!.text!;
  const en = children!.find(node => node.name === 'stop-name-en')!.text!;
  assert.equal(zh.content, seed.stopNameZh);
  assert.equal(en.content, seed.stopNameEn);
  assert.equal(zh.writingMode, 'vertical');
  assert.equal(en.writingMode, 'horizontal');
  for (const text of [zh, en]) {
    assert.equal(text.overflow, false);
    assert.equal(text.fontFallback, undefined);
    assert.equal(text.compression, 1);
  }
  assert.ok(zh.fragments.every(fragment => fragment.color === `${AFTER}FF`));
  assert.ok(en.fragments.every(fragment => fragment.color === `${color}FF`));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const {values} = parseArgs({options: {out: {type: 'string'}, resources: {type: 'string'}}, strict: true});
  if (!values.out || !values.resources) throw new Error(`用法：node --import tsx ${fileURLToPath(import.meta.url)} --out 新目录 --resources fixtures/resources`);
  const result = await prepareHoldoutSeeds({out: values.out, resources: values.resources});
  console.log(JSON.stringify(result, null, 2));
}
