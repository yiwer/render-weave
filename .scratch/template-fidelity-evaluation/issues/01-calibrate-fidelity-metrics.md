# 01: 用坏例和跨数据回归校准还原评判

**What to build:** 独立于现有 MCP verdict 的离线评判试验、诊断与证据页。

**Blocked by:** 无

**Status:** resolved

**Trace:** [规格](../spec.md) A01–A05；用户要求落地实际测试新评判标准。

- [x] 数据驱动的显示内容核对。
- [x] 受控坏例与结构/文字偏差。
- [x] 跨数据与参数的反事实回归。
- [x] 历史/当前候选补测及完整限制说明。
- [x] 回归测试、两轴 review、可视化证据。

## Answer

2026-10-22。离线实现为 `scripts/agent-eval/fidelity.ts`、`fidelity-experiment.ts`、`fidelity-flip.py` 与 `fidelity-gallery.mjs`；固定 Python 依赖仅用于隔离实验，不增加产品依赖。依据与取舍见 `docs/template-fidelity-research-review.md`，复现与结果见 `docs/template-fidelity-experiment-{protocol,results}.md`。

- A01：显示契约取已有数据、参数与业务角色，布局证据按内容/资源 ID 匹配，不依赖候选自定义路径名，不重提图片数据。
- A02：11 个受控模板包含正例、空骨架、缺站/时刻/地标、倒序、缩字、平移、底栏变高、陌生文本与写死示例。内容、位置、字号分列。FLIP 的 7 个局部坏例与自身误差共 8 项断言通过。
- A03：正常/写死模板各 4 个派生输入，正常全部匹配；写死版本在改名、换序、改 currentIndex 时暴露问题，删除标识阴性对照仍匹配。
- A04：13 个历史/当前候选重放，连同受控与派生集合共 32 个样本。报告记录输入/代码/依赖/资源哈希；旧历史资源没有原时点内容版本，保留限制。
- A05：`npm run typecheck` 通过；`npx vitest run --project engine test/fidelity.test.ts` 11/11；最终 `npx tsx scripts/agent-eval/fidelity-experiment.ts --out out/fidelity-experiment-final` 19/19；FLIP 脚本完成 48 次比较、8/8；1440/390 页面检查 32 候选 × 3 角色，无错误。Standards 的追溯与 JSON Infinity 问题、Spec 的词表重复与陌生文本过滤问题已修复；两轴复审无未解决发现。

证据归档在 `docs/agent-eval/figures/template-fidelity/`。校准五次并使用观察集发现边界，不能报告泛化准确率；匹配不等于最终可见、技术通过不等于内容完整。未验证遮挡/墨迹、LPIPS/OCR、人类偏好及新反馈对 Agent 修复率的影响。当前票据只验收测量试验，不修改产品 verdict、MCP 或业务 Agent 上下文。
