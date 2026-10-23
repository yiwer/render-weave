# 01: 依据命名区域修正模板并保存可恢复的检查点

**What to build:** 有界区域目标与纠偏流程，工具可观测的进度检查点及恢复。

**Blocked by:** 无

**Status:** resolved

**Trace:** [规格](../spec.md) A01–A05；用户 2026-10-22 指示继续下一步。

- [x] 命名区域与核准状态，按需返回完整诊断。
- [x] 两次以内的纠偏与前后证据指针。
- [x] 缺失进度反馈、候选绑定及检查点交接。
- [x] 公开入口测试与两轴 review。
- [x] 真实 Haiku 门槛、像素与交接对照。

**测试接缝：** verifyTemplateDesign、MCP check_outcome、runAgentTask。

## Answer

2026-10-22。运行实现冻结于 `2d8d7d0`，登记协议 `docs/template-design-refinement-protocol.md`；最终机器对照为 `docs/template-design-refinement-comparison.json`，解释与图示见 `docs/template-design-refinement-results.md`。

- A01–A02：计划可声明最多 12 个命名区域及 proposed/approved 状态；`designTarget` 按需披露，默认摘要保持 8000 字符。纠偏指导最多两次、跨接续累计，保存前后候选证据；这是提示词约束，未实现宿主强制计数。M402 五区均待核准，styles 为空，没有冒充核准字号。
- A03–A04：只读 MCP 记录宿主检查点，绑定 state、候选哈希及可选详细记录；变更后旧检查点不复用。候选扫描拒绝目录联接；旧 state 兼容并标示未绑定。核心 1019 字符，真实六次启动 skills 均为空、工具数 13。
- A05：冻结前 `npm run typecheck` / `npm run build` 通过，`npx vitest run --project engine` 45 文件 967 用例通过。Standards 初审目录联接越界和 Spec 初审旧计划无目标分支已修复并回归，两轴复审 0 未解决。
- `npx tsx scripts/agent-eval/run.ts --repeat 2 --jobs 1 ... --label template-design-refinement` 以 User OPEN_CODE_API_KEY、Haiku 5.5 完成 8/8 单元，10 实际轮次累计 72.0 分钟；完整参数见结果文档。两次 `node scripts/agent-handoff-eval.mjs --limit 60000 ...` 均仅接续一次。四个最终模板 10/10 压测、2/2 版面、8/8 边界通过；图页在两种宽度验证 8 候选、80 次区域选择，无错误。

验收偏差与效果边界：真实中断前检查点覆盖仅 1/2；另一组只恢复候选。详细视觉记录在中断前两组均未保存，详细记录恢复仅由自动化测试覆盖。新无阈值平均峰值 96,978.5 / 6.51 分钟，交接 78,450.5 / 7.33 分钟，均高于 P1；全图像素略升但服务区下降，不能宣称整体质量收益。检查点自述仍可能写错站数。M307 的机制与实验已交付，后续内容门槛、样式核准及新反馈修复率不在本票验收内。
