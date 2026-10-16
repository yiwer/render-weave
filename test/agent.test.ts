/**
 * `renderweave agent run` 的流程测试（第三阶段票据 04、验收 A05、A06）：用假执行器代替 Claude Code，不调用模型。
 * 成果校验入口 checkAgentOutcome 用构造的工作目录覆盖结构不合格的各种情形。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { checkAgentOutcome, createMemoryResourceRepository, runAgentTask, workspaceFingerprint, type AgentRunOptions } from '../src/index.js';
import { repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
const KEY = `rw-test-key-${Math.random().toString(36).slice(2)}`;
const BRIEF = '# 项目说明：示例会议胸牌\n\n- 业务：会议胸牌。\n- 尺寸：90 × 130 mm。\n';

const BADGE = { dslVersion: 'renderweave-schema/1', name: '胸牌', fields: [
  { name: 'fullName', displayName: '姓名', type: 'text', constraints: { required: true } },
  { name: 'role', displayName: '身份', type: 'text' },
  { name: 'session', displayName: '场次', type: 'ref', ref: { name: '场次', version: 1 } },
] };
const SESSION = { dslVersion: 'renderweave-schema/1', name: '场次', fields: [{ name: 'title', displayName: '标题', type: 'text' }] };
const GREETING = { dslVersion: 'renderweave-schema/1', name: '问候', fields: [{ name: 'message', displayName: '问候语', type: 'text' }, { name: 'emoji', displayName: '表情', type: 'text' }] };
const SUBMISSION = {
  candidates: ['candidates/schema-badge.json', 'candidates/schema-session.json', 'candidates/schema-greeting.json'],
  pending: [{ file: 'candidates/schema-badge.json', path: 'role', candidate: ['讲者', '嘉宾'], reason: 'inferred', note: '图上只有讲者' }],
  notes: '字段与图上位置的对应见下。',
};

let base: string, brief: string, sample: string;
let count = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-agent-'));
  brief = join(base, 'brief.md');
  await writeFile(brief, BRIEF);
  sample = join(resourcesDir, 'images/test/quadrants.png');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 写一个预置成果目录：文件名到内容（对象按 JSON 写）。 */
async function preset(files: Record<string, unknown>): Promise<string> {
  const dir = join(base, `preset-${++count}`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const qualified = () => preset({
  'outcome.json': SUBMISSION,
  'candidates/schema-badge.json': BADGE, 'candidates/schema-session.json': SESSION, 'candidates/schema-greeting.json': GREETING,
  'scratch/dataset-draft.json': { dataset: { staticSchema: { name: '胸牌', version: 1 } }, data: {} },
});

function run(presetDir: string, overrides: Partial<AgentRunOptions> = {}) {
  return runAgentTask({
    task: 'definition-extraction', sample, brief, resources: resourcesDir, out: join(base, `round-${++count}`), key: KEY, keyEnv: 'RW_TEST_KEY',
    claude: { command: process.execPath, args: [FAKE, presetDir] }, ...overrides,
  });
}

async function filesUnder(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) result.push(join(entry.parentPath, entry.name));
  return result;
}

describe('发起一轮数据定义提取', () => {
  it('轮次目录组装三层资料、DSL 参考、示例图与工作区快照；提示词不含具体业务', async () => {
    const result = await run(await qualified(), { domain: 'route-sign', workspace: singleTextDir });
    const agent = join(result.roundDir, 'agent');
    const read = (path: string) => readFile(path, 'utf8');
    expect(await read(join(agent, 'docs/brief.md'))).toBe(BRIEF);
    expect(await read(join(agent, 'docs/guide.md'))).toBe(await read(join(repoRoot, 'agent/guide.md')));
    expect(await read(join(agent, 'docs/domain-route-sign.md'))).toBe(await read(join(repoRoot, 'agent/domains/route-sign.md')));
    expect(await read(join(agent, 'docs/dsl-reference.md'))).toBe(await read(join(repoRoot, 'agent/reference/data-definition.md')));
    expect(await read(join(agent, 'docs/outcome.md'))).toBe(await read(join(repoRoot, 'agent/reference/outcome.md')));
    expect(await readFile(join(agent, 'sample.png'))).toEqual(await readFile(sample));
    expect((await readdir(join(result.roundDir, 'snapshot'))).sort()).toEqual((await readdir(singleTextDir)).filter((file) => file.endsWith('.json')).sort());

    const fake = JSON.parse(await read(join(agent, 'fake-run.json')));
    expect(fake.prompt).toBe((await read(join(repoRoot, 'agent/tasks/definition-extraction.md'))).replaceAll('{sample}', 'sample.png'));
    expect(fake.prompt).not.toMatch(/线路|站名|胸牌|M402/);

    // 示例图按文件头定扩展名：M402 示例图的文件名是 .jpg，内容是 PNG。
    const m402 = await run('none', { sample: join(repoRoot, 'docs/examples/materials/m402-route-sign.jpg') });
    expect(m402.record.inputs.sample.file).toBe('agent/sample.png');
    expect(JSON.parse(await read(join(m402.roundDir, 'agent/fake-run.json'))).prompt).toContain('sample.png');
  });

  it('按受限模式启动，只连 renderweave mcp；子进程没有宿主的 CLAUDE_*、ANTHROPIC_* 变量，产物中没有 key', async () => {
    const saved = { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'], CLAUDE_CODE_HOST_FLAG: process.env['CLAUDE_CODE_HOST_FLAG'], ANTHROPIC_BASE_URL: process.env['ANTHROPIC_BASE_URL'] };
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'host-secret', CLAUDE_CODE_HOST_FLAG: '1', ANTHROPIC_BASE_URL: 'https://host.example' });
    let result;
    try {
      result = await run(await qualified(), { model: 'model-x', endpoint: 'https://endpoint.example/anthropic', maxTurns: 9 });
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const agent = join(result.roundDir, 'agent'), logs = join(result.roundDir, 'logs');
    const fake = JSON.parse(await readFile(join(agent, 'fake-run.json'), 'utf8'));
    expect(fake.env.filter((name: string) => /^(CLAUDE|ANTHROPIC)_/i.test(name))).toEqual([
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CONFIG_DIR',
    ]);
    expect(fake).toMatchObject({ hasToken: true, model: 'model-x', baseUrl: 'https://endpoint.example/anthropic', configDir: join(logs, 'claude-config') });
    expect(fake.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'model-x', '--restricted', '--tools', 'Read,Write,Edit,Glob',
      '--mcp-config', join(logs, 'mcp.json'), '--strict-mcp-config', '--allowedTools', 'mcp__rw', '--permission-mode', 'acceptEdits',
      '--max-turns', '9', '--no-session-persistence']);
    const mcp = JSON.parse(await readFile(join(logs, 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['rw']);
    expect(mcp.mcpServers.rw.args.slice(1)).toEqual(['mcp', '--workspace', join(result.roundDir, 'snapshot'), '--resources', resourcesDir, '--root', agent,
      '--log', join(logs, 'tools.jsonl'), '--tools', 'list_documents,read_document,list_resources,check_definitions,check_dataset,view_image,dsl_reference']);
    expect(mcp.mcpServers.rw.args[0]).toMatch(/bin\.js$/);

    const leaks = [];
    for (const file of await filesUnder(result.roundDir)) if ((await readFile(file)).includes(KEY)) leaks.push(file);
    expect(leaks).toEqual([]);
    expect(result.record.runtime.keyEnv).toBe('RW_TEST_KEY');
  });

  it('合格的成果：outcome.json 带任务与轮次、输入哈希、候选、待确认项与用量；数据定义按依赖顺序发布，版本接在快照之后', async () => {
    const result = await run(await qualified(), { workspace: singleTextDir });
    expect(result.check.verdict).toBe('qualified');
    expect(result.check.problems).toEqual([]);
    const outcome = JSON.parse(await readFile(join(result.roundDir, 'outcome.json'), 'utf8'));
    expect(outcome).toEqual(result.outcome);
    expect(outcome.format).toBe('renderweave-outcome/1');
    expect(outcome).toMatchObject({ task: 'definition-extraction', round: 1, notes: SUBMISSION.notes, pending: SUBMISSION.pending,
      inputs: { workspaceFingerprint: await workspaceFingerprint(singleTextDir), previous: null } });
    expect(outcome.inputs.sampleSha256).toBe(result.record.inputs.sample.sha256);
    expect(outcome.candidates.map((candidate: { path: string; published: unknown }) => [candidate.path, candidate.published])).toEqual([
      ['candidates/schema-badge.json', { name: '胸牌', version: 1 }],
      ['candidates/schema-session.json', { name: '场次', version: 1 }],
      ['candidates/schema-greeting.json', { name: '问候', version: 2 }],
    ]);
    for (const candidate of outcome.candidates) {
      expect(await readFile(join(result.roundDir, candidate.path), 'utf8')).toBe(await readFile(join(result.roundDir, 'agent', candidate.path), 'utf8'));
    }
    expect(outcome.usage).toMatchObject({ turns: 7, inputTokens: 11, outputTokens: 222, cacheReadTokens: 33, cacheCreationTokens: 44,
      servedModel: 'qwen3.8-max', claudeCodeVersion: 'fake-1', endedBy: 'success' });
    expect(result.record).toMatchObject({ format: 'renderweave-round/1', verdict: 'qualified',
      run: { exitCode: 0, mcp: ['rw:connected'] }, runtime: { model: 'qwen3.8-max', maxTurns: 40 },
      inputs: { domain: null, workspace: { documents: 5 } } });
    expect(JSON.parse(await readFile(join(result.roundDir, 'check.json'), 'utf8'))).toMatchObject({ verdict: 'qualified', problems: [] });
  });

  it('不合格：没有交回 outcome.json、执行器无法启动、候选有严重问题；都给出问题清单且不重试', async () => {
    const none = await run('none');
    expect(none.check.verdict).toBe('unqualified');
    expect(none.check.problems.map((problem) => problem.code)).toEqual(['outcome.invalid']);
    expect(none.outcome).toBeUndefined();
    expect(await readdir(none.roundDir)).not.toContain('outcome.json');
    expect(JSON.parse(await readFile(join(none.roundDir, 'round.json'), 'utf8')).verdict).toBe('unqualified');

    const missing = await run('none', { claude: { command: join(base, 'no-such-claude') } });
    expect(missing.record.run.exitCode).toBeNull();
    expect(missing.record.run.error).toContain('无法启动');
    expect(missing.check.verdict).toBe('unqualified');

    // 模型服务报错（如额度用完）时 Claude Code 的结束方式仍是 success：错误记进轮次记录，不能只说没有交回 outcome.json。
    const quota = await run(await preset({ '.api-error': 'API Error: Request rejected (429) · Your token-plan 1-month quota has been exhausted.' }));
    expect(quota.record.run).toMatchObject({ endedBy: 'success', error: '模型服务报错：API Error: Request rejected (429) · Your token-plan 1-month quota has been exhausted.' });
    expect(quota.check.verdict).toBe('unqualified');
    expect((await run(await preset({}))).record.run).not.toHaveProperty('error');

    const conflict = await run(await preset({
      'outcome.json': { candidates: ['candidates/schema-badge.json'], pending: [], notes: '说明' },
      'candidates/schema-badge.json': { ...SESSION, fields: [{ name: 'title', displayName: '标题', type: 'text', constraints: { minLength: 5, maxLength: 2 } }] },
    }));
    expect(conflict.check.verdict).toBe('unqualified');
    expect(conflict.check.problems).toEqual([]);
    expect(conflict.check.candidates[0]!.problems.map((problem) => problem.code)).toEqual(['definition.constraintConflict']);
    expect(conflict.outcome?.candidates[0]).not.toHaveProperty('published');
  });
});

describe('成果校验入口', () => {
  async function agentDir(files: Record<string, unknown>): Promise<string> {
    return preset(files);
  }
  const check = async (files: Record<string, unknown>) => {
    const result = await checkAgentOutcome({ task: 'definition-extraction', agentDir: await agentDir(files), workspace: { staticSchemas: [], templates: [], datasets: [], problems: [], resources: createMemoryResourceRepository([]) } });
    return { verdict: result.verdict, messages: result.problems.map((problem) => `${(problem.location as { source: string }).source}：${problem.message}`) };
  };
  const definitions = { 'candidates/schema-badge.json': BADGE, 'candidates/schema-session.json': SESSION };

  it('成果格式文档（交给 Agent 的资料）中的示例结构合格', async () => {
    const text = await readFile(join(repoRoot, 'agent/reference/outcome.md'), 'utf8');
    const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)![1]!);
    expect(example.locations.length).toBeGreaterThan(0);
    const badge = { ...BADGE, fields: [...BADGE.fields, { name: 'seat', displayName: '座位排号', type: 'number' }] };
    expect(await check({ 'candidates/schema-badge.json': badge, 'candidates/schema-session.json': SESSION, 'outcome.json': example }))
      .toEqual({ verdict: 'qualified', messages: [] });
  });

  it('图上位置对不上时只记提示：结论仍为合格，成果照常写出', async () => {
    const result = await checkAgentOutcome({ task: 'definition-extraction', agentDir: await agentDir({ ...definitions, 'outcome.json': {
      candidates: ['candidates/schema-session.json'], pending: [], notes: '说明',
      locations: [{ file: 'candidates/schema-session.json', path: 'room', where: '底部' }, { file: 'candidates/schema-badge.json', where: '整张' }],
    } }), workspace: { staticSchemas: [], templates: [], datasets: [], problems: [], resources: createMemoryResourceRepository([]) } });
    expect(result.verdict).toBe('qualified');
    expect(result.submission).toBeDefined();
    expect(result.problems.map((problem) => [problem.level, problem.message])).toEqual([
      ['hint', '数据定义"场次"中没有字段 room（图上位置只作参考，不影响结论）'],
      ['hint', '图上位置指向的文件不在候选中：candidates/schema-badge.json（图上位置只作参考，不影响结论）'],
    ]);
  });

  it('结构合格：只看 outcome.json 与候选，不看草稿', async () => {
    expect(await check({ ...definitions, 'outcome.json': { candidates: ['candidates/schema-session.json', 'candidates/schema-badge.json'], pending: [], notes: '说明' } }))
      .toEqual({ verdict: 'qualified', messages: [] });
  });

  it.each([
    ['不是 JSON', '{', ['outcome.json：没有交回可读的 outcome.json：不是有效的 JSON：outcome.json']],
    ['缺少说明', { candidates: ['candidates/schema-session.json'], pending: [] }, ['outcome.json：outcome.json 缺少 notes']],
    ['原因不在四类中', { candidates: ['candidates/schema-session.json'], pending: [{ file: 'candidates/schema-session.json', reason: 'guess', note: '说明' }], notes: '说明' },
      ['outcome.json#pending.0.reason：pending.0.reason 只能取 unreadable、inferred、conflicting、requiredMissing']],
    ['多余的键', { candidates: ['candidates/schema-session.json'], pending: [], notes: '说明', score: 1 }, ['outcome.json：outcome.json 不能有 score']],
    ['候选为空', { candidates: [], pending: [], notes: '说明' }, ['outcome.json#candidates：candidates 至少要有 1 项']],
    ['候选不在 candidates/ 下', { candidates: ['scratch/schema.json'], pending: [], notes: '说明' },
      ['outcome.json#candidates[1]：候选文件要放在 candidates/ 下，且是 .json 文件：scratch/schema.json']],
    ['候选越出工作目录', { candidates: ['../outside.json'], pending: [], notes: '说明' }, ['outcome.json#candidates[1]：只能读取工作目录内的文件：../outside.json']],
    ['候选不存在', { candidates: ['candidates/missing.json'], pending: [], notes: '说明' }, ['outcome.json#candidates[1]：文件不存在：candidates/missing.json']],
    ['候选不是数据定义', { candidates: ['candidates/dataset.json'], pending: [], notes: '说明' },
      ['outcome.json#candidates[1]：数据定义提取的候选只能是数据定义：candidates/dataset.json']],
    ['待确认项指向非候选文件', { candidates: ['candidates/schema-session.json'], pending: [{ file: 'candidates/schema-badge.json', reason: 'inferred', note: '说明' }], notes: '说明' },
      ['outcome.json#pending[1]：待确认项指向的文件不在候选中：candidates/schema-badge.json']],
    ['待确认项的字段不存在', { candidates: ['candidates/schema-session.json'], pending: [{ file: 'candidates/schema-session.json', path: 'room', reason: 'unreadable', note: '说明' }], notes: '说明' },
      ['outcome.json#pending[1]：数据定义"场次"中没有字段 room']],
    ['数据定义名称重复', { candidates: ['candidates/schema-session.json', 'candidates/schema-session-copy.json'], pending: [], notes: '说明' },
      ['outcome.json#candidates：候选数据定义的名称重复：场次']],
    ['图上位置的区域越界', { candidates: ['candidates/schema-session.json'],
      locations: [{ file: 'candidates/schema-session.json', path: 'title', where: '底部', region: { x: -1, y: 0, width: 0, height: 5 } }], pending: [], notes: '说明' },
      ['outcome.json#locations.0.region.x：locations.0.region.x 不能小于 0', 'outcome.json#locations.0.region.width：locations.0.region.width 必须大于 0']],
  ])('结构不合格：%s', async (_label, outcome, messages) => {
    expect(await check({ ...definitions, 'candidates/schema-session-copy.json': SESSION, 'scratch/schema.json': SESSION,
      'candidates/dataset.json': { dataset: { staticSchema: { name: '场次', version: 1 } }, data: {} }, 'outcome.json': outcome }))
      .toEqual({ verdict: 'unqualified', messages: messages.map((message) => expect.stringContaining(message)) });
  });
});

describe('命令行', () => {
  const env = (value: string | undefined) => { if (value === undefined) delete process.env['RW_TEST_KEY']; else process.env['RW_TEST_KEY'] = value; };
  async function cli(args: string[]) {
    const stdout: string[] = [], stderr: string[] = [];
    const code = await runCli(['agent', 'run', ...args], { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  }
  const base_ = () => ['--task', '数据定义提取', '--sample', sample, '--brief', brief, '--resources', resourcesDir, '--key-env', 'RW_TEST_KEY'];

  it('用法错误不创建轮次目录：任务类型、任务顺序、key、轮次目录、领域、示例图与轮数', async () => {
    env(KEY);
    try {
      const out = join(base, 'cli-out');
      const cases: [string[], string][] = [
        [[...base_(), '--out', out, '--task', '印章提取'], '没有任务类型 印章提取'],
        [['--task', '数据集提取', '--sample', sample, '--brief', brief, '--resources', resourcesDir, '--key-env', 'RW_TEST_KEY', '--out', out], '先做数据定义提取'],
        [['--task', '模板辅助修改', '--sample', sample, '--brief', brief, '--resources', resourcesDir, '--key-env', 'RW_TEST_KEY', '--out', out], '模板辅助修改要用 --request'],
        [[...base_(), '--out', out, '--key-env', 'RW_TEST_MISSING_KEY'], '缺少环境变量 RW_TEST_MISSING_KEY'],
        [[...base_(), '--out', base], '轮次目录必须不存在或为空'],
        [[...base_(), '--out', out, '--domain', 'asset-tag'], '没有领域约定包 asset-tag；可用：price-tag、route-sign'],
        [[...base_(), '--out', out, '--domain', '_template'], '没有领域约定包 _template；可用：price-tag、route-sign'],
        [[...base_(), '--out', out, '--sample', brief], '示例图不是 PNG、JPEG 或 WebP'],
        [[...base_(), '--out', out, '--max-turns', '0'], '--max-turns 必须是正整数'],
      ];
      for (const [args, message] of cases) {
        const result = await cli(args);
        expect([result.code, result.stderr]).toEqual([2, expect.stringContaining(message)]);
      }
      expect(await readdir(base)).not.toContain('cli-out');
    } finally {
      env(undefined);
    }
  });

  it('成果不合格时退出码为 1，标准输出给出摘要', async () => {
    env(KEY);
    try {
      const out = join(base, 'cli-unqualified');
      const result = await cli([...base_(), '--out', out, '--claude', join(base, 'no-such-claude')]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ round: out, verdict: 'unqualified', candidates: [], pending: null });
      expect(result.stderr).toContain('不会自动重试');
    } finally {
      env(undefined);
    }
  });
});
