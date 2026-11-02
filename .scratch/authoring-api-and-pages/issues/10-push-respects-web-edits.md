# 10: 推送不再覆盖网页上保存的模板，代建工程师用 `renderweave pull` 取回最新内容

**What to build:** 推送清单给模板加可选的 `baseRevision`，服务端据此或据当前修订的来源判定冲突；新增 `renderweave pull` 把租户当前的模板、静态数据定义与编译产物写回本地工作区，并记下修订号供下次推送。

**Blocked by:** 07

**Status:** resolved

**Trace:** [P1 PRD](../spec.md)「推送与网页改动共存」；用户故事 30、31；验收 A09；M264、M265。

- [x] 带 `baseRevision`：当前修订不等于它且内容不同，算冲突。不带：当前修订来自网页保存、指回或批准且内容不同，算冲突。只用推送的租户行为不变。
- [x] 冲突照 M264 整体拒绝（409 `push.conflict`），说明当前修订由谁在何时、以哪种来源产生。
- [x] `renderweave pull --server --tenant --workspace`：写入模板、静态数据定义与编译产物；本地已有且内容不同的文件先列出，`--overwrite` 才覆盖。
- [x] 每次推送或拉取成功后在本地记下各模板的修订号，下次推送自动带上；这份记录不让本地读工作区与 `renderweave render` 报问题。
- [x] 令牌只经环境变量传入，规则同 `push`；`pull` 记审计。
- [x] [代建指南](../../../docs/agent-guide.md)与[出图服务](../../../docs/service.md#代建推送)补上拉取这一步与新的冲突规则；决定记 M 编号。

**测试接缝：** 命令行 `push`、`pull` 对进程内服务（内存后端）跑；网页一侧的保存与指回经开放 API 制造。

## Answer

完成于 2026-11-01。操作写法见[代建指南](../../../docs/agent-guide.md#9-推送到客户的租户)，判断记在 M354。

**成果**

- **迁移** `service/migrations/0013_template_current_origin.sql`：`templates` 记当前修订的来历（来源、动作、主体、时间）；开放 API 的 `TemplateRevisions` 加 `current`，升 1.6.0，只做加法。
- **冲突判定** `service/src/push.ts`：清单的模板可以带 `baseRevision`。带了：当前修订不是它且内容不同算冲突，当前修订是代建工程师自己指回的除外。没带：当前修订不是推送产生的且内容不同算冲突。冲突说明写明当前修订由谁在何时、以哪种来源产生，并指路 `renderweave pull`。
- **`renderweave pull`**（`src/push.ts`、`src/cli.ts`）：写入模板、静态数据定义与编译产物，按身份找本地文件；本地不同的先列出，一个文件也不写，`--overwrite` 才覆盖。令牌规则同 `push`。
- **本地记录**：工作区的 `.renderweave/template-revisions-<租户>.json`，推送或拉取成功后更新，下次推送自动带上；读工作区与渲染都看不到它。
- 文档：[代建指南](../../../docs/agent-guide.md)第 9 步、[出图服务 · 代建推送](../../../docs/service.md#代建推送)。

**验证**

- 新用例 `service/test/push-web-suite.ts` 7 项，命令行对进程内服务跑，网页一侧经开放 API 制造：只用推送不受影响、网页保存与指回之后被挡并说明来源、`pull` 后再推送成功、工程师自己指回不算、别的机器先推送算冲突、拉到空目录、静态数据定义规则不变。
- 变异核对：冲突判定恒为假，三条用例失败。
- 顺带修了 `push-suite`：复制样例时带上了别的用例活动的 `.write-lock`，全并行时偶发 `local.storeBusy`，现在过滤掉。
- 在 worktree 的最终提交上（与 04、05、07、10、12 五张票一起）：`npm run typecheck`、`service/` 下 `npx tsc --noEmit` 与 `npx tsc -p console/tsconfig.json` 通过；`npx vitest run --project service` 144 项通过、17 项跳过（浏览器用例的本机快速版，要设 RW_BROWSER），连跑四次没有偶发失败。
- Docker 后端 `node service/scripts/test-docker.mjs`：20 个文件 172 项全过，三个服务的结构化日志没有不合格的行。这也是合入 M350 之后第一次跑通整组。
- 引擎组（不含 `agent-*` 重型文件）：42 个文件 894 项全过。控制台浏览器用例本机快速版（Edge，内存后端）：15 项通过、2 项跳过。

**偏差**

- 代建工程师自己指回不算网页改动，即使本地记录是旧修订也不算冲突。PRD 写的是"来自网页保存、指回或批准"，但工程师回退后再推送是 M265 的做法，`push-suite` 的用例守着这条，理由见 M354。
- 用例只跑内存后端（票据写的接缝就是进程内服务）；存储一侧的来历在 `push.docker.test.ts` 与 `template-copies.docker.test.ts` 经 PostgreSQL 走过。
