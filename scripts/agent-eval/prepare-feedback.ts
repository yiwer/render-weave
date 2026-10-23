/** 生成可冻结的双语四任务合成校准输入；不调用模型、不使用用户留出素材。 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {loadWorkspace, render, runAgentTask, publishStaticSchema, type AgentTaskId} from '../../src/index.js';
import {REPO, type FeedbackScenario} from './scenarios.js';
const {values} = parseArgs({options: {out: {type: 'string'}, resources: {type: 'string'}}, strict: true});
if (!values.out || !values.resources) throw new Error('需要 --out 新目录与 --resources 资源仓库');
const root = resolve(values.out), resources = resolve(values.resources);
await mkdir(root); // 绝不覆盖已经准备或观测过的输入。
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const scenarios: FeedbackScenario[] = [];
for (const language of ['zh', 'en'] as const) {
  const lang = join(root, language); await mkdir(lang);
  const correctText = language === 'zh' ? '科技园' : 'Science Park', wrongText = language === 'zh' ? '科枝园' : 'Science Pork';
  const name = `calibration-${language}`;
  const definition = {dslVersion: 'renderweave-schema/1', name, displayName: language === 'zh' ? '校准站名' : 'Calibration stop',
    fields: [{name: 'routeNo', displayName: language === 'zh' ? '线路号' : 'Route number', type: 'text'},
      {name: 'stopName', displayName: language === 'zh' ? '站名' : 'Stop name', type: 'text'}]};
  const published = publishStaticSchema(definition, []); assert.deepEqual(published.problems, []); assert.ok(published.published);
  const dataset = {dataset: {id: `ds-${name}`, name, staticSchema: {name, version: 1}, origin: {kind: 'manual', note: '合成校准'}}, data: {routeNo: '22', stopName: correctText}};
  const template = {dslVersion: 'renderweave-template/1', name, base: {name, version: 1}, artboard: {fill: '#FFFFFF',
    sizeRange: {width: {min: 220, max: 220}, height: {min: 155, max: 155}}, layout: {mode: 'free'},
    children: Array.from({length: 24}, (_, index) => ({type: 'text', name: `region-${String(index + 1).padStart(2, '0')}`,
      content: [{text: index === 21 ? correctText : language === 'zh' ? `校准${String(index + 1).padStart(2, '0')}` : `Stop${String(index + 1).padStart(2, '0')}`}],
      font: 'res:font-hei-regular', fontSize: 7, color: '#172B4D', place: {left: 10 + index % 4 * 50, top: 8 + Math.floor(index / 4) * 23, width: {fixed: 45}, height: {fixed: 18}}}))}};
  const request = {template: name, dataset: {id: dataset.dataset.id}, parameters: {}, output: {width: 220, height: 155, dpi: 100, format: 'png'}, mode: 'final'};
  const referenceWorkspace = join(lang, 'reference-workspace'); await mkdir(referenceWorkspace);
  await save(join(referenceWorkspace, 'schema.json'), published.published.definition); await save(join(referenceWorkspace, 'compiled.json'), published.published.compiled); await save(join(referenceWorkspace, 'dataset.json'), dataset);
  const workspace = await loadWorkspace({dir: referenceWorkspace, resourcesDir: resources}); assert.deepEqual(workspace.problems, []);
  const rendered = await render({...workspace, templates: [{name, document: template}]}, {...request, mode: 'draft'}, {comparisonEvidence: true});
  assert.deepEqual(rendered.problems, []); assert.ok(rendered.evidence);
  const {image, nodes} = rendered.evidence;
  const sample = join(lang, 'sample.png'); await writeFile(sample, image.bytes);
  const reference = {sampleWidthPx: image.widthPx, sampleHeightPx: image.heightPx, artboardWidthMm: 220, artboardHeightMm: 155,
    sampleSha256: createHash('sha256').update(image.bytes).digest('hex'), complete: false,
    approvedRegions: template.artboard.children.map(node => {const ink = nodes.find(item => item.path === `${name}/${node.name}`)!.inkBounds!;
      return {id: node.name, name: node.name, targetPathPattern: `${name}/${node.name}`, boxKind: 'ink', state: 'normal',
        sampleRegion: {x: ink.x * image.widthPx / 220, y: ink.y * image.heightPx / 155, width: ink.width * image.widthPx / 220, height: ink.height * image.heightPx / 155},
        expectedFontSizeMm: node.fontSize, expectedText: node.content[0]!.text, expectedColor: node.color, positionToleranceMm: 0.5};})};
  const referenceFile = join(lang, 'reference.json'); await save(referenceFile, reference);
  for (const task of ['definition-extraction', 'dataset-extraction', 'template-design', 'template-revision'] as AgentTaskId[]) {
    const id = `${language}-${task}`, dir = join(lang, task); await mkdir(dir);
    const visual = task.startsWith('template'), definitionTask = task === 'definition-extraction';
    const candidate = `candidates/${visual ? 'template' : definitionTask ? 'definition' : 'dataset'}.json`;
    const corrected = structuredClone(visual ? template : definitionTask ? definition : dataset) as any;
    const initial = structuredClone(corrected);
    const changes = visual ? [{pointer: '/artboard/children/21/content/0/text', before: wrongText, after: correctText},
      {pointer: '/artboard/children/21/fontSize', before: 5, after: 7}, {pointer: '/artboard/children/21/color', before: '#FF0000', after: '#172B4D'},
      {pointer: '/artboard/children/21/place/left', before: 63, after: 60}]
      : definitionTask ? [{pointer: '/fields/1/name', before: 'stpoName', after: 'stopName'}] : [{pointer: '/data/stopName', before: wrongText, after: correctText}];
    if (visual) {const node = initial.artboard.children[21]; node.content[0].text = wrongText; node.fontSize = 5; node.color = '#FF0000'; node.place.left = 63;}
    else if (definitionTask) initial.fields[1].name = 'stpoName'; else initial.data.stopName = wrongText;
    const policy = join(dir, 'policy.json'); await save(policy, {format: 'renderweave-feedback-policy/1', candidate, corrections: changes,
      unknownIds: visual ? ['unmeasured-dimensions'] : ['unapproved-semantics'], ...(visual ? {requiredLaterPageRegion: 'region-22'} : {})});
    const brief = join(dir, 'brief.md'), feedback = join(dir, 'feedback.md');
    await writeFile(brief, language === 'zh' ? '这是预先定义真值的合成校准任务。线路号22，站名科技园。保留其余结构和内容，未核准部分不得宣称正确。' : 'Synthetic calibration with predefined facts: route number 22, stop name Science Park. Preserve other content and structure; unapproved semantics remain unknown.');
    await writeFile(feedback, visual ? `仅修正 ${name}/region-22 的文字、字号、颜色、横向位置；其余内容原样保留。参考目录超过20项，沿nextRegionOffset取得后续页，再点查region-22。修改后重新compare_reference并check_outcome。未测维度保持未知。`
      : definitionTask ? '仅把第二个字段名stpoName修正为stopName；其他内容保持原样。未核准语义保持未知。交回前check_outcome。'
      : `仅把stopName修正为${correctText}，其他内容保持原样。未核准语义保持未知。交回前check_outcome。`);
    const preset = join(dir, 'controlled-initial'); await mkdir(join(preset, 'candidates'), {recursive: true});
    await save(join(preset, candidate), initial); await save(join(preset, 'outcome.json'), {candidates: [candidate], pending: [], notes: '受控初始缺陷；不是模型观测'});
    const baseline = join(dir, 'content-baseline.json');
    if (!visual) await save(baseline, {name: id, items: [{id: 'stop-name', label: '核准站名', ...(definitionTask ? {definition: name, field: 'stopName'} : {values: [{path: 'stopName', value: correctText}]})}, {id: 'unapproved-semantics', label: '未核准语义'}]});
    const dirWorkspace = join(dir, 'workspace'); await mkdir(dirWorkspace);
    if (!definitionTask) {await save(join(dirWorkspace, 'schema.json'), published.published.definition); await save(join(dirWorkspace, 'compiled.json'), published.published.compiled);}
    if (visual) await save(join(dirWorkspace, 'dataset.json'), dataset);
    if (task === 'template-revision') await save(join(dirWorkspace, 'template.json'), initial);
    const requestFile = join(dir, 'request.json'); if (visual) await save(requestFile, request);
    const seedRound = join(dir, 'seed');
    await runAgentTask({task, sample, brief, resources, out: seedRound, ...(visual ? {reference: referenceFile, request: requestFile, dataset: dataset.dataset.id} : {contentBaseline: baseline}),
      ...(!definitionTask ? {workspace: dirWorkspace} : {}), ...(task === 'dataset-extraction' ? {definition: name} : {}),
      ...(task === 'template-revision' ? {requirement: feedback} : {}), key: 'controlled-seed-no-network', keyEnv: 'CONTROLLED_SEED',
      claude: {command: process.execPath, args: [join(REPO, 'scripts/agent-eval/seed-executor.mjs'), preset]}});
    scenarios.push({id, name: id, kind: 'feedback', language, task, sample, brief, seedRound, feedback, policy,
      ...(visual ? {reference: referenceFile} : {contentBaseline: baseline}), pass: {targetCorrection: true, nonTargetPreservation: true, unknownRetained: true}});
  }
}
await save(join(root, 'config.json'), {format: 'renderweave-agent-eval-config/2', consecutivePasses: 2, resources, evidence: 'mechanism', scenarios});
await save(join(root, 'preparation.json'), {format: 'renderweave-feedback-preparation/1', source: 'predeclared-synthetic-facts', realModelObservations: 0,
  limits: ['初始缺陷由受控执行器提交，不是模型首次产物', '仅修正观测计入后续真实模型计划', '没有使用12张留出素材', '合成区域测量不证明真实照片标注质量']});
console.log(`已准备8类、16单元校准输入：${root}`);
