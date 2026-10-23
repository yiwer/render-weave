# 38: 补齐中文、英文场景的真实模型验收

**What to build:** 运行新的资料与合同评估，以中文、英文样例验证工具反馈与纠偏，记录未覆盖边界。2026-10-23 按 M307 停止继续投入阿拉伯文还原。

**Priority:** P1

**Blocked by:** 31、32；[harness 20：兼容检查通过后冻结同一份待验候选](../../agent-harness-hardening/issues/20-verified-candidate-freeze.md)

**Status:** ready-for-agent

**Trace:** 第三阶段 PRD；2026-10-21 用户要求；[同图复跑报告](../../../docs/agent-arabic-retest.md)。

- [ ] 额度恢复后按新合同运行现有模型评估门槛；代码离线通过不能替代真实模型通过。
- [x] 中文受控样例完成真实模型纠偏，保留改前/改后证据、反馈成本和未核实维度。
- [ ] 英文真实样例验证模型纠偏；已有英文受控工具对照不能代替这项。
- [ ] 中文、英文真实参考样例补齐独立样式/状态及人工比较；不以零诊断异常宣称全图还原通过。
- [ ] 本票不以等待额度为理由修改平台限制，也不自动轮询付费模型。

**测试接缝：** 公开 Agent / 渲染 / CLI 入口；资料变更的真实模型门槛在票据 38 统一验收。各票特有证据见条目。

**Harness 验收衔接（2026-10-23 用户确认）：**

- 本票继续唯一保存既有四场景、英文纠偏及中英文独立样式/状态的关闭证据。针对本次 harness 优化的验收使用前置票 20 冻结的候选；原四场景按新判据各登记两次有效观测，历史记录保留，只有身份与标准相同的证据可以引用，不能拼接不同构建。
- 新增可信反馈集合归 [harness 21](../../agent-harness-hardening/issues/21-real-trusted-feedback-observations.md)。派发前列明共享单元的案例、重复序号、预算、身份与唯一执行票；新增共享单元由 21 派发，本票只引用该单元并独立执行其余四场景/审核工作。一个不可变观测只占一个重复槽位，不能因被两票引用而算成两次，也不能并行重复派发。
- 候选冻结后改变构建、工具、资料、预算策略或判据，先产生新候选并重新判定受影响证据；缺有效观测如实保留，不覆盖有效失败重跑直到成功，不自动轮询额度或换模型。本次仅补充依赖与验收分工，原有勾选、历史结果和状态保持原样。

## Answer

### 2026-10-23 提交时的范围与状态

新首次阿文模板进程已按用户要求停止，不记通过；已完成的旧中断接续与能力拦截只保留为历史证据。中文两次真实纠偏和英文受控验证已完成，四场景门槛仍在运行，不能关闭本票。固定的提交时快照与待完成项见[结果记录](../../../docs/agent-visual-feedback-results.md)。后文“进行中”是此前时间点的记录，以本段和正式门槛报告为准。

### 2026-10-22 补验进行中

已启动四场景、每场景两次的真实 Haiku 门槛：`node --import tsx scripts/agent-eval/run.ts --jobs 1 --label 2026-10-22-visual-feedback-0100`。当前已完成第一遍 M402 定义及模板，均达线；未完成全门槛，不勾选对应条目。轮次在 `out/agent-eval/2026-10-22-visual-feedback-0100/`，进程运行期间保持 dist 不变。

另完成一次独立的中文受控纠偏：6 项异常降到 0，只改四项授权属性，76.6 秒、23 轮；一次工具错误自行恢复，最终仍 needsReview。详情、命令、输入和构建边界见[实测记录](../../../docs/agent-visual-live-acceptance.md)。此试验不代替本票的原图首次提取、原中断接续及长调用验收。

### 2026-10-23 合同与证据分离

区域目录和共享输出预算完善后，合同为 0.10.1。已单独构建到 `out/agent-builds/visual-feedback-0.10.1/`，并复制当前源码、原评估脚本和原夹具，使用同一评分器跑四场景两遍；不改旧门槛正在用的 dist。新命令为：

```powershell
node --import tsx out/agent-builds/visual-feedback-0.10.1/scripts/agent-eval/run.ts --jobs 2 --label 2026-10-23-visual-feedback-0101 --out F:/GenCode/render-weave/out/agent-eval/2026-10-23-visual-feedback-0101 --reports F:/GenCode/render-weave/docs/agent-eval/reports
```

新版中文受控纠偏已成功：184.7 秒、20 轮、工具错误 0，四项修改符合要求，异常 6→0，最终仍 needsReview。旧版门槛第一遍 M402 定义、模板、修改已达线，366 尚在运行。新版门槛未完成，不拼接版本或将受控纠偏替作门槛。

原中断轮次接续输出在 `out/arabic-board-retest-2026-10-20/r3b-template/`；原始输入的新首次提取在 `out/arabic-board-retest-2026-10-23/r1-definition/`。新首次提取使用 0.10.1，原图、说明、资源与旧复跑相同，没有旧候选或反馈；`manifest.json` 固定输入哈希。两条路径分别留存，后续按实际结果补验，不提前记通过。

原中断接续现已完成：Gemini 47.5 分钟、107 轮正常交回 3 个模板，原候选未改写，正式渲染仅被 `text.unshapedScript` 拦截且无图。48 次成功调用最长 286.5 秒，未覆盖超过 300 秒调用。独立参考对照仍有 15/16 阿文站名高度不足，不能判样式通过。

新首次定义与数据集已完成，分别 393.9 秒/30 轮、310.6 秒/37 轮。数据集的真实工具反馈拦住始发站缺 0，修正后基准异常归零；另有货币占位长度冲突，隔离审核明确留空，仍保留差异。新首次模板正在运行。各输入条件、复核命令、反馈成本和限制见[原图新复跑记录](../../../docs/agent-arabic-retest-2026-10-23.md)。

### 2026-10-23 harness候选2准备及未派发状态

20已独立合入7c0ff99，固定候选2为 sha256:72a5e74973ce5f60e501e27060f6bc4a52f51f7b4bd45bbbac39502e0a5b949f。原四场景完整预登记见 [运行登记](../original38-harness/registration-candidate-2.json)：8个业务观测、10个模型阶段，52份输入/15份资料及原生Claude/Node摘要独立复核，两段各跑既定一遍、不新增重复。共享4个英文纠偏槽位由21唯一派发，条件引用见 [共享登记](../original38-harness/conditional-english-reference.json)。

原四启动命令在进程创建前被自动审批拒绝，原因是要求用户明确授权向具体第三方opencode.ai端点发送所需材料。已向用户询问，未改端点/模型或间接绕过；F:/GenCode/render-weave/out/harness-original38-candidate-2/dispatch-authorization-blocked.json记录无dispatch目录、无evaluation目录、真实观测0。外部审批待答不是模型失败，也不计invalid模型尝试或补造0用量。

[英文局部审核包](F:/GenCode/render-weave/out/harness-original38-review/en-local-candidate-2/review.html)已由本候选公开render生成：41项、50 DPI、原21份材料不变，正式结果保留文字能力阻断，另有1575×1772干净草稿；没有新模型观测。已请求用户独立逐项审核并记录分钟/是否预看诊断，当前全41项及分钟仍空白。中文本候选模板成果尚未产生，不能用旧记录替代。生成器、输入与输出均已独立复核，见外部 harness-original38-readonly-review.md。本票所有未完成验收框保持不变。

### 2026-10-23 具体目的地授权与混合图负评

用户已明确授权OpenCode Go具体端点及验收所需材料（含后续12例），见M329与[授权原话](../original38-harness/endpoint-authorization.json)。重新审批原命令后原四第一段已从候选2启动，先前拒绝原件保留；本段开始不代表任何门槛通过。

用户认为混合站牌对比糟糕，并建议跳过阿文，见[原话及材料身份](../original38-harness/mixed-board-user-feedback.json)。按M307停止该图进一步还原；整体记未接受，41逐项结论、分钟及是否预看诊断仍未知，不将此答复转成英文通过。中文/英文独立样式审核责任保留，接续方案另核。

## Comments

- 2026-10-21：用户确认排序并先实施 31、32；当前 Go 额度耗尽，其他票据按顺序后续推进。
