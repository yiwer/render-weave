# 01: 实测区域去重反馈与全检查停止

**What to build:** 固定版本探针、区域反馈真实模型对照与停止决定影子续跑。

**Blocked by:** 无

**Status:** resolved

**Trace:** ../spec.md；A01–A05。

- [x] 固定归档的真实渲染反例与票据 33–35 边界分析。
- [x] 四单元八轮 Haiku 5.5 对照、完整失败保留、停止决定先于续跑。
- [x] 指纹、效果/成本报告与可视化证据。
- [x] 测试与 Standards/Spec review；给正式接入判断。

**测试接缝：** 真实模型经 runAgentTask，出图经 src/index.ts；实验选择与停止策略测试直接调用实验脚本导出。

## Answer

2026-10-22 PDT 完成。模型版本与评分冻结在 d34a4eb，经 runAgentTask 串行执行四单元八轮 Haiku 5.5；95 次请求，没有额度/基础设施错误。原始记录 out/repair-region-live-v2，结果与复跑命令见 [报告](../../../docs/template-repair-region-results.md)，可视化与归档在 docs/agent-eval/figures/template-repair-region/。

- 按角色 vs 按区域：首轮目标 1/4 vs 4/4，两轮后 3/4 vs 4/4；53 项全过 0/2 vs 2/2，新增失败 1 vs 0。区域组固定两轮峰值增加 8.3%，耗时减少 12.0%；不宣称上下文收益。
- 区域两次首轮先登记停止，再执行影子续跑；共享前缀平均 85.252 秒，相对该组固定两轮少 45.5%。不是独立随机停止臂，实际八轮共 668.076 秒。
- 固定归档 64d7bae 经公开 render 的 8 个探针复现缺项/空画板误通过、片段漏检、框尺寸误推字号等问题；只归属该提交，不判断另一位 agent 当前未提交修改，不关闭原票据 33–35。
- `npx vitest run test/repair-policy.test.ts test/repair-feedback.test.ts test/fidelity.test.ts test/repair-report.test.ts test/region-report.test.ts`：30 tests 全过；模型前 build、模型后 typecheck 通过。
- `region-audit.mjs` 独立复核冻结指纹、成对输入、候选内容、决定时间、95 请求峰值与汇总通过。浏览器两种宽度、两次重复、两阶段共 8 组合通过；扫描 696 文件，密钥及片段 0 命中。
- Standards 最终 0 finding；Spec 最终 0 finding，A01–A05 满足。关闭 DPI 请求绑定、重评分覆写、有效停止前缀筛样、未知检查访问与候选未独立复算问题。

无验收范围偏差。实验结果支持可选区域反馈及完整检查停止策略；生产 MCP、业务 skills、默认上下文未修改。下一步先修测量语义，再扩展到跨模板坏例和可选宿主核查。
