# 01: 修正参考测量语义并完成跨模板真实修复对照

**What to build:** 逐元素/片段参考测量、两个新模板的公平对照与停止前缀分析。

**Blocked by:** 无

**Status:** resolved

**Trace:** ../spec.md；A01–A05。

- [x] 同类测量反例通过，未知/缺项不能停止。
- [x] 八单元十六轮真实 Haiku 5.5，或完整保留额度/基础设施中断。
- [x] 同预算效果、峰值、耗时、停止决定与指纹可审计。
- [x] 测试和双轴 review，报告正式接入判断。

**测试接缝：** 真实 render / runAgentTask 从 src/index.ts 或 dist/index.js 进入；实验测量、评分、归档由脚本公开入口验证。

## Answer

完成日期：2026-10-23 PDT。冻结评分/协议提交 d7ae834，真实批次 out/cross-repair-live；结果与归档提交 d5e6012。使用User级OPEN_CODE_API_KEY，仅传环境。

- A01：新增逐元素、逐文字片段参考测量；非空唯一清单、缺项/歧义/unknown、布局框与墨迹框、显式毫米字号分别处理。真实render反例验证父8/片段5、空画板、无布局、DPI、留白框、单元素错位等。
- A02–A04：价签与胸牌各两种反馈×两次重复，共8单元16轮Haiku5.5全部完成；每轮maxTurns=20，串行、交叉顺序。169请求，无额度/基础设施失败；首轮角色修复5/8、区域8/8，固定两轮均8/8；新增失败与回退均0。每轮价签107项、胸牌187项为三请求合计。
- 停止：四个区域组与一个角色组首轮已记录可停止，绑定候选/评分哈希且早于影子续跑。五次影子续跑无额外收益，实际耗时937.402秒。区域组采用实际停止前缀相对自身固定两轮耗时少61.4%；不是独立随机停止试验。
- A05：实验测量和报告已落地，生产src/agent、MCP及默认上下文没有新增改动。正式接入判断为M312的有核准参考可选组合策略；保留人工视觉审核，不把像素分数作为验收门禁。结果、限制与接入落点见 docs/template-cross-repair-results.md，画廊见 docs/agent-eval/figures/template-cross-repair/index.html。

验证命令与结果：

```powershell
npx vitest run test/reference-checks.test.ts test/cross-experiment.test.ts test/repair-policy.test.ts test/repair-feedback.test.ts test/region-report.test.ts test/repair-report.test.ts test/fidelity.test.ts
# 7文件40测试通过
npm run typecheck
# 通过；模型前npm run build通过
node scripts/agent-eval/region-report.mjs --root out/cross-repair-live --out docs/agent-eval/figures/template-cross-repair
node scripts/agent-eval/region-audit.mjs --root out/cross-repair-live --out docs/agent-eval/figures/template-cross-repair
# 8单元16轮169请求独立审计通过，最长反馈368字符
node scripts/agent-eval/region-gallery-check.cjs --root docs/agent-eval/figures/template-cross-repair
# 16组合通过（1440/390宽度）
node scripts/scan-keys.mjs docs/agent-eval/figures/template-cross-repair out/cross-repair-live
# 使用User环境变量，1182文件0命中
```

另从Git提交读取80个原始归档blob复核哈希全部一致。旧批次新版报告groups回归一致；旧冻结审计因本分支评分脚本已变化按预期拒绝，未覆盖旧证据。

两轴review：

- Standards：最终0项。关闭检查数量范围的文档误标（原请求52/85项，三请求合计107/187项）。
- Spec：最终0项。关闭同一文档误标，以及“策略存在≠成对可测”的筛样问题；CLI反例保留未知全样本与已知停止前缀。

没有验收偏差。本票不关闭其他检出的ticket33–35，也不把受控参考实验外推为任意PNG标注、最终墨迹可见性或盲评通过。
