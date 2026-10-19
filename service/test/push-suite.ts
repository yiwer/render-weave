/**
 * 代建推送（票据 05）：代建工程师用命令行把本地工作区与资源版本仓库推送到客户的租户，结果经开放 API 读回核对。
 * 命令行从 src/cli.ts 进入（CODING_STANDARDS「接缝」），服务在本机端口上监听。
 * 同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑。
 */
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import type { ServiceBackend } from '../src/backend.js';
import { initializeResourceStore, localResourceBackend, openVersionedResourceStore, type ResourceChange } from '../src/engine.js';
import { createWorld, type World } from './api-suite.js';

const FIXTURE = fileURLToPath(new URL('../../fixtures/workspaces/single-text/', import.meta.url));
const PNG = fileURLToPath(new URL('../../fixtures/resources/images/test/quadrants.png', import.meta.url));
const TOKEN_ENV = 'RW_TEST_AUTHORING_TOKEN';
/** 样例工作区里要推送的四份文档；渲染请求不推送。 */
const FILES = { definition: 'schema-greeting-v1.json', compiled: 'compiled-greeting-v1.schema.json', template: 'template-greeting.json', dataset: 'dataset-greeting.json' };
const EMPTY = { documents: [], templates: [], resources: [] };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Target { id: string; token: string; label: string }
interface Dirs { workspace: string; resources: string }

export function describePush(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`代建推送（${name}）`, () => {
    let world: World, server: string, root: string;
    /** 命令行的全部输出，最后核对其中没有令牌。 */
    const outputs: string[] = [];
    beforeAll(async () => {
      world = await createWorld(await makeBackend());
      server = await world.app.listen({ port: 0, host: '127.0.0.1' });
      root = await mkdtemp(join(tmpdir(), 'rw-push-'));
    });
    afterAll(async () => {
      await world?.app.close();
      if (root) await rm(root, { recursive: true, force: true });
    });

    /** 平台管理员新开一个租户，签发只指定给它的代建令牌。 */
    const tenant = async (): Promise<Target> => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `推送 ${randomUUID().slice(0, 8)}` });
      const label = `代建工程师 ${created.body.id.slice(0, 8)}`;
      const issued = await world.call('POST', '/v1/platform/authoring-tokens', world.platform, { label, tenantIds: [created.body.id] });
      world.secrets.push(issued.body.token);
      return { id: created.body.id, token: issued.body.token, label };
    };
    /** 本地的样例工作区与资源版本仓库（一张图片、一个字体）。 */
    const local = async (): Promise<Dirs> => {
      const dir = join(root, randomUUID()), workspace = join(dir, 'workspace');
      await cp(FIXTURE, workspace, { recursive: true });
      const resources = await repository([
        { type: 'create', id: 'logo', kind: 'image', bytes: await readFile(PNG) },
        { type: 'create', id: 'font-small', kind: 'font', bytes: new Uint8Array(Buffer.from('不是真的字体，只用来核对字节')) },
      ]);
      return { workspace, resources };
    };
    const repository = async (changes: readonly ResourceChange[]) => {
      const dir = join(root, randomUUID());
      expect((await initializeResourceStore(dir)).problems).toEqual([]);
      expect((await localResourceBackend(dir).commit(changes)).problems).toEqual([]);
      return dir;
    };
    /** 运行命令行；令牌只放进环境变量。 */
    const cli = async (args: readonly string[], token?: string, env = TOKEN_ENV) => {
      const out: string[] = [], err: string[] = [];
      const saved = process.env[env];
      if (token === undefined) delete process.env[env];
      else process.env[env] = token;
      try {
        const code = await runCli(args, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
        outputs.push(...out, ...err);
        return { code, stdout: out.join(''), stderr: err.join('') };
      } finally {
        if (saved === undefined) delete process.env[env];
        else process.env[env] = saved;
      }
    };
    const push = (target: Pick<Target, 'id' | 'token'>, dirs: Dirs, ...extra: string[]) =>
      cli(['push', '--server', server, '--tenant', target.id, '--workspace', dirs.workspace, '--resources', dirs.resources, '--token-env', TOKEN_ENV, ...extra], target.token);
    const state = async (target: Target) => {
      const reply = await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.token);
      expect(reply.status).toBe(200);
      return reply.body;
    };
    const content = (target: Target, hash: string) => world.call('GET', `/v1/authoring/tenants/${target.id}/contents/${hash}`, target.token);
    const edit = async (dirs: Dirs, file: string, from: string, to: string) => {
      const path = join(dirs.workspace, file), text = await readFile(path, 'utf8');
      expect(text).toContain(from);
      await writeFile(path, text.replace(from, to));
      return text;
    };
    const entry = (result: { documents: { kind: string }[] }, kind: string) => result.documents.find((document) => document.kind === kind);

    it('推送前列出差异，只看差异时服务端不变；推送后从服务端读回的字节与本地一致', async () => {
      const target = await tenant(), dirs = await local();
      const dry = await push(target, dirs, '--dry-run');
      expect(dry.code, dry.stderr).toBe(0);
      const planned = JSON.parse(dry.stdout);
      expect(planned).toMatchObject({ tenant: target.id, dryRun: true, pushed: false, summary: { added: 6, updated: 0, unchanged: 0, conflicts: 0 }, skipped: ['render-request-greeting.json'] });
      expect(planned.documents.map((d: { kind: string; key: string; status: string }) => `${d.kind} ${d.key} ${d.status}`).sort())
        .toEqual(['compiled 问候@1 added', 'dataset ds-greeting added', 'definition 问候@1 added', 'template 问候牌 added']);
      expect(planned.resources.map((r: { id: string; status: string }) => `${r.id} ${r.status}`).sort()).toEqual(['font-small added', 'logo added']);
      expect(dry.stderr).toContain('新增');
      expect(await state(target)).toEqual(EMPTY);

      const pushed = await push(target, dirs);
      expect(pushed.code, pushed.stderr).toBe(0);
      expect(JSON.parse(pushed.stdout)).toMatchObject({ dryRun: false, pushed: true, summary: { added: 6, updated: 0, unchanged: 0, conflicts: 0 } });
      const after = await state(target);
      for (const [kind, file] of Object.entries(FILES)) {
        const bytes = await readFile(join(dirs.workspace, file));
        expect(entry(after, kind), kind).toMatchObject({ sha256: sha256(bytes), byteLength: bytes.length });
        const read = await content(target, sha256(bytes));
        expect(read.status, kind).toBe(200);
        expect(read.bytes.equals(bytes), kind).toBe(true);
      }
      const store = (await openVersionedResourceStore(dirs.resources)).store!;
      for (const info of store.list()) {
        expect(after.resources.find((r: { id: string }) => r.id === info.id)).toEqual({
          id: info.id, kind: info.kind, currentVersion: 1, versions: [{ version: 1, sha256: info.sha256, byteLength: info.byteLength }],
        });
        expect((await content(target, info.sha256)).bytes.equals(Buffer.from(await store.read(info.id, 1)))).toBe(true);
      }
      expect(after.templates).toEqual([{ name: '问候牌', currentRevision: 1, revisions: [expect.objectContaining({ revision: 1, pushedBy: target.label })] }]);

      const again = await push(target, dirs);
      expect(again.code, again.stderr).toBe(0);
      expect(JSON.parse(again.stdout).summary).toEqual({ added: 0, updated: 0, unchanged: 6, conflicts: 0 });
      expect(await state(target)).toEqual(after);
    });

    it('模板每推送一次记一个新修订，按名称指向当前修订，也可以把当前修订指回旧修订', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      const first = await readFile(join(dirs.workspace, FILES.template));
      await edit(dirs, FILES.template, '#FFF4E0', '#E0F4FF');
      const second = await readFile(join(dirs.workspace, FILES.template));
      const updated = await push(target, dirs);
      expect(updated.code, updated.stderr).toBe(0);
      const result = JSON.parse(updated.stdout);
      expect(result.summary).toEqual({ added: 0, updated: 1, unchanged: 5, conflicts: 0 });
      expect(entry(result, 'template')).toMatchObject({ key: '问候牌', status: 'updated', currentRevision: 1, revision: 2 });
      const template = (await state(target)).templates[0];
      expect(template).toMatchObject({ name: '问候牌', currentRevision: 2 });
      expect(template.revisions.map((r: { revision: number; sha256: string }) => [r.revision, r.sha256])).toEqual([[1, sha256(first)], [2, sha256(second)]]);

      const revisions = (...extra: string[]) =>
        cli(['template-revisions', '--server', server, '--tenant', target.id, '--template', '问候牌', '--token-env', TOKEN_ENV, ...extra], target.token);
      const listed = await revisions();
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual(template);
      const back = await revisions('--current', '1');
      expect(back.code, back.stderr).toBe(0);
      expect(JSON.parse(back.stdout)).toEqual({ ...template, currentRevision: 1 });
      const current = await state(target);
      expect(entry(current, 'template')).toMatchObject({ sha256: sha256(first), byteLength: first.length });
      expect((await content(target, sha256(first))).bytes.equals(first)).toBe(true);
      // 指回修订 1 之后，本地的内容相对当前修订又是更新。
      const dry = JSON.parse((await push(target, dirs, '--dry-run')).stdout);
      expect(entry(dry, 'template')).toMatchObject({ status: 'updated', currentRevision: 1 });

      const missing = await revisions('--current', '9');
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('request.notFound');
      expect((await cli(['template-revisions', '--server', server, '--tenant', target.id, '--template', '没有这个模板', '--token-env', TOKEN_ENV], target.token)).code).toBe(1);
      expect(await state(target)).toEqual(current);
    });

    it('冲突整体拒绝，服务端保持原样：静态数据定义同名同版本内容不同、数据集同 ID 内容不同', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      const before = await state(target);
      const definition = await edit(dirs, FILES.definition, '问候（渲染骨架样例）', '问候（改过）');
      await edit(dirs, FILES.template, '#FFF4E0', '#E0F4FF');

      const dry = await push(target, dirs, '--dry-run');
      expect(dry.code).toBe(1);
      expect(JSON.parse(dry.stdout)).toMatchObject({ pushed: false, summary: { added: 0, updated: 1, unchanged: 4, conflicts: 1 } });
      expect(entry(JSON.parse(dry.stdout), 'definition')).toMatchObject({ key: '问候@1', status: 'conflict', reason: expect.stringContaining('ADR-0008') });
      expect(dry.stderr).toMatch(/冲突.*问候@1/);
      const rejected = await push(target, dirs);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain('push.conflict');
      expect(JSON.parse(rejected.stdout)).toMatchObject({ pushed: false, summary: { conflicts: 1 } });
      expect(await state(target)).toEqual(before);

      await writeFile(join(dirs.workspace, FILES.definition), definition);
      await edit(dirs, FILES.dataset, '欢迎乘坐 M402 路', '欢迎乘坐 M403 路');
      const dataset = await push(target, dirs);
      expect(dataset.code).toBe(1);
      expect(dataset.stderr).toMatch(/冲突.*ds-greeting/);
      expect(await state(target)).toEqual(before);
    });

    it('资源按 ID 与内容版本对比：新内容版本追加；种类不同或内容版本分叉是冲突；服务端已有更新的版本时不覆盖', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      const logo = (await openVersionedResourceStore(dirs.resources)).store!.get('logo')!;
      const v2 = new Uint8Array([...await readFile(PNG), 0]);
      expect((await localResourceBackend(dirs.resources).commit([{ type: 'append', id: 'logo', expected: logo, bytes: v2 }])).problems).toEqual([]);
      const appended = await push(target, dirs);
      expect(appended.code, appended.stderr).toBe(0);
      expect(JSON.parse(appended.stdout).resources.find((r: { id: string }) => r.id === 'logo')).toMatchObject({ status: 'updated', localVersion: 2, serverVersion: 1 });
      const after = await state(target);
      expect(after.resources.find((r: { id: string }) => r.id === 'logo')).toMatchObject({ currentVersion: 2, versions: [{ sha256: logo.sha256 }, { version: 2, sha256: sha256(v2) }] });
      expect((await content(target, sha256(v2))).bytes.equals(Buffer.from(v2))).toBe(true);

      const elsewhere = async (changes: readonly ResourceChange[]) => ({ workspace: dirs.workspace, resources: await repository(changes) });
      const kind = await push(target, await elsewhere([{ type: 'create', id: 'logo', kind: 'font', bytes: await readFile(PNG) }]));
      expect(kind.code).toBe(1);
      expect(kind.stderr).toMatch(/冲突.*logo.*种类/);
      const forked = await push(target, await elsewhere([{ type: 'create', id: 'logo', kind: 'image', bytes: new Uint8Array([1, 2, 3]) }]));
      expect(forked.code).toBe(1);
      expect(forked.stderr).toMatch(/冲突.*logo.*v1/);
      expect(await state(target)).toEqual(after);

      const behind = await push(target, await elsewhere([{ type: 'create', id: 'logo', kind: 'image', bytes: await readFile(PNG) }]));
      expect(behind.code, behind.stderr).toBe(0);
      expect(JSON.parse(behind.stdout).resources).toEqual([expect.objectContaining({ id: 'logo', status: 'unchanged', localVersion: 1, serverVersion: 2 })]);
      expect(await state(target)).toEqual(after);
    });

    it('推送未初始化的目录或旧版资源目录时，问题说明与 M239 一致，服务端不变', async () => {
      const target = await tenant(), dirs = await local();
      const legacy = join(root, randomUUID());
      await mkdir(legacy);
      await writeFile(join(legacy, 'resources.json'), JSON.stringify({ resources: [] }));
      for (const dir of [join(root, randomUUID()), legacy]) {
        const listed = await cli(['resources-list', '--resources', dir]);
        expect(listed.code).toBe(1);
        expect(listed.stderr).toContain('resources-init');
        const pushed = await push(target, { workspace: dirs.workspace, resources: dir });
        expect(pushed.code).toBe(1);
        expect(pushed.stderr).toContain(listed.stderr.trim());
      }
      expect(await state(target)).toEqual(EMPTY);
    });

    it('本地工作区有严重问题时不推送', async () => {
      const target = await tenant(), dirs = await local();
      await cp(join(dirs.workspace, FILES.template), join(dirs.workspace, 'template-copy.json'));
      const pushed = await push(target, dirs);
      expect(pushed.code).toBe(1);
      expect(pushed.stderr).toContain('input.duplicate');
      expect(await state(target)).toEqual(EMPTY);
    });

    it('内容按哈希上传；没上传或内容与声明不符的推送被拒绝，服务端不变；没登记的内容读不到', async () => {
      const target = await tenant(), base = `/v1/authoring/tenants/${target.id}`;
      const template = await readFile(join(FIXTURE, FILES.template));
      const document = { kind: 'template', key: '问候牌', sha256: sha256(template), byteLength: template.length };
      const manifest = { documents: [document], resources: [] };
      expect(await world.call('PUT', `${base}/contents/${sha256(Buffer.from('别的内容'))}`, target.token, template))
        .toMatchObject({ status: 400, body: { problems: [{ code: 'push.contentMismatch' }] } });
      expect(await world.call('POST', `${base}/pushes`, target.token, manifest))
        .toMatchObject({ status: 400, body: { problems: [{ code: 'push.contentMissing', location: { kind: 'input', source: 'template:问候牌' } }] } });
      expect((await world.call('PUT', `${base}/contents/${document.sha256}`, target.token, template)).status).toBe(204);
      expect((await content(target, document.sha256)).status).toBe(404);
      for (const claim of [{ ...document, key: '别的模板' }, { ...document, kind: 'dataset' }, { ...document, byteLength: template.length + 1 }]) {
        expect(await world.call('POST', `${base}/pushes`, target.token, { documents: [claim], resources: [] }))
          .toMatchObject({ status: 400, body: { problems: [{ code: 'push.contentMismatch' }] } });
      }
      expect(await state(target)).toEqual(EMPTY);

      const invalid = [
        { documents: [document, { ...document, sha256: 'a'.repeat(64) }], resources: [] },
        { documents: [], resources: [{ id: 'logo', kind: 'image', versions: [{ version: 2, sha256: document.sha256, byteLength: 1 }] }] },
        { documents: [], resources: [{ id: '../logo', kind: 'image', versions: [{ version: 1, sha256: document.sha256, byteLength: 1 }] }] },
        { documents: [{ ...document, kind: 'request' }], resources: [] },
      ];
      for (const body of invalid) {
        expect(await world.call('POST', `${base}/push-plans`, target.token, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid' }] } });
      }
      const committed = await world.call('POST', `${base}/pushes`, target.token, manifest);
      expect(committed).toMatchObject({ status: 200, body: { pushId: expect.any(String), summary: { added: 1 } } });
      expect((await content(target, document.sha256)).bytes.equals(template)).toBe(true);
    });

    it('令牌只经环境变量传入，不出现在参数、日志和输出里；只能推送到被指定的租户；每次推送记审计', async () => {
      const target = await tenant(), other = await tenant(), dirs = await local();
      const args = ['push', '--server', server, '--tenant', target.id, '--workspace', dirs.workspace, '--resources', dirs.resources];
      const missing = await cli(args, undefined, 'RENDERWEAVE_AUTHORING_TOKEN');
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('RENDERWEAVE_AUTHORING_TOKEN');
      expect((await cli([...args, '--token', target.token])).code).toBe(2);
      const viaDefault = await cli([...args, '--dry-run'], target.token, 'RENDERWEAVE_AUTHORING_TOKEN');
      expect(viaDefault.code, viaDefault.stderr).toBe(0);

      const notAssigned = await push({ id: other.id, token: target.token }, dirs);
      expect(notAssigned.code).toBe(1);
      expect(notAssigned.stderr).toContain('request.notFound');
      const unknown = await push({ id: target.id, token: `rwa_${'x'.repeat(43)}` }, dirs);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('auth.required');
      const unreachable = await cli(['push', '--server', 'http://127.0.0.1:9', '--tenant', target.id, '--workspace', dirs.workspace, '--resources', dirs.resources,
        '--token-env', TOKEN_ENV], target.token);
      expect(unreachable.code).toBe(1);
      expect(unreachable.stderr).toContain('无法连接');
      expect((await push(target, dirs)).code).toBe(0);

      const admin = await world.member(target.id, 'admin');
      const events = (await world.call('GET', '/v1/audit-events?limit=500', admin.token)).body.events as { action: string; actor: { kind: string; label: string }; crossTenant: boolean }[];
      const pushes = events.filter((event) => event.action.startsWith('push.'));
      expect(pushes.filter((event) => event.action === 'push.commit')).toHaveLength(1);
      expect(pushes.filter((event) => event.action === 'push.plan')).toHaveLength(2);
      expect(pushes.every((event) => event.crossTenant && event.actor.kind === 'authoringToken' && event.actor.label === target.label)).toBe(true);
      expect(events.some((event) => event.action === 'content.upload')).toBe(true);

      // 只截一段也算泄露：令牌公开的只有开头 10 个字符（rwa_ 加 6 位），任何 16 个字符的片段都不能出现。
      const text = [...outputs, ...world.logs, JSON.stringify(events)].join('\n');
      for (const secret of world.secrets) {
        for (let i = 0; i + 16 <= secret.length; i++) expect(text, '输出、日志或审计里出现了密钥的片段').not.toContain(secret.slice(i, i + 16));
      }
    });
  });
}
