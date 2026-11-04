# 03：工作簿智能导入、来源审核和整组保存页面

**What to build:** 用户选确切静态数据定义，上传工作簿，查看后台执行并核对来源、批注和候选，确认后整组保存普通数据集。

**Blocked by:** 02

**Status:** resolved

**Trace:** M375；[规格](../spec.md)；用户“ok 构建该模块以及具体页面”。

- [x] 独立 Agent worker 使用 Tool Runner + Claude/OpenCode Go，脚本进固定隔离容器，候选再过独立检查。
- [x] 任务、素材、事件和审核持久化；刷新恢复、取消与过期租约处理有验证。
- [x] 上传、任务记录、详情、来源/批注/VML、人工修改和完整保存页面可用。
- [x] 真实 PostgreSQL/S3 验证整组事务、冲突、幂等、租户隔离；保留原标准表批量出图合同。
- [x] 真实模型小样与服务端完整任务通过；记录实际用量、未知扣费与审核工时。
- [x] 操作/启动说明、OpenAPI、决定与上下文同步。

**测试接缝：** 公共 HTTP 合同同时跑内存及 PostgreSQL/S3；浏览器用确定性提取器，单独验证真实模型，避免日常回归产生模型费用。

## Answer

2026-11-03。应用模块、页面、工具宿主和存储迁移已实现。主要文件见 [使用说明](../../../docs/dataset-import.md)，页面截图已归档到 `docs/images/dataset-import/`；真实调用摘要见 [报告](../../../docs/agent-eval/reports/2026-11-03-dataset-import-app.json)。

验证命令与结果：

- `npm run build`、`npm run typecheck`、`npm run typecheck:service`、`npm run build --prefix service` 通过。OpenAPI 快照有意升至 1.10.0，新增任务响应、八条端点及请求合同；`npx vitest run service/test/openapi.test.ts service/test/agent-jobs.test.ts -u --maxWorkers=1` 9 项通过，快照差异已核对。
- `RW_BROWSER` 指向本机 Chrome，`npm test -- --project service --maxWorkers=4`：26 个文件、253 项通过，2 项原有内存 worker 用例跳过，94.74 秒。新页面实际上传、刷新、查看批注/VML、多行原文、附原因改值、整组保存和打开数据集都通过。修复了既有审批开关保存后回跳，以及模板测试在写回响应之后才注册监听而漏掉预览请求的时序问题。
- `npx vitest run test/agent-excel.test.ts test/agent-excel-comments.test.ts test/agent-output.test.ts test/cli.test.ts service/test/agent-jobs.test.ts --maxWorkers=4`：5 个文件、57 项通过，77.45 秒。
- PostgreSQL/S3：独立 Compose 项目 `rw-dataset-module-test`，只启 postgres/s3，主机测试进程经仅本机端口连接。`setup` 从空库应用迁移 1–15；随后 `npx vitest run --config service/vitest.docker.config.ts agent-jobs.docker.test.ts storage-contract.docker.test.ts api.docker.test.ts migrations.docker.test.ts`：4 文件、33 项通过，48.20 秒。覆盖末项冲突整组回滚、幂等、租户隔离、取消和租约过期；存储合同与迁移/RLS 用例也通过。
- 两次真实 Claude Haiku 5.5 + OpenCode Go 调用：正式工具入口 69,329 ms，8 turns、4 次转换尝试，前 3 次被独立检查拒绝，第 4 次通过；没有注入缺陷。完整服务任务 `9f1f8fee-e77b-41d1-bdc0-09cb79438f30` 到 `applied`，保存 `material-live-app-01`。合成物料批注小样的 A1、B2 及 C3 空批注按独立真值核对后，仅在临时内存租户中确认保存。原始文件在 `out/dataset-module/live/` 与 `live-service/`，模型用量见摘要报告。
- `node scripts/scan-keys.mjs out/dataset-module/live out/dataset-module/live-service docs src agent/excel service/src service/console/src service/test .scratch/dataset-import-app`：846 个文件，环境中模型 key 及前后片段均 0 命中。最终新增摘要再扫描。

偏差与边界：完整 Compose 镜像构建分别遇到 Alpine 源拒绝连接、Docker Hub TLS 超时；已补运行镜像的可选镜像源配置，并用真实 PostgreSQL/S3 容器完成上述替代验证，未宣称完整镜像部署通过。首版仍是默认关闭的内部能力，轮询而非 SSE；任务重试不迁移人工修改，候选身份固定。115 原件新版网页业务走查、含图片资源引用定义、生产隔离和 P0/P1 原门槛仍未验收。人工业务审核工时与实际扣费未知。
