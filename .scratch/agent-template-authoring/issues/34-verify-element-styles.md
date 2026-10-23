# 34: 按参考基准核查所有独立样式和状态，自动扫描重复实例

**What to build:** 建立原图坐标与物理尺寸基准，用实际布局和同尺度局部图检查字号、位置、间距、颜色与层级。

**Priority:** P1

**Blocked by:** 31

**Status:** resolved

**Trace:** 第三阶段 PRD；2026-10-21 用户要求；[同图复跑报告](../../../docs/agent-arabic-retest.md)。

- [x] 本次 5.5 mm 站名能被标记为明显偏小；11 mm 是诊断对照，不能硬编码为所有项目的正确值。
- [x] 自动检查所有重复实例；视觉核对每种独立样式及普通、本站、已过、终点、最长文本等状态。
- [x] 核查记录绑定候选哈希与请求，候选修改后失效；返回覆盖情况与异常，而非只要求调用一次 inspect_layout。
- [x] 允许字体替代与合理适配，不能把 OCR 框高直接当 fontSize；DPI 改变不应改变物理尺寸判据。
- [x] 先用人工核准区域和现有布局摘要实施，不依赖 OCR 接入。

**测试接缝：** 公开 Agent / 渲染 / CLI 入口；资料变更的真实模型门槛在票据 38 统一验收。各票特有证据见条目。

## Answer

- 完成日期：2026-10-22
- 核心实现：
  1. 实现了 `src/agent/style-verification.ts`（导出 `verifyElementStyles`、`hashCandidatesAndRequest`、`isVerificationValid` 等），建立原图像素与画板物理毫米换算比，基于人工核准区域比对物理尺寸与字号，5.5 mm 站名相对于 11 mm 参考框高按容差（默认 < 65%）自动判定为 `fontSizeTooSmall` 并给出精确诊断，修正为 11 mm 后通过，基准由配置驱动而非硬编码；
  2. 自动聚合循环容器与 `[N]` 重复实例，识别普通、本站（current）、已过（passed）、终点（terminal）和最长文本（longestText）等状态并核查覆盖度；
  3. 核查记录绑定 `candidatesHash` 与 `requestHash`，候选或请求修改后 `isVerificationValid` 自动失效；
  4. 判定完全在物理毫米空间进行，50 DPI、100 DPI 与 150 DPI 下物理判据与异常结论完全一致；字体替代与合理缩放适配不误报；
  5. 成果校验 `checkAgentOutcome` 接入样式核查，当存在基准且字号偏小时将异常暴露在 `assessment.style` 与 `problems` 中，打破单纯语法无错误的“假阳性”；
- 验收命令：
  - `npm run typecheck`：通过，0 错误；
  - `npx vitest run test/agent-style-verification.test.ts`：5 个专项测试全部通过；
  - `npm test`：58 个测试文件通过、1046 个用例通过（13 个跳过，1 个文件跳过）。
- 偏差与边界：MCP 合同随本票与票据 33 升到 0.9.0，`check_outcome` 增加 `assessment.style` 与 `styleVerification` 输出；人工核准区域仍由调用方提供，真实模型视觉验收按票据 38。

## Comments

- 已验证的字号根因：模板初稿就把普通阿拉伯文站名写为 5.5 mm、英文为 3.6 mm；5.5 mm 渲染结果仍是 5.5 mm。只把普通站名改成 11 mm 后实际字号及宽高同步增加，没有溢出；DPI 50 改 100 不改变物理字号。证据：`out/arabic-board-retest-2026-10-20/diagnostics/font-size.mjs` 及其诊断输出。属于生成时的尺寸选择与核查缺口，已排除本例中引擎自动缩字和 DPI；看图缩放导致估算错误只是推断，未验证。

- 2026-10-21：用户确认排序并先实施 31、32；当前 Go 额度耗尽，其他票据按顺序后续推进。
