# 01: 按原数据边界与参考图定位模板候选问题

**What to build:** 宿主执行有界边界组合与样式/像素核查，向 Agent 按需返回可追溯的区域证据。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** [规格](../spec.md) A01–A06；用户 2026-10-22 指示。

- [x] 从完整原数据生成组合并复现 P0 失败。
- [x] 样式逐实例核查与未覆盖记录。
- [x] SSIM、RGB 差异、热图与区域/元素定位。
- [x] 候选绑定、接续、审核及应用重核。
- [x] 短摘要与按需资料。
- [ ] 测试、两轴 review、真实模型及交接对照。

**测试接缝：** src/index.ts 公开核查入口、runAgentTask、check_outcome、审核及应用。

## Comments

2026-10-22：A01–A05 已由公开接缝测试和历史候选回放核验。实现提交 9ccb2ac；两轴 review 的摘要超限、后段失败丢失问题分别修复于 229fd2c、c780e52，最终两轴无剩余 finding。typecheck、build 通过；engine 45 文件 / 957 测试通过，MCP 与设计核查 42 项为其中子集。五组回放及浏览器定位验证见[实测记录](../../../docs/template-design-p1-acceptance.md)和[交互对照](../../../docs/agent-eval/figures/template-design-p1/index.html)。

A06 仅完成离线回归、历史样本定位与两轴 review。真实 Haiku 5.5 / MCP 0.9.0 在首请求遇到 Go usage limit exceeded（429），没有有效样本；真实阈值停止/交接对照未执行。票据保持未关闭，待额度恢复后按实测记录中的新 label/out 命令补齐，不以 P0 旧合同的通过结论代替。

2026-10-22 10:17 PDT：按用户要求复查额度并发起最终版评估，代码 5352393、工作区干净，npm run build 通过。首请求仍为额度 429，2310 ms、0 输出 tokens，另外 7 个单元停止派发，交接对照未启动。[本次报告](../../../docs/agent-eval/reports/2026-10-22-template-design-p1-final-incomplete.json)为 incomplete，A06 保持未完成。额度恢复后可沿用 template-design-p1-final / out/p1-live-final 续跑；没有新增的模型质量、峰值或完成耗时结果。

随后用户要求核对密钥，确认 Process 作用域旧值与指定值不一致、User 作用域一致。前述额度判断不适用于用户指定密钥。从 User 读取后，新批次 template-design-p1-key-verified 已收到模型输出；[交接实验口径](../../../docs/template-design-p1-live-protocol.md)预先登记 60,000 阈值和两组对照。旧报告保留，A06 待完整结果。
