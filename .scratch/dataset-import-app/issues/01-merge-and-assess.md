# 01：合并实现并核对应用接入

**What to build:** 拉取并合并远端与 Excel 实现，给出按静态数据定义导入数据集的应用接入方案。

**Blocked by:** 无

**Status:** resolved

**Trace:** 用户“请拉取代码并合并然后看看”；M374。

- [x] 远端与实现分支都已合入 main，保留本地文档更正与未提交文件。
- [x] 编号冲突消除，活动使用说明与上下文不再把实现称为独立分支限定能力。
- [x] 构建、类型检查与相关 CLI、Excel、服务/页面回归通过。
- [x] 写清产品入口、复用代码、缺失合同、运行时区别与实施顺序。

**测试接缝：** 合并后的公开 CLI、Excel 审核/出图入口及服务内存后端/控制台浏览器用例；本次不调用付费模型，不宣称 Docker 后端或生产托管验收。

## Answer

2026-11-03。已运行 `git fetch origin --prune`，将 `origin/main`（`7b4a782`）合入为 `b136693`，再将 `feature/excel-template-115`（`baede19`）合入为 `417ca6e`。两项 `git merge-base --is-ancestor <来源> HEAD` 都返回 0；未推送远端。

合并前核对了主检出的 51 个改动文件：48 个与实现分支内容一致，票据 02 多一段归档说明，另外两份为独立报告。完整备份保留在 stash `255b1af91685e75459499e900b0a7cc150b9fd98`，原 main 保留为 `backup/pre-excel-merge-20261103`；本机清单在 `out/merge-20261103/pre-merge-files.json`。一致内容由分支合并带入，额外段落已恢复，两份报告恢复为未跟踪文件且 SHA-256 与合并前相同。没有删除原分支或历史运行产物。

冲突处理：两侧 `.gitattributes` 规则均保留；M358 的站名圈号更正与远端 M359–M362 并存；Excel 分支原 M359–M369 顺延为 M363–M373，相关活动文档同步，冻结模型证据没有改字节。`src/cli.ts` 自动合并后保留远端命令及 Excel 新命令，CLI 回归通过。

验证：

- 首次引擎检查报本机缺少锁文件已有的 `@anthropic-ai/sdk`，运行 `npm ci --no-audit --no-fund` 补齐依赖；锁文件没有改动。
- `npm run build`、`npm run typecheck`、`npm run typecheck:service` 均通过；`npm --prefix service run build` 通过，控制台构建 66 个模块。
- 设置 `RW_BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe`，运行以下回归，**13 个文件通过，156 项通过、2 项跳过**，80.09 秒；日志在本机 `out/merge-20261103/targeted-tests.log`。

```powershell
npm test -- test/agent-excel.test.ts test/agent-excel-comments.test.ts test/agent-output.test.ts test/cli.test.ts test/cli-reliability.test.ts service/test/datasets.test.ts service/test/imports.test.ts service/test/definitions.test.ts service/test/definition-session.test.ts service/test/definition-publish.test.ts service/test/approvals.test.ts service/test/console.test.ts service/test/console.browser.test.ts --maxWorkers=4
```

两项跳过来自内存后端的进程内 worker：进行中批次取消及相关状态栏用例（`service/test/console-suite.ts:421`、`:444`）。其他控制台浏览器用例实际运行。本次没有重跑 Docker 后端、真实模型或全量评估；不将回归通过扩大为新智能导入页面已完成。

成果：[应用接入方案](../../../docs/excel-agent-app-integration.md)，M374，以及下一张[按静态数据定义创建数据集](02-create-by-static-schema.md)。当前能力与使用说明已更新为合入 main；服务端任务、隔离工具、整组应用和智能导入页面明确为后续实现。
