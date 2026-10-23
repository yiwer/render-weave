# 01: 实测区域去重反馈与全检查停止

**What to build:** 固定版本探针、区域反馈真实模型对照与停止决定影子续跑。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** ../spec.md；A01–A05。

- [ ] 固定归档的真实渲染反例与票据 33–35 边界分析。
- [ ] 四单元八轮 Haiku 5.5 对照、完整失败保留、停止决定先于续跑。
- [ ] 指纹、效果/成本报告与可视化证据。
- [ ] 测试与 Standards/Spec review；给正式接入判断。

**测试接缝：** 真实模型经 runAgentTask，出图经 src/index.ts；实验选择与停止策略测试直接调用实验脚本导出。
