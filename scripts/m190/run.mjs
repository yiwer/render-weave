// M190 Agent 运行方式验证：Claude Code（-p）加 Qwen token plan 的 Anthropic 兼容端点。
//
// 用法：node scripts/m190/run.mjs <输出目录> [--steps vision,loop,design,template] [--model qwen3.8-max] [--vision-models a,b]
//         [--scenario m402] [--domain route-sign] [--no-guide] [--max-turns 60]
//       node scripts/m190/run.mjs --evaluate <候选目录>   只评估已有数据定义与数据集候选，不调用模型
//       node scripts/m190/run.mjs --evaluate-template <工作区目录> [输出目录] [--template-name 线路牌主模板]   只评估已有模板
//   vision：直接调兼容端点，各模型转录 M402 示例图，与专家数据集对照。
//   loop：Agent 用 Read 看示例图，再调 MCP 草稿预览工具并读返回的图片。工作区副本埋了两个只在预览图上出现的标记
//         （第 23 站改名、票价改为 7），答出这两个值才算看到了工具返回的图。
//   design：Agent 拿到示例图与 DSL 参考，产出数据定义与数据集候选；引擎重新校验，再与专家版逐项对照。
//
// design 与 template 交给 Agent 的资料分三层，提示词本身不含具体业务：
//   docs/brief.md：项目说明，取 scenarios/<场景>/brief-<步骤>.md（尺寸、目标范围、命名、客户说明）；
//   docs/guide.md：通用做法，适用于任何出图场景（--no-guide 时不给，用于对照）；
//   docs/domain-<领域>.md：领域约定，--domain 指定时才给（如 route-sign）。
//   template：Agent 拿到示例图、模板 DSL 参考与专家版数据定义和数据集，写模板并用草稿预览迭代；引擎按 120 DPI 重新出图，
//             与示例图比较缩小后的像素差，再用专家版验收过的场景压测（本站位置、站数、长站名、宽度），都给出专家模板的同一指标作参照。
//
// key 只从环境变量 QWEN_TOKEN_PLAN_API_KEY 读取（Windows 上本进程没有时读用户级环境变量），不打印、不写文件。
// Claude Code 子进程的环境从空白开始，只放系统必需变量与 Qwen 配置，配置目录独立，不继承宿主的 CLAUDE_*/ANTHROPIC_* 变量与登录凭据；
// 以 --restricted 运行（无执行代码的工具，文件工具限于工作目录），只连本目录的 MCP 服务。
// 需要先 npm run build；Claude Code 可执行文件取 CLAUDE_BIN，缺省为 PATH 上的 claude。
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const ENDPOINT = 'https://token-plan.maas.qianwenaiapi.com/apps/anthropic';
// 场景：示例图与是否有专家真值。vision、loop、template 只用 m402（需要专家数据集与模板）；design 两个场景都可用。
const SCENARIOS = {
  m402: { sample: join(REPO, 'docs/examples/materials/m402-route-sign.jpg'), truth: true }, // 内容是 PNG
  366: { sample: join(REPO, 'docs/examples/materials/366-route-sign.png'), truth: false, transcription: join(HERE, 'scenarios/366/truth.json') },
};
const EXAMPLE = join(REPO, 'docs/examples/m402-dsl');
const RESOURCES = join(REPO, 'fixtures/resources');

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const out = resolve(argv[0]?.startsWith('--') ? argv[2] ?? 'out/m190' : argv[0] ?? 'out/m190');
const steps = opt('steps', 'vision,loop,design').split(',');
const model = opt('model', 'qwen3.8-max');
const visionModels = opt('vision-models', 'qwen3.8-max,qwen3.7-plus').split(',');
const scenario = opt('scenario', 'm402');
if (!SCENARIOS[scenario]) { console.error(`未知场景 ${scenario}`); process.exit(2); }
const SAMPLE = SCENARIOS[scenario].sample;
if (!SCENARIOS[scenario].truth && !argv.includes('--evaluate') && steps.some((s) => s !== 'design')) { console.error(`场景 ${scenario} 没有专家真值，只能跑 design`); process.exit(2); }
const domain = opt('domain'); // 领域约定包名，对应 domain-<名>.md
const withGuide = !argv.includes('--no-guide');

const evaluateOnly = opt('evaluate');
const evaluateTemplate = opt('evaluate-template');
const KEY = evaluateOnly || evaluateTemplate ? undefined : readKey();
const truth = JSON.parse(await readFile(join(EXAMPLE, 'dataset-m402.json'), 'utf8')).data;
await mkdir(out, { recursive: true });
const report = { model, endpoint: ENDPOINT, startedAt: new Date().toISOString() };

function readKey() {
  let key = process.env.QWEN_TOKEN_PLAN_API_KEY;
  if (!key && process.platform === 'win32') {
    key = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('QWEN_TOKEN_PLAN_API_KEY','User')"], { encoding: 'utf8' }).trim();
  }
  if (!key) { console.error('缺少环境变量 QWEN_TOKEN_PLAN_API_KEY'); process.exit(2); }
  return key;
}

function lcs(a, b) {
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] + 1 : Math.max(d[i - 1][j], d[i][j - 1]);
  return d[a.length][b.length];
}
/** 站名旁的 ①②③④ 是地标图片（M77），转录时常被并进站名；比对时分开计。 */
const CIRCLED = /[①②③④⑤⑥⑦⑧⑨]$/u;

// ---- vision ----
async function vision() {
  const raw = await readFile(SAMPLE);
  const prompt = '这是一块公交线路牌设计稿。逐字转录图中信息，只输出一个 JSON 对象，不要解释：' +
    '{"routeNo":线路号,"fare":票价数字,"fareType":票制,"operator":运营方,"firstDeparture":"HH:mm","lastDeparture":"HH:mm",' +
    '"departureTimes":["HH:mm",...],"stops":[{"name":站名,"road":所在道路},...]}。站点按图中从左到右的顺序列出全部站点。';
  const results = [];
  for (const m of visionModels) { // 逐个请求：并发时部分模型连接失败过
    const t0 = Date.now();
    const res = await fetch(`${ENDPOINT}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(600_000),
      headers: { authorization: `Bearer ${KEY}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: m, max_tokens: 16000, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: raw[0] === 0x89 ? 'image/png' : 'image/jpeg', data: raw.toString('base64') } },
        { type: 'text', text: prompt }] }] }),
    }).catch((e) => ({ ok: false, status: 'ERR', text: async () => String(e) }));
    const body = await res.text();
    await writeFile(join(out, `vision-${m}.json`), body);
    const entry = { model: m, status: res.status, ms: Date.now() - t0 };
    if (res.ok) {
      const msg = JSON.parse(body);
      const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      try {
        const j = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
        const names = (j.stops ?? []).map((s) => String(s.name));
        Object.assign(entry, {
          outputTokens: msg.usage?.output_tokens, stops: names.length,
          names: names.filter((n, i) => n.replace(CIRCLED, '') === truth.stops[i]?.name).length,
          circledSuffixes: names.filter((n) => CIRCLED.test(n)).length,
          roads: (j.stops ?? []).filter((s, i) => s.road === truth.stops[i]?.road).length,
          times: lcs(j.departureTimes ?? [], truth.departureTimes),
          header: ['routeNo', 'fare', 'fareType', 'operator', 'firstDeparture', 'lastDeparture'].filter((k) => String(j[k]) === String(truth[k])).length,
        });
      } catch { entry.error = `输出不是 JSON：${text.slice(0, 120)}`; }
    } else entry.error = body.slice(0, 200);
    console.log('vision', JSON.stringify(entry));
    results.push(entry);
  }
  return { truth: { stops: 35, roads: 35, times: 15, header: 6, landmarks: truth.stops.filter((s) => s.landmark).length }, results };
}

// ---- Claude Code 子进程 ----
async function runAgent({ name, cwd, tools, mcpTools, workspace, prompt, maxTurns }) {
  const dir = join(out, name);
  const mcpConfig = join(dir, 'mcp.json');
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { rw: { type: 'stdio', command: process.execPath, args: [
    join(HERE, 'mcp-server.mjs'), '--workspace', workspace, '--resources', RESOURCES, '--root', cwd, '--log', join(dir, 'tools.jsonl'), '--tools', mcpTools] } } }));
  const PASS = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'Path', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'TMPDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'CommonProgramFiles', 'USERNAME', 'USER', 'USERDOMAIN',
    'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG'];
  const env = Object.fromEntries(PASS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  if (process.platform !== 'win32') env.HOME = join(dir, 'home');
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: join(dir, 'cc-config'),
    ANTHROPIC_BASE_URL: ENDPOINT, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.7-plus',
    CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', API_TIMEOUT_MS: '600000',
  });
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--restricted', '--tools', tools,
    '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', 'mcp__rw', '--permission-mode', 'acceptEdits',
    '--max-turns', String(maxTurns), '--no-session-persistence'];
  const t0 = Date.now();
  const child = spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = createWriteStream(join(dir, 'stream.jsonl'));
  child.stdout.pipe(log);
  child.stderr.pipe(createWriteStream(join(dir, 'stderr.txt')));
  child.stdin.end(prompt);
  const exit = await new Promise((r) => child.on('close', r));
  await new Promise((r) => log.end(r));
  const lines = (await readFile(join(dir, 'stream.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const init = lines.find((m) => m.type === 'system' && m.subtype === 'init');
  const result = lines.find((m) => m.type === 'result');
  return {
    exit, wallMs: Date.now() - t0,
    servedModel: init?.model, tools: init?.tools, mcp: init?.mcp_servers?.map((s) => `${s.name}:${s.status}`),
    toolCalls: lines.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content.filter((c) => c.type === 'tool_use').map((c) => c.name)),
    turns: result?.num_turns, outputTokens: result?.usage?.output_tokens, subtype: result?.subtype,
    answer: result?.result ?? '',
  };
}

// ---- loop ----
async function loop() {
  const dir = join(out, 'loop'), agent = join(dir, 'agent'), workspace = join(dir, 'workspace');
  await mkdir(agent, { recursive: true });
  await mkdir(workspace, { recursive: true });
  for (const f of await readdir(EXAMPLE)) if (f.endsWith('.json') && !f.startsWith('render-request')) await copyFile(join(EXAMPLE, f), join(workspace, f));
  const dataset = JSON.parse(await readFile(join(workspace, 'dataset-m402.json'), 'utf8'));
  const markers = { currentStop: '七星瓢虫站', fare: 7 };
  dataset.data.stops[22].name = markers.currentStop; // 第 23 站，与请求中的 currentIndex 23 对应
  dataset.data.fare = markers.fare;
  await writeFile(join(workspace, 'dataset-m402.json'), JSON.stringify(dataset, null, 2));
  await copyFile(SAMPLE, join(agent, 'sample.png'));
  const run = await runAgent({ name: 'loop', cwd: agent, tools: 'Read', mcpTools: 'render_draft', workspace,
    prompt: await readFile(join(HERE, 'prompt-loop.md'), 'utf8'), maxTurns: 12 });
  const answer = run.answer;
  const verdict = {
    readSample: run.toolCalls.includes('Read') && answer.includes('M402'),
    calledRender: run.toolCalls.includes('mcp__rw__render_draft'),
    sawPreviewStop: answer.includes(markers.currentStop),
    sawPreviewFare: /7\s*元|"fare"\s*:\s*"?[^"]*7/.test(answer),
  };
  console.log('loop', JSON.stringify(verdict), `${run.wallMs} ms`);
  return { markers, verdict, pass: Object.values(verdict).every(Boolean), run };
}

// ---- 资料分层 ----
const layers = () => ({ scenario, guide: withGuide, domain: domain ?? null });
async function copyLayers(agent, step) {
  await copyFile(join(HERE, 'scenarios', scenario, `brief-${step}.md`), join(agent, 'docs/brief.md'));
  if (withGuide) await copyFile(join(HERE, 'guide.md'), join(agent, 'docs/guide.md'));
  if (domain) await copyFile(join(HERE, `domain-${domain}.md`), join(agent, `docs/domain-${domain}.md`));
}

// ---- design ----
async function design() {
  const dir = join(out, 'design'), agent = join(dir, 'agent');
  await mkdir(join(agent, 'candidates'), { recursive: true });
  await mkdir(join(agent, 'docs'), { recursive: true });
  await copyFile(SAMPLE, join(agent, 'sample.png'));
  await copyFile(join(HERE, 'dsl-reference.md'), join(agent, 'docs/dsl-reference.md'));
  await copyLayers(agent, 'design');
  const run = await runAgent({ name: 'design', cwd: agent, tools: 'Read,Write,Edit,Glob', mcpTools: 'check_definitions,check_dataset,list_resources,view_image',
    workspace: EXAMPLE, prompt: await readFile(join(HERE, 'prompt-design.md'), 'utf8'), maxTurns: 40 });
  await cp(join(agent, 'candidates'), join(dir, 'candidates'), { recursive: true });
  const evaluation = await evaluateCandidates(join(agent, 'candidates'));
  console.log('design', JSON.stringify(evaluation.dataset ?? {}), `${run.wallMs} ms`);
  return { layers: layers(), run, evaluation };
}

async function evaluateCandidates(dir) {
  const engine = await import(pathToFileURL(join(REPO, 'dist/index.js')).href);
  const { validateDataset } = await import(pathToFileURL(join(REPO, 'dist/dataset-validation.js')).href);
  const docs = await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.json')).map(async (f) => ({ f, doc: JSON.parse(await readFile(join(dir, f), 'utf8')) })));
  const defs = docs.filter((d) => String(d.doc.dslVersion ?? '').startsWith('renderweave-schema'));
  // 被引用的先发布：每轮发布所有依赖已就绪的定义。
  const published = [];
  let pending = [...defs];
  for (let round = 0; round < defs.length && pending.length; round++) {
    pending = pending.filter(({ doc }) => {
      const { published: entry } = engine.publishStaticSchema(doc, published);
      if (entry) published.push(entry);
      return !entry;
    });
  }
  const describe = (v) => v.type === 'list' ? `list<${describe(v.items)}>` : v.type === 'ref' ? `ref(${v.ref.name})` : v.type;
  const definitions = defs.map(({ f, doc }) => ({ file: f, name: doc.name, published: published.some((p) => p.ref.name === doc.name),
    fields: doc.fields.map((x) => ({ name: x.name, displayName: x.displayName, type: describe(x), constraints: x.constraints ?? {} })) }));
  const datasetDoc = docs.find((d) => d.doc.dataset && 'data' in d.doc);
  if (!datasetDoc) return { definitions, unpublished: pending.map((p) => p.f) };
  const ref = datasetDoc.doc.dataset.staticSchema;
  const target = published.find((p) => p.ref.name === ref?.name && p.ref.version === ref?.version);
  const { repository } = await engine.openResourceRepository(RESOURCES);
  const problems = target ? validateDataset(target.compiled, datasetDoc.doc.data, repository).map((p) => p.message) : ['找不到数据集选定的数据定义'];
  if (!SCENARIOS[scenario].truth) {
    const transcription = SCENARIOS[scenario].transcription && JSON.parse(await readFile(SCENARIOS[scenario].transcription, 'utf8'));
    const stops = Object.values(datasetDoc.doc.data).find((v) => Array.isArray(v) && v.length >= 2 && typeof v[0] === 'object') ?? [];
    return { definitions, unpublished: pending.map((p) => p.f), dataset: { file: datasetDoc.f, problems, ...(transcription && { transcription: scoreTranscription(stops, transcription.stops) }) } };
  }
  const data = datasetDoc.doc.data;
  const stops = Object.values(data).find((v) => Array.isArray(v) && v.length >= 20 && typeof v[0] === 'object') ?? [];
  const column = (expected) => {
    let best = { key: null, hit: 0 };
    for (const key of new Set(stops.flatMap((s) => Object.keys(s)))) {
      const hit = stops.filter((s, i) => String(s[key] ?? '').replace(CIRCLED, '') === expected[i]).length;
      if (hit > best.hit) best = { key, hit };
    }
    return best;
  };
  const times = Object.values(data).find((v) => Array.isArray(v) && v.length > 3 && v.every((t) => /^\d\d:\d\d/.test(String(t)))) ?? [];
  const values = Object.values(data).filter((v) => typeof v !== 'object').map(String);
  // 专家版的 5 条领域约定（M77、M97、M24、M30/M62 与票价拆分），逐站或逐项核对。
  const arrayKey = (pick) => [...new Set(stops.flatMap((s) => Object.keys(s)))].find((k) => stops.some((s) => Array.isArray(s[k]) && pick(s[k])));
  const badgeKey = arrayKey((v) => v.every((x) => typeof x === 'string' && !x.startsWith('res:')));
  const badgeOf = (s) => badgeKey && Array.isArray(s[badgeKey]) ? [...s[badgeKey]].sort().join('+') : '';
  const conventions = {
    landmarks: {
      matched: stops.filter((s, i) => truth.stops[i]?.landmark && Object.values(s).includes(truth.stops[i].landmark)).length,
      of: truth.stops.filter((s) => s.landmark).length,
      extra: stops.filter((s, i) => !truth.stops[i]?.landmark && Object.values(s).some((v) => String(v).startsWith('res:landmark'))).length,
    },
    badges: {
      key: badgeKey ?? null,
      matched: stops.filter((s, i) => truth.stops[i]?.badges && badgeOf(s) === [...truth.stops[i].badges].sort().join('+')).length,
      of: truth.stops.filter((s) => s.badges).length,
      extra: stops.filter((s, i) => !truth.stops[i]?.badges && (badgeOf(s) !== '' || Object.values(s).some((v) => /^res:icon-/.test(String(v))))).length,
    },
    fareIsNumber: Object.values(data).some((v) => typeof v === 'number' && v === truth.fare),
    noTerminalField: !values.includes(truth.stops.at(-1).name),
    noCurrentStop: !Object.keys(data).some((k) => /current|index/i.test(k)),
    routeNoText: values.includes(truth.routeNo),
  };
  return {
    definitions, unpublished: pending.map((p) => p.f),
    dataset: {
      file: datasetDoc.f, problems, stops: stops.length,
      names: column(truth.stops.map((s) => s.name)), roads: column(truth.stops.map((s) => s.road)),
      circledSuffixes: stops.filter((s) => Object.values(s).some((v) => typeof v === 'string' && CIRCLED.test(v))).length,
      landmarkRefs: stops.filter((s) => Object.values(s).some((v) => String(v).startsWith('res:landmark'))).length,
      times: lcs(times, truth.departureTimes), extraTimes: times.length - lcs(times, truth.departureTimes),
      conventions,
      headerValues: Object.fromEntries(['routeNo', 'fare', 'fareType', 'operator', 'firstDeparture', 'lastDeparture', 'serviceNote', 'scheduleType']
        .map((k) => [k, values.includes(String(truth[k])) ? '一致' : values.some((v) => !v.startsWith('res:') && v.includes(String(truth[k]))) ? '并入其他字段' : '缺']))
    },
  };
}

if (evaluateTemplate) {
  const request = { dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 }, output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'draft' };
  const mainTemplate = opt('template-name', '线路牌主模板');
  console.log('render', JSON.stringify(await renderAndCompare(resolve(evaluateTemplate), { ...request, template: mainTemplate }, join(out, 'render-120.png'))));
  for (const row of await stressTemplates([['候选', resolve(evaluateTemplate), mainTemplate], ['专家', EXAMPLE, '标准线路单边']], join(out, 'stress'))) console.log('stress', JSON.stringify(row));
  process.exit(0);
}
if (evaluateOnly) {
  console.log(JSON.stringify(await evaluateCandidates(resolve(evaluateOnly)), null, 1));
  process.exit(0);
}
/**
 * 按人工转录真值给站点打分（没有专家数据集的场景）。站名按名字对齐，不按位置，免得漏一站后全部错位；
 * 地标比较 res:landmark-N 的 N，设施比较文本列表（地铁、医院）。
 */
function scoreTranscription(stops, truthStops) {
  const truthNames = truthStops.map((t) => t.name);
  const nameKey = [...new Set(stops.flatMap((s) => Object.keys(s)))]
    .map((k) => [k, stops.filter((s) => truthNames.includes(String(s[k]).replace(CIRCLED, '').trim())).length]).sort((a, b) => b[1] - a[1])[0]?.[0];
  const names = stops.map((s) => String(s[nameKey] ?? '').replace(CIRCLED, '').trim());
  const byName = new Map(stops.map((s, i) => [names[i], s]));
  const landmarkOf = (s) => { const m = Object.values(s ?? {}).map(String).join(' ').match(/res:landmark-(\d+)/); return m ? Number(m[1]) : undefined; };
  const facilitiesOf = (s) => Object.values(s ?? {}).filter((v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && !x.startsWith('res:'))).flat().sort().join('+');
  const found = truthStops.filter((t) => byName.has(t.name));
  return {
    stops: `${stops.length}/${truthStops.length}`,
    namesExact: found.length, namesInOrder: lcs(names, truthNames),
    missing: truthStops.filter((t) => !byName.has(t.name)).map((t) => t.name),
    unexpected: names.filter((n) => !truthNames.includes(n)),
    landmarks: { matched: found.filter((t) => t.landmark && landmarkOf(byName.get(t.name)) === t.landmark).length, of: truthStops.filter((t) => t.landmark).length,
      extra: found.filter((t) => !t.landmark && landmarkOf(byName.get(t.name)) !== undefined).length },
    facilities: { matched: found.filter((t) => t.facilities && facilitiesOf(byName.get(t.name)) === [...t.facilities].sort().join('+')).length, of: truthStops.filter((t) => t.facilities).length,
      extra: found.filter((t) => !t.facilities && facilitiesOf(byName.get(t.name)) !== '').length },
  };
}

// ---- template ----
async function template() {
  const dir = join(out, 'template'), agent = join(dir, 'agent'), workspace = join(agent, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(agent, 'docs'), { recursive: true });
  for (const f of ['schema-stop-v1.json', 'schema-route-sign-v1.json', 'compiled-stop-v1.schema.json', 'compiled-route-sign-v1.schema.json', 'dataset-m402.json']) {
    await copyFile(join(EXAMPLE, f), join(workspace, f));
  }
  await copyFile(SAMPLE, join(agent, 'sample.png'));
  await copyFile(join(HERE, 'template-reference.md'), join(agent, 'docs/template-reference.md'));
  await copyLayers(agent, 'template');
  const run = await runAgent({ name: 'template', cwd: agent, tools: 'Read,Write,Edit,Glob', mcpTools: 'render_draft,list_resources,view_image', workspace,
    prompt: await readFile(join(HERE, 'prompt-template.md'), 'utf8'), maxTurns: Number(opt('max-turns', '60')) });
  const request = { dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 }, output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'draft' };
  const candidate = await renderAndCompare(workspace, { ...request, template: '线路牌主模板' }, join(dir, 'render-120.png'));
  const expert = await renderAndCompare(EXAMPLE, { ...request, template: '标准线路单边' }, join(dir, 'expert-120.png'));
  const templates = (await readdir(workspace)).filter((f) => f.endsWith('.json') && !/^(schema|compiled|dataset)-/.test(f));
  const stress = await stressTemplates([['候选', workspace, '线路牌主模板'], ['专家', EXAMPLE, '标准线路单边']], join(dir, 'stress'));
  console.log('template', JSON.stringify({ templates: templates.length, candidate, expert }), `${run.wallMs} ms`);
  for (const row of stress) console.log('stress', JSON.stringify(row));
  return { layers: layers(), run, templates, candidate, expert, stress };
}

/** 专家版验收过的场景：本站 0/1/末站、2/20/50 站、12 字长站名、740 与 1500 mm。草稿 30 DPI，记严重问题数与代码。 */
async function stressTemplates(subjects, dir) {
  const engine = await import(pathToFileURL(join(REPO, 'dist/index.js')).href);
  await mkdir(dir, { recursive: true });
  const base = JSON.parse(await readFile(join(EXAMPLE, 'dataset-m402.json'), 'utf8'));
  const stops = base.data.stops;
  const extra = Array.from({ length: 15 }, (_, i) => ({ name: ['新城', '科技', '文化', '体育', '滨海'][i % 5] + ['东', '西', '南'][Math.floor(i / 5)] + '站', road: i < 8 ? '新城大道' : '滨海路' }));
  const withStops = (list) => ({ dataset: { staticSchema: base.dataset.staticSchema }, data: { ...base.data, stops: list } });
  const scenarios = [
    ['35 站本站 5', stops, 5, 740], ['本站 0', stops, 0, 740], ['本站 1', stops, 1, 740], ['本站 35', stops, 35, 740],
    ['2 站', stops.slice(0, 2), 1, 740], ['20 站', stops.slice(0, 20), 5, 740], ['50 站 740', [...stops, ...extra], 5, 740],
    ['50 站 1500', [...stops, ...extra], 5, 1500], ['35 站 1500', stops, 5, 1500],
    ['12 字站名', stops.map((s, i) => (i === 10 ? { ...s, name: '李朗国际珠宝园北门公交站' } : s)), 5, 740],
  ];
  const rows = [];
  for (const [label, list, currentIndex, width] of scenarios) {
    const row = { label };
    for (const [who, workspaceDir, template] of subjects) {
      const workspace = await engine.loadWorkspace({ dir: workspaceDir, resourcesDir: RESOURCES });
      const r = await engine.render(workspace, { template, dataset: { inline: withStops(list) }, parameters: { currentIndex },
        output: { width, height: 165, dpi: 30, format: 'png' }, mode: 'draft' });
      const severe = r.problems.filter((p) => p.level === 'severe');
      row[who] = { severe: severe.length, hint: r.problems.length - severe.length, codes: [...new Set(severe.map((p) => p.code))] };
      if (r.image) await writeFile(join(dir, `${who}-${label.replace(/\s+/g, '-')}.png`), r.image.bytes);
    }
    rows.push(row);
  }
  return rows;
}

/** 草稿出图（有严重问题也出图），按 8 倍缩小后与示例图逐像素比较：相似度 = 1 − 平均绝对差 / 255。 */
async function renderAndCompare(workspaceDir, request, file) {
  const engine = await import(pathToFileURL(join(REPO, 'dist/index.js')).href);
  const { loadCanvasKit } = await import(pathToFileURL(join(REPO, 'dist/canvaskit.js')).href);
  const workspace = await engine.loadWorkspace({ dir: workspaceDir, resourcesDir: RESOURCES });
  const result = await engine.render(workspace, request);
  const problems = { severe: result.problems.filter((p) => p.level === 'severe').length, hint: result.problems.filter((p) => p.level === 'hint').length };
  if (!result.image) return { problems, image: false };
  await writeFile(file, result.image.bytes);
  const ck = await loadCanvasKit();
  const shrink = (bytes) => {
    const image = ck.MakeImageFromEncoded(bytes);
    const surface = ck.MakeSurface(437, 98);
    surface.getCanvas().drawImageRect(image, ck.XYWHRect(0, 0, image.width(), image.height()), ck.XYWHRect(0, 0, 437, 98), new ck.Paint());
    const pixels = surface.makeImageSnapshot().readPixels(0, 0, { width: 437, height: 98, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
    image.delete(); surface.delete();
    return pixels;
  };
  const a = shrink(result.image.bytes), b = shrink(await readFile(SAMPLE));
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) { sum += Math.abs(a[i + c] - b[i + c]); n++; }
  return { problems, size: `${result.image.widthPx}×${result.image.heightPx}`, similarity: Number((1 - sum / n / 255).toFixed(4)),
    ...(result.layout && { landmarkBaseline: landmarkBaseline(result.layout) }), roadAlign: await roadAlign(workspaceDir) };
}

/**
 * 用户验收发现的版面约定一（领域约定 10）：地标是竖排站名的最后一格。无地标站名的底边应与有地标列的地标底边齐平。
 * 取第 1 站（建设路总站，无地标）与第 4 站（门诊部，有地标）比较，差值单位毫米。
 */
function landmarkBaseline(layout) {
  const nodes = [];
  (function walk(n) { nodes.push(n); for (const c of n.children ?? []) walk(c); })(layout.root);
  const visible = nodes.filter((n) => n.visible !== false && typeof n.y === 'number');
  // 比较前去掉首尾空白（含全角空格）：有的模板用空格给地标占位。
  const name = (content) => visible.find((n) => n.type === 'text' && n.text?.content?.trim() === content && n.text?.writingMode === 'vertical');
  const plain = name(truth.stops[0].name), marked = name(truth.stops[3].name);
  if (!plain || !marked) return { found: false };
  const prefix = marked.path.slice(0, marked.path.lastIndexOf(']') + 1);
  const landmark = visible.filter((n) => n.type === 'image' && n.path.startsWith(prefix) && n.y >= marked.y).sort((a, b) => b.y - a.y)[0];
  if (!landmark) return { found: false, reason: '有地标的列中找不到地标图片' };
  const delta = Number((plain.y + plain.height - (landmark.y + landmark.height)).toFixed(2));
  return { found: true, deltaMm: delta, pass: Math.abs(delta) <= 2 };
}

/** 用户验收发现的版面约定二（领域约定 11，M131）：道路名用同间隔分布。静态检查模板中插槽绑定 road 的文字元素。 */
async function roadAlign(workspaceDir) {
  const aligns = [];
  for (const f of await readdir(workspaceDir)) {
    if (!f.endsWith('.json')) continue;
    const doc = JSON.parse(await readFile(join(workspaceDir, f), 'utf8'));
    if (doc.dslVersion !== 'renderweave-template/1') continue;
    (function walk(v) {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== 'object') return;
      if (v.type === 'text' && Array.isArray(v.content) && v.content.some((c) => typeof c.slot === 'string' && /(^|\.)road$/.test(c.slot))) aligns.push(v.horizontalAlign ?? 'start');
      Object.values(v).forEach(walk);
    })(doc);
  }
  return { aligns, pass: aligns.length > 0 && aligns.every((a) => a === 'spaceEvenly') };
}

for (const step of steps) {
  if (step === 'vision') report.vision = await vision();
  else if (step === 'loop') report.loop = await loop();
  else if (step === 'design') report.design = await design();
  else if (step === 'template') report.template = await template();
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`报告：${join(out, 'report.json')}`);
