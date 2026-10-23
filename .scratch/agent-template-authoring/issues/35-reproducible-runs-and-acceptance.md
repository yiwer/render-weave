# 35: 普通轮次保存可复现资料，修复用原失败场景验收

**What to build:** 复用评估清单能力，记录源码、实际提示词、资料和素材哈希；实施检查和业务效果分别验收。

**Priority:** P1

**Blocked by:** 无

**Status:** resolved

**Trace:** 第三阶段 PRD；2026-10-21 用户要求；[同图复跑报告](../../../docs/agent-arabic-retest.md)。

- [x] 普通轮次与评估共用源码及资料清单生成逻辑，记录工具合同、实际任务提示词和模型配置。
- [x] 验收记录首次成功、反馈修正、受阻与未覆盖边界；空骨架首检零问题不能单独代表模板质量。
- [x] 保留复跑命令、输入与预期；后续 coding agent 不需从聊天历史还原条件。

**测试接缝：** 公开 Agent / 渲染 / CLI 入口；资料变更的真实模型门槛在票据 38 统一验收。各票特有证据见条目。

## Answer

- 完成日期：2026-10-22。
- 普通轮次与评估复用 `src/agent/provenance.ts`，前者保存实际 prompt、实际资料副本与哈希、源码提交/脏状态、工具合同及引擎标识；模型配置留在 round.json。参考输入固定后验哈希继承。
- 命令：`npm test`（1049 通过、13 跳过），`npm run typecheck`、`npm run typecheck:service`、`npm run build` 全通过；`node --import tsx scripts/accept-agent-visual.mjs` 验证初稿、错误、修正、能力受阻，`node --import tsx scripts/accept-agent-content-replay.mjs` 分别重放原失败与反馈轮，`node scripts/accept-m402.mjs out/agent-visual-m402-regression` 验证现有渲染。
- 成果与复跑输入见[视觉反馈](../../../docs/agent-visual-feedback.md)和[复核报告](../../../docs/agent-33-34-review.md)。普通轮次公开入口测试核对实际发出的 prompt 与留存一致、资料/基准哈希、篡改后继承被拒绝。
- 偏差与边界：仅代码与离线验收完成，真实模型效果仍由 38 验收；原阿拉伯文输入需恢复不入库材料。脏工作区清单能识别变更但不能单凭哈希恢复源码。空骨架能渲染会返回参考缺项，未测量部分不会变成视觉通过。

## Comments

- 2026-10-21：用户确认排序并先实施 31、32；当前 Go 额度耗尽，其他票据按顺序后续推进。
