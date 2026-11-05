# 07：合并远端命名版本并推送

**What to build:** 保留本地数据集智能导入与远端命名版本的功能和提交历史，解决交叉接口与迁移冲突后推送 main。

**Blocked by:** 无

**Status:** resolved

**Trace:** 用户“提交 push”；M385。

- [x] 合并双方实现，智能导入与无模板新建使用精确命名版本。
- [x] 迁移编号连续，新安装、远端已有迁移、旧 Agent 测试库都有可验证路径。
- [x] M 编号、ADR 与开放 API 版本去重，快照与实现一致。
- [x] 完成合并范围的回归、保留运行目录及主检出的无关文件，明确全量测试限制。

**测试接缝：** 浏览器经真实 HTTP API；迁移器对独立 PostgreSQL 临时库；引擎与服务公开入口。

## Answer

2026-11-04：远端 main 在普通推送前增加了 `0235d16`、`7377f1b`。在独立工作树 `render-weave-sync-push` 合并，不重建或升级正在运行的 `render-weave-dataset-import-app`。

- 开放 API 合并为 1.12.0；远端 M363–M368 重编号 M379–M384，本地 Excel 隔离 ADR 草案改为 0029，远端已接受 ADR-0028 保留。
- 智能导入的请求、任务、证据、宿主选版本和 URL 预选支持命名版本；无模板新建不再把字符串版本转换成 NaN。
- 保留 `0015_named_schema_versions.sql`，Agent 迁移原字节移至 0016。旧内部测试库升级说明在 `docs/dataset-import.md`，显式编号转换脚本在 `service/scripts/reconcile-agent-migration.sql`；脚本核对旧哈希且持有迁移咨询锁。
- `npm run build`、`npm --prefix service run build`、`npm run typecheck`、`npm run typecheck:service` 通过。
- `npx vitest run --project service --maxWorkers=4`：248 通过，32 跳过（未在这一命令启用浏览器）。
- `RW_BROWSER=<Chrome> npx vitest run service/test/agent-jobs.browser.test.ts service/test/deliver-parameters.browser.test.ts --maxWorkers=1`：2 通过；随后补充命名版本手工新建并单独复跑导入浏览器用例，1 通过。覆盖上传预选、批注/VML 核对、人工修改、整组保存、打开数据集、同定义手工新建，以及出图缺参数不提交。
- `npx vitest run --config service/vitest.docker.config.ts service/test/migrations.docker.test.ts`：隔离 PostgreSQL 17 容器，8 通过，覆盖空库、远端 15 升级至 16、旧 Agent 15 先拒绝再显式转换并补执行缺失 15、二次转换拒绝；未使用现有业务库。
- `npx vitest run service/test/openapi.test.ts -u --maxWorkers=1`：5 通过，快照已核对；`git diff --check` 通过。

- `npx vitest run test/agent-excel.test.ts test/agent-excel-comments.test.ts test/agent-excel-mapping.test.ts test/agent-excel-sandbox.test.ts test/schema.test.ts test/dsl-schema.test.ts test/dsl-template-schema.test.ts --no-file-parallelism`：7 个文件、138 项通过，75.57 秒。
- 引擎全量命令 `npx vitest run --project engine --maxWorkers=4` 已尝试但未完整通过，出现 Agent 恢复/预算/检查点等超时或失败后中止，不作为全量通过依据。临时工作树最初复用 node_modules 联接，冻结候选用例明确拒绝它；保留联接并换用独立安装的依赖后，`npx vitest run test/agent-candidate-freeze.test.ts -t '冻结实际构建' --no-file-parallelism`：1 通过、8 按选择器跳过，36.99 秒。
- 文档换行导致 `dsl-template-schema` 的一个示例提取失败，规范为 LF 后单文件 29 项通过。
- 独立依赖串行复测中，`agent-rounds` 的“下一轮沿用上一轮的输入”仍在 60 秒超时。另建基于合并前 `d62b42b` 的独立工作树，在同一机器按相同选择器复跑：同一个用例同样 60 秒超时（`test/agent-rounds.test.ts:276`），证明该项不是本次合并新增。其余全量失败未逐一完成串行对照，不宣称全部属于同一原因。
- 测试终端中断不影响现有业务进程。曾被自动审批拒绝的“杀进程树并替换依赖”组合命令没有执行；后续使用终端中断及保留原联接的移动操作完成环境调整。
- 主检出两份未跟踪视觉评估报告 SHA-256 与开工时一致，未暂存；正在运行的 115 服务目录保持干净，数据库不升级。

本机复测日志在本工作树的 `out/push-focused-tests.log`、`out/push-freeze-test.log`、`out/push-serial-tests.log`；合并前对照在 `F:/GenCode/render-weave-push-baseline/out-baseline-test.log`。

下一步：在低负载环境逐文件串行复核剩余 Agent 全量失败；本票不把此环境的全量回归记录为通过。
