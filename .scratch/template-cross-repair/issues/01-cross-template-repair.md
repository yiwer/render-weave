# 01: 修正参考测量语义并完成跨模板真实修复对照

**What to build:** 逐元素/片段参考测量、两个新模板的公平对照与停止前缀分析。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** ../spec.md；A01–A05。

- [ ] 同类测量反例通过，未知/缺项不能停止。
- [ ] 八单元十六轮真实 Haiku 5.5，或完整保留额度/基础设施中断。
- [ ] 同预算效果、峰值、耗时、停止决定与指纹可审计。
- [ ] 测试和双轴 review，报告正式接入判断。

**测试接缝：** 真实 render / runAgentTask 从 src/index.ts 或 dist/index.js 进入；实验测量、评分、归档由脚本公开入口验证。
