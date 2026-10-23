# 01: 依据命名区域修正模板并保存可恢复的检查点

**What to build:** 有界区域目标与纠偏流程，工具可观测的进度检查点及恢复。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** [规格](../spec.md) A01–A05；用户 2026-10-22 指示继续下一步。

- [ ] 命名区域与核准状态，按需返回完整诊断。
- [ ] 两次以内的纠偏与前后证据指针。
- [ ] 缺失进度反馈、候选绑定及检查点交接。
- [ ] 公开入口测试与两轴 review。
- [ ] 真实 Haiku 门槛、像素与交接对照。

**测试接缝：** verifyTemplateDesign、MCP check_outcome、runAgentTask。
