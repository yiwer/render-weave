# 01: 对照元素反馈的修复收益

**What to build:** 固定坏例与预算的真实 Haiku 成对实验和可审计结果。

**Blocked by:** 无

**Status:** resolved

**Trace:** [规格](../spec.md) A01–A05；用户 2026-10-22 继续实验指示。

- [x] 冻结输入、评分、顺序与相同预算。
- [x] 最多两条有界差异反馈及评分测试。
- [x] Haiku 两臂实际执行，保留无效/失败。
- [x] 修复率、新增失败项、峰值与耗时对照。
- [x] 两轴 review、图文证据及接入判断。

## Answer

2026-10-22 完成 A01–A05。冻结提交 `8dfcdc0`；公开 Agent 路径运行 12 单元、24 轮，主/小模型均 Haiku 5.5，maxTurns=20，13 工具、仅 rw MCP、skills 为空。没有服务失败、额度中断或质量重试；1 轮用满预算但已有效交回，照协议计分。

目标修复 9/12 → 12/12，相对最初坏例新增失败均为 0；平均单元峰值 60,688 → 55,319 tokens，平均两轮耗时 5.35 → 3.56 分钟。主指标不等于全部检查通过：事后补充为 2/6 → 6/6，并保留只看图组的一项非目标轮间回退。完整数据、局限和接入建议见[结果](../../../docs/template-repair-feedback-results.md)，原始摘要与图片见[交互页](../../../docs/agent-eval/figures/template-repair-feedback/index.html)。

验证命令及结果：

- `npm run build`、`npm run typecheck`：通过（构建在模型批次前，源码及 dist 指纹整批固定）。
- `npx vitest run --project engine test/repair-report.test.ts test/repair-feedback.test.ts test/fidelity.test.ts`：21/21。
- `node scripts/agent-eval/repair-live.mjs --root out/repair-feedback-live`：12/12 单元、24/24 轮。
- `node scripts/agent-eval/repair-report.mjs --root out/repair-feedback-live --out docs/agent-eval/figures/template-repair-feedback`：归档成功。
- 归档的 `audit-script.cjs`：319 请求、6 对输入及全部主/附加指标独立复算通过；`gallery-check.cjs`：1440/390 两视口 24 组合通过。
- Standards / Spec 最终 review：0 未解决发现；密钥扫描 0 命中。

验收偏差：C 的 28 mm 留白在付费调用前发现会导致反事实输入溢出，改为 20 mm 后重新准备并冻结，失败准备保留。结果是同一业务模板的新部件/参数组合，不是跨业务留出集。事后全检查与停止时间分解另列，没有改写原评分或冒充新策略的效果。产品默认资料及 MCP 未改。
