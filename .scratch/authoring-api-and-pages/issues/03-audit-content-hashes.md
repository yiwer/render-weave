# 03: 审计记下每次代建写入的前后内容哈希与差异摘要，可按主体筛选并导出

**What to build:** 审计表加前后内容哈希、差异摘要、轮次与理由；审计接口与管理页按主体种类筛选、导出 CSV。

**Blocked by:** 无

**Status:** resolved

**Trace:** [P1 PRD](../spec.md)「审计」；用户故事 26；验收 A08、A10；ADR-0022、M261、M263。

- [x] 迁移给 `audit_events` 加可空列：前内容哈希、后内容哈希、差异摘要（增删改计数，加至多 50 个路径）、轮次、理由；旧行保持空。
- [x] 写审计的辅助函数接受这些字段；指回旧修订填前后修订的内容哈希，推送提交在差异摘要里列出改动的文档与各自的前后哈希（至多 50 份）。
- [x] 审计接口回答新字段，按主体种类（成员、API 密钥、代建工程师、平台管理员、系统）与时间筛选；OpenAPI 只加可选字段与参数。
- [x] 管理页的审计日志显示内容哈希与差异摘要，可按主体筛选，筛选结果导出为 CSV。
- [x] 跨租户的操作照旧标出；别的租户的审计行在 Docker 后端被行级安全挡住。

**测试接缝：** 开放 API：做一次推送与一次指回，再从审计接口读回断言字段；导出 CSV 经接口断言。

## Answer

完成于 2026-10-28，分支 `claude/upbeat-morse-d8011e`（提交 b374056 起）。

**成果**

- 迁移 `service/migrations/0010_audit_content.sql`：`audit_events` 加可空列 `before_sha256`、`after_sha256`、`diff`、`round`、`reason`，旧行保持空；另加按主体种类的索引。差异摘要用 `json` 不用 `jsonb`，按写入的原文保存，两种后端导出的 CSV 逐字相同。
- 写审计：`AuditContent`（`service/src/backend.ts`）随 `appendAudit` 写入；`auditDiff`（`service/src/audit.ts`）算增删改计数、路径只留前 50 项。推送提交用 `pushAuditDiff`（`service/src/push.ts`）列出改动的文档与资源及各自前后哈希；指回旧修订（`template.setCurrent`）记改前改后两个当前修订的内容哈希，存储接口 `setCurrentTemplate` 改为同时答出改之前的修订号。
- 接口：`GET /v1/audit-events` 加 `actorKind`、`from`（含）、`to`（不含）；新增 `GET /v1/audit-events/export.csv` 按同样筛选导出（列名同接口字段，`diffPaths` 是 JSON，UTF-8 带 BOM、CRLF，公式字符开头的格子加单引号，至多 10,000 条，超出答 400）。OpenAPI 只做加法，升 1.1.0，`docs/api.md` 变更记录与 `docs/api/openapi.json` 快照已更新。
- 控制台：审计日志挪进 `service/console/src/pages/audit-log.tsx`，显示前后哈希（开头 8 位，悬停看全文）与差异摘要（展开看路径），按主体与日期筛选，导出 CSV。
- 文档：`docs/service.md`「审计」「代建推送」「出图控制台」。

**验证**

- `npm run typecheck` 与 `service/` 下 `npx tsc --noEmit`、`npx tsc -p console/tsconfig.json`：通过。
- 新用例 `service/test/audit-suite.ts`（内存后端进 `npm test`，PostgreSQL 在 Docker 组）4 项：两次推送加一次指回后从审计接口读回前后哈希与差异摘要、别的事件没有这些字段、跨租户照旧标出、别的租户读不到也导不出；55 份文档时路径只留 50 项；按主体种类与时间筛选、带筛选翻页、不合规筛选答 400；CSV 的列、BOM、公式防护与权限。另做了两处变异核对（路径上限改 51、去掉公式防护），用例都会失败。
- `npx vitest run --project service`：14 个文件通过、1 个跳过，107 项通过、13 项跳过（浏览器用例的本机快速版，要设 `RW_BROWSER`）。
- Docker 后端（`node service/scripts/test-docker.mjs`）：16 个文件 141 项。整轮跑出 12 个文件通过（含 `audit.docker.test.ts` 4 项、`api`、`push`）；`rls.docker.test.ts` 因本票新加的种子与已有的局部变量同名而失败，改名后与当时超时的 `console`、`metering`、`records` 在本机空闲时重跑，4 个文件 39 项全部通过。行级安全用例新增：按别的租户的内容哈希查不到，审计内容列也不能改。
- 控制台浏览器用例（Edge，内存后端）：管理员页面那条（含按主体筛选与导出 CSV）通过。
- 全量 `npm test`：本机没能跑绿，未验证。三次全量都与另一个 worktree（`friendly-bhaskara-1592b7`）的全量测试同时进行，CPU 满载，引擎项目大量 60 秒超时，并有 `fixtures/resources` 的 `local.storeBusy`；本分支没有改引擎的 `src/`、`test/`、`scripts/` 与夹具。单独跑引擎的 layout、render、mcp、schema、agent-eval 共 156 项，154 项通过，另 2 项 agent-eval 单跑一项 55 秒通过（时限 60 秒）。下一步：本机没有别的测试在跑时执行 `npm test`。

**偏差**

- 推送提交（`push.commit`）事件本身不填前后哈希：一次推送改多份对象，前后哈希逐份写在差异摘要的每一项里。单一对象的写入（指回旧修订，以及票据 04、07 的草案、工作副本与保存）填事件的前后哈希。
- 轮次与理由按规格本期留空，接口与 CSV 已有字段。
- 导出超过 10,000 条时答 400 要求缩小时间范围，不悄悄截断；这条路径没有用例（要造一万条审计）。
- CSV 的列名用接口字段的英文名，便于程序读取；页面上是中文。客户要中文表头时再加参数。
