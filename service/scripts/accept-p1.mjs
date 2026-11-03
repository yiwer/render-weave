/**
 * P1 验收脚本（票据 13，PRD「完成标准」）：在本机 Docker Compose 上从空环境起完整服务，走完整个流程。
 * 全程只经产品的入口——平台管理员命令、浏览器里的控制台、代建的命令行与开放 API；不手工改数据库、不手工复制文件。
 * 复制 M402 样例只是给代建工程师一份本地工作区，推送与拉取会在里面记修订号，不能写进版本库里的样例。
 *
 * 平台管理员在控制台开通租户、设套餐、建客户管理员、签发代建令牌 → 代建工程师推送 M402 →
 * 客户管理员把"线路牌 v1"复制为草案、加必填字段，看差异与数据集影响后发布为 v2 →
 * 在设计页图上点选线路号、改字号、暂存、看预览，看结构化差异与前后对比后保存为新修订 → 指回上一个修订 →
 * 代建工程师从旧内容推送被挡住，pull 之后再推送成功 → 客户管理员打开模板修订的审批策略，推送变成申请，批准后生效 →
 * 审计里每一步都有主体、前后内容哈希与差异摘要。
 *
 * 先 npm run build 与 npm run fetch-fonts；RW_BROWSER 指向本机 Chromium 内核浏览器（如 Edge）的可执行文件。
 * 用法：node service/scripts/accept-p1.mjs [--headed] [--keep] [--walkthrough]
 *   --keep         结束后保留环境；
 *   --walkthrough  另开一个"走查客户"租户（推送 M402，打开模板修订的审批策略，留一份待批准的申请），
 *                  把控制台地址与账号写进报告目录的 walkthrough.txt，保留环境，供真人走查。
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { capture, ensureEnv, root, run, up } from './docker.mjs';
import { API, call, expectStatus, M402_DIR, openTenant, platformLogin, push, renderweave, resourceStore } from './stage4.mjs';

const { values: options } = parseArgs({ options: { headed: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false }, walkthrough: { type: 'boolean', default: false } } });
const browserPath = process.env.RW_BROWSER;
if (!browserPath) {
  console.error('请设 RW_BROWSER：本机 Chromium 内核浏览器的可执行文件，如 C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  process.exit(2);
}

const TEMPLATE = '标准线路单边', DEFINITION = '线路牌', DATASET = 'ds-m402-wanguocheng', TENANT = '验收客户';
const TEMPLATE_FILE = 'template-route-sign.json', BLANK = '空白数据（显示占位）';
const ADMIN = 'admin@customer.acceptance.test', LABEL = '验收客户的代建工程师';
const enc = encodeURIComponent;

const out = join(root, 'out/p1/acceptance', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const steps = [];
let last = Date.now();
/** 记一步：名称、用时与要点；失败时连同已完成的步骤一起写进报告。 */
const step = (name, detail = {}) => {
  const now = Date.now();
  steps.push({ name, ms: now - last, ...detail });
  console.error(`✓ ${name}（${((now - last) / 1000).toFixed(1)} 秒）${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  last = now;
};
const check = (condition, message) => { if (!condition) throw new Error(message); };

/** 改本地模板的第一个颜色：代建工程师在本地改了内容。 */
const recolor = async (workspace, color, file = TEMPLATE_FILE) => {
  const path = join(workspace, file), text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/"#[0-9A-Fa-f]{6}"/, `"${color}"`));
};

ensureEnv();
run('docker', ['compose', '--profile', 'test', 'down', '-v', '--remove-orphans']);
let browser, status = 1;
const report = { startedAt: new Date().toISOString(), steps };
try {
  const { build, image } = up();
  step('从空环境起服务', { build, image });

  browser = await chromium.launch({ executablePath: browserPath, headless: !options.headed });
  const pageErrors = [];
  const newPage = async (viewport = { width: 1440, height: 1000 }) => {
    const context = await browser.newContext({ viewport, locale: 'zh-CN' });
    context.setDefaultTimeout(60_000);
    const opened = await context.newPage();
    opened.on('pageerror', (error) => pageErrors.push(error.message));
    return opened;
  };
  const signIn = async (target, hash, email, password) => {
    await target.goto(`${API}/console/${hash}`);
    await target.getByLabel('邮箱').fill(email);
    await target.getByLabel('密码').fill(password);
    await target.getByRole('button', { name: '登录' }).click();
  };

  // 平台管理员：命令行建账号（产品的入口），之后都在控制台。
  const platform = await platformLogin('platform@acceptance.test');
  const console_ = await newPage();
  await signIn(console_, '#/platform', platform.email, platform.password);
  await console_.getByRole('heading', { name: '租户', level: 1 }).waitFor();
  await console_.getByTestId('service-health').filter({ hasText: '接口 就绪' }).waitFor();
  await console_.getByRole('button', { name: '开通租户' }).click();
  await console_.getByLabel('租户名称').fill(TENANT);
  await console_.getByRole('button', { name: '开通', exact: true }).click();
  const tenantRow = console_.locator(`[data-testid="tenant-row"][data-name="${TENANT}"]`);
  await tenantRow.getByTestId('tenant-status').filter({ hasText: '未设套餐' }).waitFor();
  const tenantDetail = console_.getByTestId('tenant-detail');
  await tenantDetail.getByLabel('每月出图（张）').fill('1000');
  await tenantDetail.getByLabel('单张最大像素（MP）').fill('100');
  await tenantDetail.getByLabel('并发').fill('2');
  await tenantDetail.getByRole('button', { name: '保存套餐' }).click();
  await tenantRow.getByTestId('tenant-status').filter({ hasText: '正常' }).waitFor();
  await tenantDetail.getByLabel('成员邮箱').fill(ADMIN);
  await tenantDetail.getByLabel('角色').selectOption('admin');
  await console_.getByRole('button', { name: '创建账号' }).click();
  const adminPassword = await console_.getByTestId('one-time-secret').textContent();
  await console_.getByRole('button', { name: '我已保存，关闭' }).click();
  const tenantId = (await expectStatus(call('GET', '/v1/platform/tenants', { token: platform.token }), 200, '列租户')).body.tenants.find((item) => item.name === TENANT).id;
  check((await expectStatus(call('GET', `/v1/platform/tenants/${tenantId}/plan`, { token: platform.token }), 200, '读套餐')).body.monthlyImages === 1000, '套餐不是页面上设的');
  step('平台管理员在控制台开通租户、设套餐、建客户管理员', { tenant: tenantId });

  await console_.keyboard.press('Control+k');
  await console_.getByRole('combobox', { name: '筛选模块与动作' }).fill('签发');
  await console_.keyboard.press('Enter');
  await console_.getByRole('heading', { name: '代建令牌', level: 1 }).waitFor();
  await console_.getByLabel('标签').fill(LABEL);
  await console_.getByRole('checkbox', { name: TENANT }).check();
  await console_.getByRole('button', { name: '签发', exact: true }).click();
  const engineerToken = await console_.getByTestId('one-time-secret').textContent();
  check(engineerToken.startsWith('rwa_'), '签发的不是代建令牌');
  await console_.getByRole('button', { name: '我已保存，关闭' }).click();
  await console_.context().close();
  step('平台管理员在控制台签发代建令牌');

  // 代建工程师：两份本地工作区。A 从这里推送，B 是另一台机器上没有修订记录的旧内容。
  const engineerEnv = { RENDERWEAVE_AUTHORING_TOKEN: engineerToken };
  const resources = await resourceStore(join(out, 'resources'));
  const copyOf = async (name) => {
    const dir = join(out, name);
    await cp(M402_DIR, dir, { recursive: true });
    return dir;
  };
  const workspaceA = await copyOf('engineer-a'), workspaceB = await copyOf('engineer-b');
  const pushFrom = (workspace, ...extra) => renderweave(['push', '--server', API, '--tenant', tenantId, '--workspace', workspace, '--resources', resources, ...extra], engineerEnv);
  const pullTo = (workspace, ...extra) => renderweave(['pull', '--server', API, '--tenant', tenantId, '--workspace', workspace, ...extra], engineerEnv);
  const first = pushFrom(workspaceA);
  check(first.code === 0, `首次推送失败：${first.stderr.slice(-2000)}`);
  step('代建工程师推送 M402 的数据定义、模板与资源', { summary: JSON.parse(first.stdout).summary });

  // 客户管理员：复制为草案，加必填字段，看差异与数据集影响，发布为 v2。
  const page = await newPage();
  await signIn(page, '#/static-schemas', ADMIN, adminPassword);
  await page.getByRole('heading', { name: '静态数据定义', level: 1 }).waitFor();
  const adminToken = (await expectStatus(call('POST', '/v1/sessions', { body: { email: ADMIN, password: adminPassword } }), 201, '客户管理员登录')).body.token;
  const adminApi = (method, path, body) => call(method, path, { token: adminToken, ...(body === undefined ? {} : { body }) });
  await page.locator(`[data-testid="version-card"][data-name="${DEFINITION}"][data-version="1"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '复制为草案' }).click();
  await page.getByTestId('definition-meta').filter({ hasText: '基于 v1' }).waitFor();
  await page.getByRole('button', { name: '添加字段' }).click();
  const fieldForm = page.getByRole('form', { name: '编辑字段' });
  await fieldForm.getByLabel('显示名称', { exact: true }).fill('所属车队');
  await fieldForm.getByLabel('字段名称', { exact: true }).fill('depot');
  await fieldForm.getByLabel('类型', { exact: true }).selectOption({ label: '文本' });
  await fieldForm.getByRole('button', { name: '必填', exact: true }).click();
  await fieldForm.getByLabel('最长（字）', { exact: true }).fill('20');
  await page.locator('[data-testid="field-row"][data-field="depot"]').waitFor();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByTestId('check-status').filter({ hasText: '校验通过' }).waitFor();
  await page.getByRole('button', { name: '发布为 v2' }).click();
  await page.getByRole('heading', { name: `发布为 ${DEFINITION} v2`, level: 1 }).waitFor();
  const added = page.getByTestId('definition-diff').locator('li[data-path="depot"][data-change="added"]');
  check((await added.textContent()).includes('新增必填字段 所属车队'), '字段级差异没有写出新增的必填字段');
  const verdict = await page.getByTestId('datasets-verdict').textContent();
  check(verdict.includes('1 份按新版会失配'), `数据集影响不对：${verdict}`);
  await page.getByTestId('dataset-samples').locator(`tr[data-id="${DATASET}"]`).filter({ hasText: 'depot' }).waitFor();
  await page.screenshot({ path: join(out, 'definition-publish.png'), fullPage: true });
  await page.getByRole('button', { name: '发布为 v2' }).click();
  const publication = page.locator(`[data-testid="publication-row"][data-name="${DEFINITION}"][data-version="2"]`);
  await publication.waitFor();
  check(await publication.getByTestId('publication-actor').textContent() === ADMIN, '发布记录的主体不是客户管理员');
  const v2 = (await expectStatus(adminApi('GET', `/v1/static-schemas/${enc(DEFINITION)}/versions/2`), 200, '读 v2')).body;
  check(v2.compiled.required.includes('depot'), 'v2 的编译产物没有必填字段 depot');
  step('客户管理员复制为草案、加必填字段，看差异与数据集影响后发布为 v2', { verdict });

  // 模板设计：M402 样例的线路号是图片，文字版在没有图片时才显示，所以换空白数据点选。
  const revisions = async () => (await expectStatus(adminApi('GET', `/v1/templates/${enc(TEMPLATE)}/revisions`), 200, '读修订历史')).body;
  const before = await revisions();
  check(before.currentRevision === 1, `推送之后应是修订 1，实际 ${before.currentRevision}`);
  await page.goto(`${API}/console/#/templates/${enc(TEMPLATE)}/design`);
  await page.getByTestId('preview-image').waitFor();
  const blankPreview = page.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true') && response.ok() && response.request().postDataJSON().dataset?.inline !== undefined);
  await page.locator('#design-dataset').selectOption({ label: BLANK });
  const blankReply = await (await blankPreview).json();
  const findNode = (node, name) => (node.path.split('/').at(-1) === name ? node : (node.children ?? []).map((child) => findNode(child, name)).find(Boolean));
  const routeNo = findNode(blankReply.layout.root, '线路号');
  check(routeNo?.visible, '空白数据下线路号没有显示');
  // 等图换成这一次预览的，再按布局摘要的元素框点在元素中央。
  await page.getByTestId('design-status').filter({ hasNotText: '正在出草稿预览' }).waitFor();
  const canvas = page.getByTestId('design-canvas'), box = await canvas.boundingBox(), { width, height } = blankReply.layout.output;
  await canvas.click({ position: { x: ((routeNo.x + routeNo.width / 2) / width) * box.width, y: ((routeNo.y + routeNo.height / 2) / height) * box.height } });
  const inspector = page.getByRole('complementary', { name: '检查器' });
  await inspector.locator(`[data-testid="properties"][data-path="${routeNo.path}"]`).waitFor();
  check(await page.getByTestId('select-box').getAttribute('data-path') === routeNo.path, '选中框不是线路号');
  const imageBefore = await page.getByTestId('preview-image').getAttribute('src');
  const stashed = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.ok());
  await inspector.locator('[data-testid="property-field"][data-key="fontSize"]').first().locator('input[type="text"]').first().fill('26');
  await stashed;
  await page.waitForFunction(([testid, previous]) => document.querySelector(`[data-testid="${testid}"]`)?.getAttribute('src') !== previous, ['preview-image', imageBefore], { timeout: 60_000 });
  const copy = (await expectStatus(adminApi('GET', `/v1/templates/${enc(TEMPLATE)}/working-copy`), 200, '读工作副本')).body;
  check(copy.content.includes('"fontSize": 26'), '工作副本里没有新字号');
  check((await revisions()).currentRevision === 1, '暂存改了当前修订');
  await page.screenshot({ path: join(out, 'template-design.png') });
  step('设计页在图上点选线路号，改字号，暂存工作副本，草稿预览随之变化', { element: routeNo.path });

  // 发布：结构化差异与前后对比。
  await page.getByRole('button', { name: '发布修订' }).click();
  await page.getByRole('heading', { name: '发布修订 2', level: 1 }).waitFor();
  const change = page.locator(`[data-testid="change"][data-path="${TEMPLATE}/顶栏/线路号"]`);
  await change.waitFor();
  check(/fontSize修改24→26/.test(await change.locator('[data-testid="change-property"][data-key="fontSize"]').textContent()), '结构化差异没有写出字号的改动');
  await page.getByLabel('样例数据集').selectOption({ label: BLANK });
  const imageOf = (side) => page.getByTestId(side).getByRole('img');
  await imageOf('compare-current').waitFor();
  await imageOf('compare-working-copy').waitFor();
  for (let tries = 0; await imageOf('compare-working-copy').getAttribute('src') === await imageOf('compare-current').getAttribute('src'); tries++) {
    check(tries < 120, '改前改后的对比图没有差别');
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: join(out, 'template-publish.png'), fullPage: true });
  await page.getByRole('button', { name: '发布为修订 2' }).click();
  await page.getByRole('status').filter({ hasText: '已保存为修订 2' }).waitFor();
  const saved = await revisions();
  check(saved.currentRevision === 2 && saved.revisions.at(-1).source === 'web' && saved.revisions.at(-1).pushedBy === ADMIN, `保存之后不对：${JSON.stringify(saved.current)}`);
  step('看结构化差异与前后对比后保存为新修订', { revision: 2 });

  // 网页保存之后，A 的记录还是修订 1，当前修订已是 2：从旧内容推送被挡住，服务端不变。
  await recolor(workspaceA, '#ABCDEF');
  const staleA = pushFrom(workspaceA);
  check(staleA.code === 1 && staleA.stderr.includes('push.conflict') && staleA.stderr.includes(ADMIN) && staleA.stderr.includes('本地基于修订 1'), `旧内容的推送应被挡住并说明来源：${staleA.stderr.slice(-1000)}`);
  check((await revisions()).currentRevision === 2, '被挡住的推送改了当前修订');
  step('网页保存之后，代建工程师从旧内容推送被挡住，说明由谁改的', { source: 'engineer-a（记录是修订 1）' });

  // 指回上一个修订。
  const revisionRow = page.locator('[data-testid="revision-row"][data-revision="1"]');
  await revisionRow.getByRole('button', { name: '指回' }).click();
  await revisionRow.getByRole('button', { name: '确认指回' }).click();
  await page.getByRole('status').filter({ hasText: '当前修订已指回修订 1' }).waitFor();
  const pointed = await revisions();
  check(pointed.currentRevision === 1 && pointed.current.source === 'web' && pointed.current.action === 'setCurrent', `指回之后不对：${JSON.stringify(pointed.current)}`);
  step('指回上一个修订');

  // 指回之后：B 没有修订记录，当前修订来自网页，被挡住。
  await recolor(workspaceB, '#ABCDEF');
  const refused = pushFrom(workspaceB);
  check(refused.code === 1 && refused.stderr.includes('push.conflict') && refused.stderr.includes(ADMIN) && refused.stderr.includes('renderweave pull'), `旧内容的推送应被挡住并说明来源：${refused.stderr.slice(-1000)}`);
  check((await revisions()).currentRevision === 1, '被挡住的推送改了当前修订');
  // A 的记录正好是修订 1，也就是指回之后的当前修订：它基于的就是当前内容，不算冲突（M359）。只列差异，不提交。
  const samebase = pushFrom(workspaceA, '--dry-run');
  check(samebase.code === 0 && JSON.parse(samebase.stdout).summary.conflicts === 0, `基于当前修订的本地内容不该冲突：${samebase.stderr.slice(-500)}`);
  step('指回之后，没有修订记录的旧内容推送被挡住；记录正好是当前修订的不算冲突', { source: 'engineer-b（没有修订记录）' });

  const pulled = pullTo(workspaceB, '--overwrite');
  check(pulled.code === 0, `pull 失败：${pulled.stderr.slice(-1000)}`);
  await recolor(workspaceB, '#123456');
  const pushed = pushFrom(workspaceB);
  check(pushed.code === 0 && JSON.parse(pushed.stdout).pushed === true, `pull 之后的推送失败：${pushed.stderr.slice(-1000)}`);
  const afterPush = await revisions();
  check(afterPush.currentRevision === 3 && afterPush.current.source === 'push', `pull 之后推送应记修订 3：${JSON.stringify(afterPush.current)}`);
  step('renderweave pull 之后再推送成功', { revision: 3 });

  // 审批策略：管理页打开，推送变成申请，批准后生效。
  await page.goto(`${API}/console/#/admin/approval`);
  const scope = page.getByTestId('approval-policy').locator('[data-scope="templates"]');
  await scope.getByRole('checkbox').check();
  await scope.filter({ hasText: ADMIN }).waitFor();
  check((await adminApi('GET', '/v1/approval-policy')).body.templates.required === true, '审批策略没有打开');
  await recolor(workspaceB, '#654321');
  const requested = pushFrom(workspaceB);
  check(requested.code === 0 && requested.stderr.includes('发布申请'), `推送应变成申请：${requested.stderr.slice(-1000)}`);
  const requestId = JSON.parse(requested.stdout).request;
  check(requestId && JSON.parse(requested.stdout).pushed === false, '回答没有申请 ID');
  check((await revisions()).currentRevision === 3, '申请改了当前修订');
  await page.goto(`${API}/console/#/templates/${enc(TEMPLATE)}/publish`);
  await page.reload();
  const requestRow = page.locator(`[data-testid="request-row"][data-id="${requestId}"]`);
  await requestRow.getByRole('button').click();
  const requestDetail = page.getByTestId('request-detail');
  await requestDetail.getByTestId('request-diff').locator(`[data-path="template:${TEMPLATE}"]`).waitFor();
  await page.screenshot({ path: join(out, 'publish-request.png') });
  await requestDetail.getByRole('button', { name: '批准' }).click();
  await page.getByTestId('request-notice').filter({ hasText: '已批准并生效' }).waitFor();
  await page.getByTestId('current-revision').filter({ hasText: '当前修订 4' }).waitFor();
  const approved = await revisions();
  check(approved.current.source === 'web' && approved.current.by === ADMIN && approved.revisions.at(-1).source === 'push' && approved.revisions.at(-1).pushedBy === LABEL, `批准之后不对：${JSON.stringify(approved.current)}`);
  check((await adminApi('GET', `/v1/publish-requests/${requestId}`)).body.status === 'approved', '申请不是已批准');
  step('打开模板修订的审批策略，推送变成发布申请，客户管理员批准后生效', { request: requestId, revision: 4 });

  // 审计：每一步都有主体、前后内容哈希与差异摘要。推送的前后哈希逐项记在差异摘要里。
  const events = (await expectStatus(adminApi('GET', '/v1/audit-events?limit=500'), 200, '读审计')).body.events;
  const hasDiff = (event) => event.diff && event.diff.added + event.diff.removed + event.diff.changed >= 0;
  const expected = [
    ['definitionDraft.create', ADMIN, ['after']], ['definitionDraft.save', ADMIN, ['before', 'after']], ['definition.publish', ADMIN, ['before', 'after']],
    ['templateWorkingCopy.create', ADMIN, ['after']], ['templateWorkingCopy.save', ADMIN, ['before', 'after']], ['template.save', ADMIN, ['before', 'after']],
    ['template.setCurrent', ADMIN, ['before', 'after']], ['push.commit', LABEL, []], ['publishRequest.create', LABEL, ['after']], ['publishRequest.approve', ADMIN, ['after']],
  ];
  const seen = {};
  for (const [action, label, hashes] of expected) {
    const found = events.filter((event) => event.action === action && event.actor.label === label);
    check(found.length > 0, `审计里没有 ${label} 的 ${action}`);
    for (const event of found) {
      check(hasDiff(event), `${action} 没有差异摘要`);
      if (hashes.includes('before')) check(/^[0-9a-f]{64}$/.test(event.beforeSha256 ?? ''), `${action} 没有前内容哈希`);
      if (hashes.includes('after')) check(/^[0-9a-f]{64}$/.test(event.afterSha256 ?? ''), `${action} 没有后内容哈希`);
    }
    seen[action] = found.length;
  }
  // 一次推送改好几份内容，没有整份的前后哈希（申请固定的是清单的哈希）：前后哈希逐项记在差异摘要里。
  for (const action of ['push.commit', 'publishRequest.create', 'publishRequest.approve']) {
    check(events.some((event) => event.action === action && event.diff.paths.some((item) => item.path === `template:${TEMPLATE}` && item.beforeSha256 && item.afterSha256)), `${action} 的差异摘要没有逐项的前后哈希`);
  }
  // 批准生效的事件主体是批准的人；被挡住的推送也留下记录；代建工程师的操作都标为跨租户。
  check(events.some((event) => event.action === 'push.commit' && event.actor.label === ADMIN && event.object.id === requestId), '批准生效的推送没有记审计');
  check(events.some((event) => event.action === 'push.reject' && event.actor.label === LABEL), '被挡住的推送没有记审计');
  check(events.filter((event) => event.actor.label === LABEL).every((event) => event.crossTenant === true), '代建工程师的操作没有全部标为跨租户');
  check(events.filter((event) => event.actor.kind === 'platformUser').every((event) => event.crossTenant === true) && events.some((event) => event.action === 'tenant.create'), '平台管理员的操作没有全部标为跨租户');
  check(events.every((event) => event.actor?.kind && event.actor?.label), '有审计事件没有主体');
  const csv = await expectStatus(adminApi('GET', '/v1/audit-events/export.csv?actorKind=authoringToken'), 200, '导出审计');
  const lines = Buffer.from(csv.bytes).toString('utf8').trim().split('\r\n');
  check(lines.length > 1 && lines.slice(1).every((line) => line.includes('authoringToken')), '按主体筛选导出不对');
  step('审计里每一步都有主体、前后内容哈希与差异摘要', { actions: seen, events: events.length });

  // 经过这一连串改动，模板仍能按原来的数据集出图：数据集绑定 v1，没有被 v2 影响。
  // 预览只出草稿，样例请求写的是正式模式，去掉这一项。
  const { mode: _mode, ...single } = JSON.parse(await readFile(join(M402_DIR, 'render-request-m402.json'), 'utf8'));
  const preview = (await expectStatus(adminApi('POST', '/v1/previews', single), 200, '预览 M402')).body;
  check(preview.image && !preview.problems.some((problem) => problem.level === 'severe'), `M402 预览有严重问题：${JSON.stringify(preview.problems).slice(0, 500)}`);
  step('模板与数据集仍能出图', { problems: preview.problems.length });

  check(pageErrors.length === 0, `控制台有脚本错误：${pageErrors.join('；')}`);

  // 日志里没有密钥：本次生成的密码、会话与代建令牌都不在服务日志里。日志另存一份供 key 扫描。
  const logs = capture('docker', ['compose', 'logs', '--no-color', '--no-log-prefix', 'setup', 'api', 'worker']);
  await writeFile(join(out, 'service-logs.txt'), logs);
  const secrets = [platform.password, platform.token, adminPassword, adminToken, engineerToken];
  const leaked = secrets.filter((secret) => logs.includes(secret)).length;
  check(leaked === 0, `服务日志里出现了 ${leaked} 项密钥`);
  step('服务日志里没有本次生成的密钥', { lines: logs.split('\n').filter(Boolean).length, secrets: secrets.length });
  status = 0;

  if (options.walkthrough) {
    const guest = await openTenant(platform, { name: '走查客户', plan: { monthlyImages: 1000, maxPixels: 100_000_000, concurrency: 2 }, domain: 'walkthrough.acceptance.test' });
    const workspace = join(out, 'walkthrough');
    await cp(M402_DIR, workspace, { recursive: true });
    push(guest, workspace, resources);
    await expectStatus(call('PUT', '/v1/approval-policy', { token: guest.admin.token, body: { templates: true } }), 200, '打开审批策略');
    // 一份待批准的申请：代建工程师改了子模板"道路段"的一个颜色。
    await recolor(workspace, '#1E8449', 'template-road-segment.json');
    const pending = renderweave(['push', '--server', API, '--tenant', guest.id, '--workspace', workspace, '--resources', resources], { RENDERWEAVE_AUTHORING_TOKEN: guest.engineer });
    check(pending.code === 0 && JSON.parse(pending.stdout).request, `走查用的申请没有记下：${pending.stderr.slice(-500)}`);
    const file = join(out, 'walkthrough.txt');
    await writeFile(file, `控制台：${API}/console/\n租户：走查客户\n客户管理员：${guest.admin.email}\n初始密码：${guest.admin.password}\n`);
    report.walkthrough = { console: `${API}/console/`, tenant: guest.id };
    console.log(`\n真人走查的环境已就绪：地址与账号在 ${file}`);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = status === 0;
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  if (!options.keep && !options.walkthrough) run('docker', ['compose', '--profile', 'test', 'down', '-v', '--remove-orphans']);
}
console.error(status === 0 ? `验收通过，报告：${join(out, 'report.json')}` : `验收没有通过，报告：${join(out, 'report.json')}`);
process.exitCode = status;
