/**
 * 推送与网页改动共存（P1 票据 10，验收 A09）：命令行 push、pull 对进程内服务跑，网页一侧的保存与指回经开放 API 制造。
 * 命令行从 src/cli.ts 进入，服务在本机端口上监听；内存后端进 npm test。
 */
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import type { ServiceBackend } from '../src/backend.js';
import { initializeResourceStore, loadWorkspace, localWorkspaceDocuments, readWorkspaceDocuments, render } from '../src/engine.js';
import { createWorld, type World } from './api-suite.js';
import { greetingPreview, RESOURCES_DIR, SINGLE_TEXT } from './seed.js';

const TOKEN_ENV = 'RW_TEST_PUSH_WEB_TOKEN';
const GREETING = encodeURIComponent('问候牌');
const JSON_TYPE = { 'content-type': 'application/json' };
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const TEMPLATE = 'template-greeting.json';

export function describePushWeb(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`推送与网页改动共存（${name}）`, () => {
    let world: World, server: string, root: string;
    beforeAll(async () => {
      world = await createWorld(await makeBackend());
      server = await world.app.listen({ host: '127.0.0.1', port: 0 });
      root = await mkdtemp(join(tmpdir(), 'rw-push-web-'));
    });
    afterAll(async () => {
      await world.app.close();
      await rm(root, { recursive: true, force: true });
    });

    const tenant = async () => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `共存 ${randomUUID().slice(0, 8)}` });
      const id = created.body.id as string;
      const issued = await world.call('POST', '/v1/platform/authoring-tokens', world.platform, { label: `工程师 ${randomUUID().slice(0, 8)}`, tenantIds: [id] });
      world.secrets.push(issued.body.token);
      return { id, token: issued.body.token as string, label: issued.body.authoringToken.label as string, admin: await world.member(id, 'admin') };
    };
    type Target = Awaited<ReturnType<typeof tenant>>;
    /** 一份本地工作区加空的资源版本仓库。 */
    const local = async () => {
      const dir = join(root, randomUUID()), workspace = join(dir, 'workspace'), resources = join(dir, 'resources');
      // 别的用例可能正读着这份样例，它的目录里有活动的 .write-lock：不能跟着复制。
      await cp(SINGLE_TEXT, workspace, { recursive: true, filter: (source) => !source.includes('.write-lock') });
      expect((await initializeResourceStore(resources)).problems).toEqual([]);
      return { workspace, resources };
    };
    type Dirs = Awaited<ReturnType<typeof local>>;
    const cli = async (args: readonly string[], token: string) => {
      const out: string[] = [], err: string[] = [], saved = process.env[TOKEN_ENV];
      process.env[TOKEN_ENV] = token;
      try {
        const code = await runCli([...args, '--token-env', TOKEN_ENV], { stdout: (text) => out.push(text), stderr: (text) => err.push(text) });
        return { code, stdout: out.join(''), stderr: err.join('') };
      } finally {
        if (saved === undefined) delete process.env[TOKEN_ENV];
        else process.env[TOKEN_ENV] = saved;
      }
    };
    const push = (target: Target, dirs: Dirs, ...extra: string[]) => cli(['push', '--server', server, '--tenant', target.id, '--workspace', dirs.workspace, '--resources', dirs.resources, ...extra], target.token);
    const pull = (target: Target, workspace: string, ...extra: string[]) => cli(['pull', '--server', server, '--tenant', target.id, '--workspace', workspace, ...extra], target.token);
    const recolor = async (dirs: Dirs, color: string) => {
      const file = join(dirs.workspace, TEMPLATE), text = await readFile(file, 'utf8');
      await writeFile(file, text.replace(/"#[0-9A-Fa-f]{6}"/, `"${color}"`));
    };
    const state = async (target: Target) => (await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.token)).body;
    /** 客户管理员在网页上改模板：开工作副本、换底色、保存。 */
    const webSave = async (target: Target, color: string) => {
      const token = target.admin.token, copy = (await world.call('POST', `/v1/templates/${GREETING}/working-copy`, token)).body;
      const content = (await world.call('GET', `/v1/templates/${GREETING}/working-copy`, token)).body.content as string;
      const stashed = await world.call('PUT', `/v1/templates/${GREETING}/working-copy?expectedSha256=${copy.sha256}`, token, content.replace(/"#[0-9A-Fa-f]{6}"/, `"${color}"`), JSON_TYPE);
      const saved = await world.call('POST', `/v1/templates/${GREETING}/working-copy/save`, token, { expectedSha256: stashed.body.sha256 });
      expect(saved.status, saved.raw.slice(0, 300)).toBe(200);
      return saved.body as { revision: number; sha256: string };
    };

    it('只用推送的租户行为不变：改一次推送一次，各记新修订；记录带上基于的修订，不冲突', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      for (const [index, color] of ['#111111', '#222222', '#333333'].entries()) {
        await recolor(dirs, color);
        const pushed = await push(target, dirs);
        expect(pushed.code, pushed.stderr).toBe(0);
        expect((await state(target)).templates[0]).toMatchObject({ currentRevision: index + 2, current: { source: 'push', action: 'revision', by: target.label } });
      }
      // 没有本地记录的另一份工作区：当前修订是推送产生的，照样可以盖上去（M265）。
      const other = await local();
      await recolor(other, '#444444');
      const fromOther = await push(target, other);
      expect(fromOther.code, fromOther.stderr).toBe(0);
      expect((await state(target)).templates[0].currentRevision).toBe(5);
    });

    it('本地记录不让读工作区与渲染报问题；清单只给模板带基于的修订', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      expect(await readdir(join(dirs.workspace, '.renderweave'))).toEqual([expect.stringContaining(target.id)]);
      expect((await readWorkspaceDocuments(localWorkspaceDocuments(dirs.workspace))).problems).toEqual([]);
      const rendered = await render(await loadWorkspace({ dir: dirs.workspace, resourcesDir: RESOURCES_DIR }), greetingPreview({ mode: 'draft' }));
      expect(rendered.problems).toEqual([]);
      expect(rendered.image).toBeTruthy();
      const planned = JSON.parse((await push(target, dirs, '--dry-run')).stdout);
      expect(planned.summary.conflicts).toBe(0);
      expect((await world.call('POST', `/v1/authoring/tenants/${target.id}/push-plans`, target.token, {
        documents: [{ kind: 'dataset', key: 'ds', sha256: sha256('x'), byteLength: 1, baseRevision: 1 }], resources: [] })).status, '只有模板能带').toBe(400);
    });

    it('网页保存之后，从旧内容推送整体拒绝并说明来源；服务端不变；pull 之后再推送成功', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      const saved = await webSave(target, '#ABCDEF');
      await recolor(dirs, '#000000');
      const before = await state(target);

      const dry = await push(target, dirs, '--dry-run');
      expect(dry.code).toBe(1);
      expect(JSON.parse(dry.stdout).summary.conflicts).toBe(1);
      const refused = await push(target, dirs);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('push.conflict');
      expect(refused.stderr).toContain(target.admin.email);
      expect(refused.stderr).toContain('renderweave pull');
      expect(refused.stderr).toContain(`当前修订 ${saved.revision}`);
      expect(await state(target)).toEqual(before);
      // 整体拒绝：清单里别的文档也没写。
      expect(before.templates[0].current).toMatchObject({ source: 'web', action: 'revision', by: target.admin.email });

      // 本地有改动，pull 不直接覆盖：先列出，一个文件也不写。
      const edited = await readFile(join(dirs.workspace, TEMPLATE), 'utf8');
      const listed = await pull(target, dirs.workspace);
      expect(listed.code).toBe(1);
      expect(JSON.parse(listed.stdout)).toMatchObject({ pulled: false, written: [], conflicts: [{ kind: 'template', key: '问候牌' }] });
      expect(listed.stderr).toContain('--overwrite');
      expect(await readFile(join(dirs.workspace, TEMPLATE), 'utf8')).toBe(edited);

      const overwritten = await pull(target, dirs.workspace, '--overwrite');
      expect(overwritten.code, overwritten.stderr).toBe(0);
      expect(JSON.parse(overwritten.stdout).written).toEqual([join(dirs.workspace, TEMPLATE)]);
      expect(sha256(await readFile(join(dirs.workspace, TEMPLATE)))).toBe(saved.sha256);

      // 在最新内容上改：基于的修订是当前修订，推送成功。
      await recolor(dirs, '#123456');
      const again = await push(target, dirs);
      expect(again.code, again.stderr).toBe(0);
      expect((await state(target)).templates[0]).toMatchObject({ currentRevision: saved.revision + 1, current: { source: 'push' } });
    });

    it('没有本地记录时，当前修订来自网页保存或指回也算冲突；字节相同不算', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      const saved = await webSave(target, '#ABCDEF');
      // 另一台机器：没有记录，内容是旧的。
      const fresh = await local();
      await recolor(fresh, '#999999');
      expect((await push(target, fresh)).stderr).toContain('push.conflict');
      // 内容恰好与当前修订相同：不变，不是冲突。
      await writeFile(join(fresh.workspace, TEMPLATE), (await world.call('GET', `/v1/authoring/tenants/${target.id}/contents/${saved.sha256}`, target.token)).bytes);
      const same = await push(target, fresh);
      expect(same.code, same.stderr).toBe(0);
      expect(JSON.parse(same.stdout).summary).toMatchObject({ updated: 0, conflicts: 0 });

      // 客户管理员指回：同样算冲突，说明写的是指回。
      const back = await world.call('POST', '/v1/template-current', target.admin.token, { template: '问候牌', revision: 1 });
      expect(back.status).toBe(200);
      expect((await state(target)).templates[0].current).toMatchObject({ source: 'web', action: 'setCurrent', by: target.admin.email });
      const third = await local();
      await recolor(third, '#888888');
      const refused = await push(target, third);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('指回');
    });

    it('代建工程师自己指回不算网页改动，接着推送不冲突；别的机器先推送了，带着旧记录的推送算冲突', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      await recolor(dirs, '#111111');
      expect((await push(target, dirs)).code).toBe(0);
      const revisions = (...extra: string[]) => cli(['template-revisions', '--server', server, '--tenant', target.id, '--template', '问候牌', ...extra], target.token);

      expect((await revisions('--current', '1')).code).toBe(0);
      expect((await state(target)).templates[0].current).toMatchObject({ source: 'push', action: 'setCurrent', by: target.label });
      // 本地记下的还是修订 2，当前修订是自己指回的 1：照 M265 可以接着推送。
      await recolor(dirs, '#222222');
      const fixed = await push(target, dirs);
      expect(fixed.code, fixed.stderr).toBe(0);
      expect((await state(target)).templates[0].currentRevision).toBe(3);

      // 另一台机器先拉取、再推送，这边的记录落后了。
      const other = join(root, randomUUID());
      await mkdir(other);
      expect((await pull(target, other)).code).toBe(0);
      await writeFile(join(other, 'template-问候牌.json'), (await readFile(join(other, 'template-问候牌.json'), 'utf8')).replace('#222222', '#333333'));
      expect((await cli(['push', '--server', server, '--tenant', target.id, '--workspace', other, '--resources', dirs.resources], target.token)).code).toBe(0);
      await recolor(dirs, '#444444');
      const stale = await push(target, dirs);
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain('本地基于修订 3');
      expect((await state(target)).templates[0].currentRevision).toBe(4);
    });

    it('pull 到空目录：写入模板、静态数据定义与编译产物，不取数据集与资源；可以接着推送；令牌规则同 push；记审计', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      const saved = await webSave(target, '#ABCDEF');
      const empty = join(root, randomUUID());
      await mkdir(empty);
      const pulled = await pull(target, empty);
      expect(pulled.code, pulled.stderr).toBe(0);
      const summary = JSON.parse(pulled.stdout);
      expect(summary).toMatchObject({ tenant: target.id, pulled: true, unchanged: 0, conflicts: [] });
      const files = (await readdir(empty)).filter((file) => file.endsWith('.json')).sort();
      expect(files).toEqual(['compiled-问候-v1.schema.json', 'schema-问候-v1.json', 'template-问候牌.json']);
      expect(sha256(await readFile(join(empty, 'template-问候牌.json')))).toBe(saved.sha256);
      expect((await readWorkspaceDocuments(localWorkspaceDocuments(empty))).problems).toEqual([]);
      const definition = await readFile(join(SINGLE_TEXT, 'schema-greeting-v1.json'));
      expect(Buffer.compare(await readFile(join(empty, 'schema-问候-v1.json')), definition)).toBe(0);

      // 再拉一次：都不变。
      expect(JSON.parse((await pull(target, empty)).stdout)).toMatchObject({ pulled: true, written: [], unchanged: 3 });
      // 在拉回来的工作区里改，接着推送。
      await writeFile(join(empty, 'template-问候牌.json'), (await readFile(join(empty, 'template-问候牌.json'), 'utf8')).replace('#ABCDEF', '#654321'));
      const pushed = await cli(['push', '--server', server, '--tenant', target.id, '--workspace', empty, '--resources', dirs.resources], target.token);
      expect(pushed.code, pushed.stderr).toBe(0);
      expect((await state(target)).templates[0].currentRevision).toBe(saved.revision + 1);

      const events = (await world.call('GET', '/v1/audit-events?limit=500', target.admin.token)).body.events as any[];
      expect(events.some((event) => event.action === 'content.read' && event.crossTenant)).toBe(true);
      expect(events.some((event) => event.action === 'authoring.read' && event.crossTenant)).toBe(true);

      // 令牌只认被指定的租户；不带令牌是用法错误，令牌不进输出。
      const other = await tenant();
      const denied = await cli(['pull', '--server', server, '--tenant', target.id, '--workspace', join(root, randomUUID())], other.token);
      expect(denied.code).toBe(1);
      expect(denied.stderr).toContain('request.notFound');
      expect(denied.stdout + denied.stderr).not.toContain(other.token);
      const saved2 = process.env['RENDERWEAVE_AUTHORING_TOKEN'];
      delete process.env['RENDERWEAVE_AUTHORING_TOKEN'];
      try { expect(await runCli(['pull', '--server', server, '--tenant', target.id, '--workspace', empty], { stdout: () => {}, stderr: () => {} })).toBe(2); }
      finally { if (saved2 !== undefined) process.env['RENDERWEAVE_AUTHORING_TOKEN'] = saved2; }
    });

    it('指回当前修订不改来历，旧内容的推送照样被挡住；打开审批策略后，命令行指回成为发布申请，退出码 0', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      const revisions = (...extra: string[]) => cli(['template-revisions', '--server', server, '--tenant', target.id, '--template', '问候牌', ...extra], target.token);
      const saved = await webSave(target, '#ABCDEF');
      const before = (await state(target)).templates[0].current;
      expect((await revisions('--current', String(saved.revision))).code).toBe(0);
      expect((await state(target)).templates[0].current, '什么也没变').toEqual(before);
      await recolor(dirs, '#000000');
      const refused = await push(target, dirs);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('push.conflict');

      expect((await world.call('PUT', '/v1/approval-policy', target.admin.token, { templates: true })).status).toBe(200);
      const requested = await revisions('--current', '1');
      expect(requested.code, requested.stderr).toBe(0);
      const id = JSON.parse(requested.stdout).request as string;
      expect(requested.stderr).toContain(`发布申请 ${id}`);
      expect((await state(target)).templates[0].currentRevision, '申请不改当前修订').toBe(saved.revision);
      expect((await world.call('POST', `/v1/publish-requests/${id}/approve`, target.admin.token)).status).toBe(200);
      expect((await state(target)).templates[0]).toMatchObject({ currentRevision: 1, current: { source: 'web', action: 'setCurrent', by: target.admin.email } });
    });

    it('打开审批策略后，推送成为发布申请，本地记录不动；批准后 pull 取回修订号，接着推送', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      expect((await world.call('PUT', '/v1/approval-policy', target.admin.token, { templates: true })).status).toBe(200);
      await recolor(dirs, '#ABCDEF');
      const record = join(dirs.workspace, '.renderweave', `template-revisions-${target.id}.json`), recorded = await readFile(record, 'utf8');

      const dry = await push(target, dirs, '--dry-run');
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stderr).toContain('审批策略');

      const requested = await push(target, dirs);
      expect(requested.code, requested.stderr).toBe(0);
      const reply = JSON.parse(requested.stdout);
      expect(reply).toMatchObject({ pushed: false, summary: { updated: 1 } });
      expect(requested.stderr).toContain(`发布申请 ${reply.request}`);
      expect(requested.stderr).toContain('renderweave pull');
      expect((await state(target)).templates[0].currentRevision).toBe(1);
      expect(await readFile(record, 'utf8')).toBe(recorded);

      const approved = await world.call('POST', `/v1/publish-requests/${reply.request}/approve`, target.admin.token);
      expect(approved.status, approved.raw.slice(0, 300)).toBe(200);
      expect((await state(target)).templates[0]).toMatchObject({ currentRevision: 2, current: { source: 'web', by: target.admin.email } });

      // 批准产生的修订算网页一侧：本地接着改、没 pull 就推送会被挡住。
      await recolor(dirs, '#123456');
      const refused = await push(target, dirs);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('push.conflict');

      await recolor(dirs, '#ABCDEF');
      const pulled = await pull(target, dirs.workspace);
      expect(pulled.code, pulled.stderr).toBe(0);
      await recolor(dirs, '#654321');
      const next = await push(target, dirs);
      expect(next.code, next.stderr).toBe(0);
      expect(JSON.parse(next.stdout).request).toBeDefined();
      expect((await world.call('GET', `/v1/publish-requests/${JSON.parse(next.stdout).request}`, target.admin.token)).body).toMatchObject({ status: 'pending', recheck: { valid: true } });
    });

    it('静态数据定义的冲突规则不变；草案与工作副本不受推送影响', async () => {
      const target = await tenant(), dirs = await local();
      expect((await push(target, dirs)).code).toBe(0);
      const definition = encodeURIComponent('问候');
      const draft = await world.call('POST', `/v1/definitions/${definition}/draft`, target.admin.token, { fromVersion: 1 });
      const copy = await world.call('POST', `/v1/templates/${GREETING}/working-copy`, target.admin.token);
      await recolor(dirs, '#111111');
      expect((await push(target, dirs)).code).toBe(0);
      expect((await world.call('GET', `/v1/definitions/${definition}/draft`, target.admin.token)).body.sha256).toBe(draft.body.sha256);
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, target.admin.token)).body.sha256).toBe(copy.body.sha256);
      const file = join(dirs.workspace, 'schema-greeting-v1.json');
      await writeFile(file, (await readFile(file, 'utf8')).replace('"displayName"', '"description": "改了已发布的", "displayName"'));
      const refused = await push(target, dirs);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('已发布的静态数据定义不可变');
    });
  });
}
