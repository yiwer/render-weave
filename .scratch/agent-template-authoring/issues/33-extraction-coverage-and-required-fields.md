# 33: 提取成果保留全部业务信息并正确表达未知值

**What to build:** 把数据定义与最小样例数据、图上业务内容覆盖记录一起核对，修复站码必填、无依据固定业务信息及累计分钟漏项。

**Priority:** P1

**Blocked by:** 无

**Status:** resolved

**Trace:** 第三阶段 PRD；2026-10-21 用户要求；[同图复跑报告](../../../docs/agent-arabic-retest.md)。

- [x] 原始示例重新提取时站码可选；15 个已知缺编号不能被无说明放过。
- [x] 峰段、付款、换乘有效期等不能无依据归为全市固定常量；终点不重复存，QR 占位不臆造内容。
- [x] 数据集累计分钟遗漏必须被覆盖检查发现，推导值有依据，未知的第 2–5 站不编造。
- [x] 覆盖记录区分字段、派生、参数、固定标签与待确认；Agent 自述不能替代独立事实核对。
- [x] 保存首次结果与反馈结果分别评分，用原失败场景验证后再关闭。

**测试接缝：** 公开 Agent / 渲染 / CLI 入口；资料变更的真实模型门槛在票据 38 统一验收。各票特有证据见条目。

## Answer

- 完成日期：2026-10-22
- 核心实现：
  1. 新建 `src/agent/coverage-verification.ts`：导出 `verifyExtractionCoverage`、`scoreExtractionCoverage`、`ROUTE_SIGN_BUSINESS_BASELINE`，实现公交线路牌领域的业务内容基准核查。
  2. 数据定义提取核查：站码字段 `required` 且示例有已知缺值时报 `fieldShouldBeOptional`（严重）；已知缺编号未在待确认或覆盖记录中说明时报 `omissionWithoutExplanation`（字段必填时严重，可选时提示）；只有明确声称“全市统一 / 固定常量”时才核查依据，报 `unjustifiedConstant`（严重）——图上没有出现、也没建字段不算常量；终点站重复建立独立字段而未派生时报 `duplicateTerminalField`（严重）；二维码占位臆造可推导内容时报 `fabricatedQrContent`（严重）。
  3. 数据集提取核查：只有数据定义确实有 `minutesFromStart` 时才要求数据集承载；累计分钟全部留空且未列待确认时报 `missingBusinessCoverage`（严重）；每个非缺省值都要有来源（逐项待确认，或在覆盖记录中说明整列来源），否则报 `fabricatedUnknownValues`（严重）；待确认项标记 `inferred` 但说明缺少计算依据时报 `missingDerivationBasis`（严重）。第 1 站的 0 分钟不强制说明。
  4. outcome.json 扩展可选的 `coverage` 数组：每项含 `id`、`label`、`kind`（field/derived/parameter/constant/pending）、可选的 `file`、`path`、`isOptional`、`derivedFrom`、`logic`、`justification`、`sampleOmissions`、`notes`；Agent 可提供覆盖记录作为独立核对材料，不提供时由基准与候选文件自动推断。写法已补进 `agent/reference/outcome.md`、`agent/tasks/definition-extraction.md`、`agent/tasks/dataset-extraction.md` 与 `docs/agent-tasks.md`。
  5. `checkAgentOutcome` 在数据定义提取和数据集提取任务中自动接入覆盖核查，异常暴露在 `assessment.coverage` 与 `problems` 中；严重异常导致 verdict 为 `unqualified`。`agent run` 把项目说明原文与 route-sign 内容基准写进 `logs/outcome-context.json`，交回前核对与交回后校验共用。
  6. 评分五维各 20 分（必填准确性、缺值处理、常量合法性、派生合法性、内容完整性），总分 100，含严重异常或总分 <80 判 `passed: false`。
- 验收命令：
  - `npm run typecheck`：通过，0 错误；
  - `npx vitest run test/agent-coverage-verification.test.ts`：8 个专项测试全部通过（含 M402 不建未出现字段、366 无分钟列两条回归）；
  - `npx vitest run test/agent-eval.test.ts`：22 个用例通过（修复覆盖核查对历史评估夹具的误报）；
  - `npm test`：58 个测试文件通过、1046 个用例通过（13 个跳过，1 个文件跳过）。
- 偏差与边界：原失败轮次目录不在本机（`out/arabic-board-retest-2026-10-20/` 未保留），用报告记录的 r1b/r1c/r2/r2b 结构与数值复现；真实模型门槛按票据 38 统一验收。MCP 合同随本票与票据 34 升到 0.9.0，`check_outcome` 只增加输出字段，工具输入不变。

## Comments

- 2026-10-21：用户确认排序并先实施 31、32；当前 Go 额度耗尽，其他票据按顺序后续推进。
