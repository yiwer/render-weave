# 17: 数据定义是独立的实体，发布只产出静态数据定义

**What to build:** 用户走查后第三次纠正模型：Schema 主键是 key，StaticSchema 不可变、主键是 key+version；发布只是创建一个 StaticSchema，对 Schema 毫无影响，Schema 能继续修改、继续发布。照 `E:\GenCode\RenderWeave` 做（`GLOSSARY.md:8-9`、`docs/adr/0002-static-publications-are-immutable.md`），不设"草案"这个东西。

**Blocked by:** 16

**Status:** resolved

**Trace:** ADR-0030，M389；取代 ADR-0028 里草案的部分与 M384 的"基于的版本""用这一版覆盖草案"，版本的部分不变。

- [x] 数据定义有自己的表，主键（租户, key）；存量的每个名称都补出一行，内容是最新静态版本去掉版本号。
- [x] 发布只写静态版本，数据定义的内容、哈希、保存人、保存时间逐项不变；和哪版比较读取时现算。
- [x] 接口没有 `/draft`：`POST /v1/definitions`，`GET`、`PUT`、`DELETE /v1/definitions/{名称}`，`.../check`、`.../publish-check`、`.../publish`。
- [x] 推送第一次带来一个名称时建数据定义；已有的不动，删掉过的不复活。
- [x] 删除数据定义不影响静态版本，静态版本标"来源已删除"；有过静态版本的名称不能再新建。
- [x] 复制静态版本成新的数据定义，要换名称。
- [x] 列表每张卡片都能进编辑；页面上没有"草案""复制为草案""用这一版覆盖"。
- [x] 内存与 PostgreSQL 两种后端；Docker 后端、`accept-p1.mjs` 通过。

**测试接缝：** `service/test/definitions-suite.ts`、`definition-publish-suite.ts`、`push-web-suite.ts`、`console-suite.ts`。

## Answer

2026-11-04 完成。决定在 ADR-0030 与 M389。

**成果：** 迁移 `service/migrations/0017_definitions_are_entities.sql`；部署步骤 `service/src/postgres/data-steps.ts`（`main.ts` 的 `setup` 调用）；接口 `service/src/api/definitions.ts`，开放 API 1.13.0；推送规则 `service/src/push.ts` 的 `pushedDefinitions`；页面 `service/console/src/pages/definitions.tsx`、`definition-studio.tsx`、`definition-publish.tsx`、`static-schemas.tsx`。

**跑过的命令与结果：**

- `npx vitest run --project service`：27 个文件通过、3 个跳过，251 项通过、32 项跳过（要浏览器或 Docker）。
- `RW_BROWSER=…msedge.exe npx vitest run --project service service/test/console.browser.test.ts`：28 项通过、2 项跳过。
- `COMPOSE_PROJECT_NAME=rw-model RW_API_PORT=28080 RW_WORKER_PORT=28081 RW_ALPINE_MIRROR=https://mirrors.aliyun.com node service/scripts/test-docker.mjs`：22 个文件，215 项全过，日志 2,928 行全部合格。
- 同样的项目名与端口跑 `RW_BROWSER=…msedge.exe node service/scripts/accept-p1.mjs --walkthrough`：15 步全过。
- `service/` 下两项类型检查通过。引擎组没有重跑：这张票没有改 `src/`、`test/`、`schemas/`。

**存量升级演练（已验证）：** 把 2026-11-04 走查环境（迁移版本 15，2 个租户）用 `pg_dump` 与只读挂载复制到一次性项目 `rw-upgrade`，用新代码起服务：`setup` 应用迁移 16、17，补了 3 个数据定义，原来有草案的"验收客户/线路牌"内容与保存人不变，标记清掉；静态版本两边相同，模板 5 个、数据集 1 份不变；`/draft` 答 404。原环境的容器 ID 与状态前后一致。

**页面（已对照）：** Edge 无头走了列表 → 编辑 → 保存 → 发布 → 回到列表 → 接着改 → 静态详情 → 复制 → 删除 → 来源已删除，11 张截图看过，页面上"草案"出现 0 次，没有脚本错误。对照的是 `E:\GenCode\RenderWeave` 的模型与术语，不是它的像素；页面沿用现有的样式。**真人没有走过。**

**偏差：**

- **顺带修了 main 上本来就红的两条 Docker 用例，都是 M385 合并留下的**：`rls.docker.test.ts` 的表清单没有 `agent_jobs`；`service/Dockerfile` 的 test 阶段没拷 `service/scripts/reconcile-agent-migration.sql`，`migrations.docker.test.ts` 读不到。不修这张票的 Docker 全量过不了。
- **放宽了两处等待**：控制台用例里两个 `expect.poll` 默认只等 1 秒，负载下偶尔来不及：静态版本列表等 15 秒，模板设计的预览等 10 秒，失败时带上预览回答的问题。单独跑控制台全过，全量也全过；没有查每一步实际耗时。
- **用例的输入**：`version=2oops` 在 ADR-0028 之后已是合法的版本写法，改成确实不合法的 `UP`。
- **来源删了之后"谁在用"读不到**：静态版本页与列表写"—"，见 M389。
- **`accept-p1.mjs` 的第 5 步变了**：不再"复制为草案"，直接打开数据定义。`docs/p1-acceptance.md` 的验收结论针对纠正之前的模型，只加了说明。
- **开放 API 的 `/draft` 路径不兼容地换掉了**：相对 1.0.0 基线的兼容检查仍然通过，因为基线里没有它们。
- **和 `claude/definition-sources` 会冲突**：它改过这里面的 13 个文件，它的 M368–M376 也和 main 撞号，合并时要改号、适配新接口。
