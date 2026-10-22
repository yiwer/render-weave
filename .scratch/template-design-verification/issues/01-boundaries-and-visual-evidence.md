# 01: 按原数据边界与参考图定位模板候选问题

**What to build:** 宿主执行有界边界组合与样式/像素核查，向 Agent 按需返回可追溯的区域证据。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** [规格](../spec.md) A01–A06；用户 2026-10-22 指示。

- [ ] 从完整原数据生成组合并复现 P0 失败。
- [ ] 样式逐实例核查与未覆盖记录。
- [ ] SSIM、RGB 差异、热图与区域/元素定位。
- [ ] 候选绑定、接续、审核及应用重核。
- [ ] 短摘要与按需资料。
- [ ] 测试、两轴 review、真实模型及交接对照。

**测试接缝：** src/index.ts 公开核查入口、runAgentTask、check_outcome、审核及应用。
