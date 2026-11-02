# 07: 经开放 API 暂存模板工作副本、预览并定位元素，再保存为新修订或指回旧修订

**What to build:** 服务端的模板工作副本（每个模板至多一份，记基准修订）、工作副本的草稿预览与元素定位、复制为新模板、带基准核对的保存模板，以及向客户管理员开放的指回旧修订。

**Blocked by:** 04

**Status:** resolved

**Trace:** [P1 PRD](../spec.md)「模板工作副本」；用户故事 19、21、22、23、29；验收 A05、A10；ADR-0021、ADR-0022、M265、M267。

- [x] 暂存：整份替换，带预期 SHA-256，记基准修订；暂存不影响当前修订，出图照旧读当前修订；可以丢弃工作副本。
- [x] 草稿预览可以指定用工作副本，与已保存模板走同一套检查与限制（`measureRender`、按租户的并发与频率）；问题与本地渲染相同。
- [x] 预览回答带每个元素实例的源模板与在模板文档里的位置，对循环容器与子模板调用都正确；渲染入口把这项作为可选输出公开，从 `src/index.ts` 导出类型。
- [x] 复制为新模板：新名称，内容与基准数据定义取当前修订，成为没有基准修订的工作副本，保存时记修订 1。
- [x] 保存模板：基准修订等于当前修订才保存，否则答 409 带 `revisionDiff` 两边差异；显式 `overwrite` 才覆盖；模板静态检查有严重问题时拒绝；按 M265 记修订，当前修订指向它，删除工作副本；修订记下来源（推送或网页）与主体。
- [x] 指回旧修订开放给有 `authoring.publish` 的客户管理员。
- [x] 客户端点与代建端点共用一份实现；全部进权限矩阵与跨租户端点清单；每次写入记审计，带前后内容哈希与差异摘要；新表启用行级安全；OpenAPI 快照只有加法。
- [x] `GLOSSARY.md`「模板修订」补上网页保存这一来源；决定记 M 编号。

**测试接缝：** 开放 API；元素定位另经引擎渲染入口测，输入用 M402 模板（循环与子模板）；预览问题与本地 `render` 比对。

## Answer

完成于 2026-11-01，提交 ae303cc。接口写法见[开放 API · 模板工作副本](../../../docs/api.md#模板工作副本)，判断记在 M352。

**成果**

- **迁移** `service/migrations/0012_template_working_copies.sql`：每个模板至多一份，记基准修订，开行级安全；`template_revisions` 加 `source`（`push`、`web`）。
- **端点** `service/src/api/template-copies.ts`：新建、读、暂存、丢弃、检查、保存工作副本；复制为新模板；修订历史；列出工作副本。代建端点是同一份实现。`POST /v1/template-current` 把指回旧修订开放给客户管理员，与代建工程师的旧端点走同一个函数。
- **预览**：`workingCopies=true` 时全部工作副本换上，检查与限制一样；预览回答都带 `elements`（元素实例的源模板与位置）。
- **保存**：静态检查有严重问题答 400；基准不是当前修订答 409 `template.revisionConflict`，带 `ours`、`theirs` 两边差异，`overwrite` 才覆盖；字节与当前修订相同记为不变；当前修订指向新修订，删除工作副本。
- **引擎**：`render` 的可选输出 `elementLocations` 与类型 `ElementLocation`，新公开入口 `checkTemplateStatic`，都从 `src/index.ts` 导出。
- `GLOSSARY.md`「模板修订」「工作副本」补上网页保存；OpenAPI 升 1.5.0，只做加法；共用部分抽到 `service/src/api/authoring-documents.ts`。

**验证**

- 新用例 `service/test/template-copies-suite.ts` 9 项（两种后端）；`test/element-locations.test.ts` 3 项，输入是 M402 的循环与子模板；工作副本预览的问题与本地 `render` 比对；权限矩阵与跨租户端点清单各加 19 个端点；`rls.docker.test.ts` 把新表纳入。
- 变异核对：去掉基准核对，两条用例失败；worker 不换上工作副本，三条用例失败。
- 在 worktree 的最终提交上（与 04、05、07、10、12 五张票一起）：`npm run typecheck`、`service/` 下 `npx tsc --noEmit` 与 `npx tsc -p console/tsconfig.json` 通过；`npx vitest run --project service` 144 项通过、17 项跳过（浏览器用例的本机快速版，要设 RW_BROWSER），连跑四次没有偶发失败。
- Docker 后端 `node service/scripts/test-docker.mjs`：20 个文件 172 项全过，三个服务的结构化日志没有不合格的行。这也是合入 M350 之后第一次跑通整组。
- 引擎组（不含 `agent-*` 重型文件）：42 个文件 894 项全过。控制台浏览器用例本机快速版（Edge，内存后端）：15 项通过、2 项跳过。

**偏差**

- 工作副本先 `POST` 开一份再 `PUT` 暂存，同数据定义草案；基准在开的时候定下。
- 用工作副本预览走查询参数，不往 DSL 的渲染请求里加字段。
- 预览换上全部工作副本，保存的静态检查只换上这一份，理由见 M352。
