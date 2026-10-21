# 31: 成果评估区分静态合法与可出图，受阻轮次交回可查看草稿

**What to build:** 统一交回检查、审核与应用的渲染评估；已知能力阻塞允许交回草稿，未提交成果时宿主保存单独的恢复草稿。

**Priority:** P0

**Blocked by:** 无

**Status:** resolved

**Trace:** 第三阶段 PRD；2026-10-21 用户要求；[同图复跑报告](../../../docs/agent-arabic-retest.md)。

- [x] 指定请求有 text.unshapedScript 时，check_outcome 明确渲染受阻，不能仅返回静态合格；数据内容仍标为需要审核。
- [x] 受阻但结构合法的 outcome 保留候选和说明，可以查看草稿；确认待确认项后也不能批准或应用严重问题模板。
- [x] 没有 outcome 的中断轮次保存独立 draft.json、候选哈希和问题；明确宿主恢复来源，不伪造 Agent 正式成果；审核页可查看但不可通过。
- [x] 下一轮可恢复候选；候选变更后重新评估，不能信任旧 assessment。
- [x] 提示词不再要求消除已知引擎能力问题后才能交回；保持 M271 的正式出图拦截。
- [x] 公开入口与假执行器测试覆盖正常、受阻、损坏、恢复、审核及应用；模型复跑转票据 38。

**测试接缝：** 公开 Agent / 渲染 / CLI 入口；资料变更的真实模型门槛在票据 38 统一验收。各票特有证据见条目。

## Answer

2026-10-21：按 M277、ADR-0021 实施。共享渲染评估在 `src/agent/assessment.ts`；交回检查使用完整请求，审核展示能力阻塞，应用前在当前工作区重渲染。`run.ts` 另存 `renderweave-draft/1` 和候选哈希，`review.ts` 标明来源并拒绝恢复草稿的审核操作。模板提示词与成果参考统一以 outcome.md 中的受阻分支结束，合同升 0.8.0。

- `npm test`：47 个文件、966 个用例全部通过（45.40 秒）；包括实际 MCP、假执行器、草稿恢复与哈希改动拒绝、审核后数据变化使 overwrite 应用受阻。
- `npm run typecheck`、`npm run build`、`npm run typecheck:service`、`git diff --check` 通过；合同快照只变更 check_outcome 说明，已核对。
- 原失败候选离线回放：`node out/arabic-board-retest-2026-10-20/probe-readiness-after.mjs`；旧 r6 与本次 r3 均为 structure/candidates valid、content needsReview、render blocked，各 75 条 text.unshapedScript；草稿有图、正式无图。结果保存在同目录 `probe-readiness-after.json`，历史轮次未改写。
- 偏差与边界：未调用付费模型；模型是否按新提示词及时交回、真实视觉质量与原图完整流程在票据 38 验收。既有旧轮次不会自动补写 draft.json，仍可用 --from 恢复原候选。

## Comments

- 2026-10-21：用户确认排序并先实施 31、32；当前 Go 额度耗尽，其他票据按顺序后续推进。
