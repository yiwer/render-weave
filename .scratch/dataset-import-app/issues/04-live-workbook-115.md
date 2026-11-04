# 04：启用应用并走查同一 115 原件

**What to build:** 在独立的持久化本地租户启用智能导入，浏览器上传同一原件，经真实模型和独立来源核查进入审核，与已批准数据逐项核对，再验证保存与兼容模板预览。

**Blocked by:** 03

**Status:** resolved

**Trace:** 用户“继续下一步”；M375 应用模块之后的真实原件验收；M376。

- [x] 独立 PostgreSQL/S3、API、Agent worker 和渲染 worker 可用，原始工作空间与交付不被覆盖。
- [x] 浏览器上传原件并运行真实 Claude/OpenCode Go，刷新后仍能查看后台进度和候选。
- [x] 两方向、64 站、10 条批注及 VML 与独立 OOXML 真值一致；差异有明确处理，不把技术检查冒充业务批准。
- [x] 同源且与已批准字段一致时沿用已有批准范围，在验收租户完整保存，再打开数据集与兼容模板预览。
- [x] 保留可查看的本地入口、运行材料和验收记录；工时、实际扣费未知，新增显示投影不继承旧批准。

**测试接缝：** 浏览器实际上传、生产 worker、真实 PostgreSQL/S3；原件独立解析及已批准候选只交给验收程序，不交给模型。

## Answer

2026-11-04 完成。现场与产物说明见 [应用走查](../../../docs/agent-eval/dataset-import-115-app.md)，机器摘要见 [报告](../../../docs/agent-eval/reports/2026-11-04-dataset-import-115-app.json)。以下命令在 `F:/GenCode/render-weave-dataset-import-app` 执行；本机脚本、截图及原始模型证据保留在忽略目录 `out/dataset-115/`。

- `node out/dataset-115/upload.mjs`：浏览器上传原件，真实模型调用 1 次运行、11 轮、3 次执行尝试，153,890 ms；任务 `f10f692b-254b-452b-8e8b-49c676fc28f0`。
- `python -X utf8 out/dataset-115/independent_source.py freeze`、`node out/dataset-115/verify.mjs`：独立 OOXML 核对两方向 64 站、411 个非空单元格、10 条批注及 10 个 VML 锚点；全部业务字段与此前已批准候选一致。
- `node out/dataset-115/review-browser.mjs`：64 个站名输入值、10 条批注以及 VML 展示核对通过，1600px/800px 无横向溢出、无脚本异常。
- `node out/dataset-115/apply-preview.mjs` 完成整组保存；模板选择框定位失败后补可访问名称，以 `node out/dataset-115/preview-browser.mjs` 接续已保存的数据。真实渲染预览包含 32 站，本站/下一站一致，问题清单为空。没有重复保存或再次调用模型。
- `node out/dataset-115/status.mjs`：重启 API 后查询仍为 `applied`、revision 13、两份候选；数据集为 `115-down-app` 和 `115-up-app`。
- `npx vitest run test/agent-excel-sandbox.test.ts test/agent-excel.test.ts test/agent-excel-comments.test.ts service/test/agent-jobs.test.ts service/test/agent-jobs.browser.test.ts service/test/openapi.test.ts --maxWorkers=2`：6 文件、48 测试全部通过（23.09 秒）。浏览器测试设置本机 Chrome 的 `RW_BROWSER`。
- `npm run typecheck`、`npm run typecheck:service`、`npm run build`、`npm --prefix service run build` 均通过；Vite 保留现有大于 500 kB 的包体提醒。
- `python -X utf8 test/support/excel-sandbox-cleanup.py`：容器已删除而附着进程卡住的取消接缝通过。`agent/excel/execute.py` 重放原 attempt-03 脚本成功且候选不变（5,023 ms）；真实无限循环脚本 1 秒预算返回 timeout、cleanupConfirmed=true（1,680 ms），无本轮容器残留。分别存于 `replay-execution.json`、`timeout-execution.json`。

走查修复：工作表/候选/模板选择框可访问名称；上传页按服务端有效上限展示与预检（默认 5 MiB，OpenAPI 1.11.0）；Docker 容器与附着进程完整回收，并把创建/检查与执行预算分开。前两次模型执行遇到基础设施超时，保留原始失败，不记为模型业务算法修复。

验收边界：沿用同源同字段的既有批准，仅保存到独立本地租户；没有新增人工业务审核。预览使用已批准的 `production-115` 简洁模板，不是参考图新增显示投影，也没有重复生成正式批量交付。人工审核工时与实际扣费未知；完整镜像部署及生产隔离仍须单独验收。
