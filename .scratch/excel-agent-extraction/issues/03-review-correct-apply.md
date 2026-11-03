# 03：将 Excel 候选接入审核、修正重放与完整应用

**What to build:** 以正式 import-excel 命令将固定的提取产物重新校验并交给现有审核与应用流程，支持来源定位、人工改值、重跑修正重放和冲突处理。

**Blocked by:** 02

**Status:** resolved

**Trace:** M362、M363；用户“继续下一步”；流程 P05。

- [x] 导入前独立重读工作簿、重算来源并按工作空间 staticSchema 校验所有候选；拒绝伪造通过标记或不完整集合。
- [x] 正式审核页面展示工作簿、来源映射、排除区域、重放及冲突；人工改值有原因，修改后重新校验。
- [x] 重跑按源位置和原候选值重放人工改动；不匹配时保留冲突，重新确认，不继承批准。
- [x] 完整集合审核与应用复用既有提交回执；部分删除、身份变化和来源变更不能绕过批准。
- [x] 验证嵌套定义、重排、冲突、来源篡改、应用幂等与既有恢复行为；补真实模型样本。

**测试接缝：** 正式 CLI、公开审核/应用入口、独立 Python 校验边界；不直接断言内部私有函数。

## Answer

2026-11-03。实现保留在独立工作树 F:/GenCode/render-weave-excel-prototype、分支 feature/excel-agent-p05，基线 5438a77d8a6c5f3d8bb376dcc5e5c10f37f0a71c。主检出同步文档，不混入原有未提交评估记录。

- 正式入口 src/agent/excel-import.ts、CLI agent import-excel；宿主 Python 在 agent/excel/。固定原件与说明，独立重算所有候选和来源，工作空间 staticSchema 及资源按快照检查，不执行包内脚本。
- src/agent/excel-evidence.ts 记录来源与人工修正；src/agent/review.ts 和 web/review.html 接入固定原件下载、映射、排除区、改值原因和冲突。按来源与原值重放，保留连续重放原因，新一轮重新审核；完整应用、持久恢复沿用既有提交机制。
- 新一轮模型：Claude Code 2.1.296 + OpenCode Go 的 claude-haiku-5-5，catalog@1 两层引用列表，11 轮、146323 ms、2 次转换；首次因 H4 空单元格处理报错，模型修复后通过，无宿主注入。独立真值 6/6 一致；归档在 scripts/prototypes/excel-agent/evidence-p05/nested-01/，失败未删除。
- npm run build、npm run typecheck：通过。
- node node_modules/vitest/vitest.mjs run test/agent-excel.test.ts --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=out/excel-p05/final-tests.json：最终 13/13 通过，归档 host-tests.json。覆盖正式 CLI、HTTP 来源下载、改值约束、修正重放与冲突、嵌套重排、不同批次连续应用、来源篡改、禁止执行包内脚本及 36 份候选提交中的真实强退恢复/证据冲突。
- node node_modules/vitest/vitest.mjs run test/agent-excel.test.ts test/agent-review.test.ts test/agent-apply-recovery.test.ts --maxWorkers=1 --no-file-parallelism：首次 33/33 通过；扩展后既有两文件 25 项仍通过，新增强退两项因测试监视器误匹配 dataset-crash-* 而没有触发，整组为 35 通过、2 失败。修正为真实候选文件名后 Excel 12/12 通过；再增加不执行脚本与连续导入覆盖后，最终为上面的 13/13。不是产品恢复失败，未修改恢复逻辑来绕过测试。
- 正式构建 CLI 再导入归档到 out/excel-p05/nested-final-review：1 份候选、49 条字段来源、9 个固定证据文件，readReview 问题为空、状态 inProgress、canApprove=false。未代替用户批准或应用真实会话产物。
- 审核页脚本通过静态语法检查，HTTP 测试核对原件下载字节与附件响应；浏览器控制返回 The browser access host is unavailable，未完成浏览器交互走查。
- node scripts/scan-keys.mjs scripts/prototypes/excel-agent/evidence-p05 out/excel-p05：最终扫描 157 个文件、检查 1 个 key、命中 0；归档排除临时 Claude 配置、管道配置与 PID。git diff --cached --check 通过；28 个原始证据文件逐字节与 git 暂存区一致，输入/目标/提示词身份全部匹配。归档通过专属 .gitattributes 保留原始 CRLF，避免提交时换行转换破坏哈希。

成果说明：[操作流程](../../../docs/excel-agent-review.md)、[嵌套实测与边界](../../../docs/agent-eval/excel-agent-p05.md)。

偏差与后续：提取仍使用原型 agent-run.ts，正式 agent run 尚未支持工作簿输入、统一检查点和提取进程崩溃恢复；人工修改使用整份 JSON 编辑，浏览器走查待补。当前真实样本是仓库构造的非公交制作表，客户表、多层表头、跨表关联和大表留给 P07；P06 按通用模板参数接出图。ADR-0028 仍为生产隔离草案。
