# 12: 循环容器可以纵向排列列表项

**What to build:** 模板作者与 Agent 用 `"itemLayout": { "direction": "column", … }` 让循环容器从上往下排列表项，竖排的站点列表不再靠把循环容器旋转 90° 绕过。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** [第三阶段验收](../../../docs/stage3-acceptance.md)「真人走查（A11 补测）」与「后续」第 1 条；需求记录 M235；ADR-0016（1.x 只做加法）；第三阶段 PRD 第 1 条（DSL 1.0 照实写的限制"循环只能横向"）；验收 A01、A02、A03、A10。

背景：真人走查的 M162 竖版线路牌，Agent 把循环容器旋转 90°、被调模板再反向旋转，才排出竖排站点列表。出图是对的，但循环区域的坐标与宽高要按旋转前写，行高、字号与偏移还按站数分三档写死，审核与修改都难懂。站台竖牌、竖排列表在这个领域常见。

- [ ] DSL：循环的 `itemLayout.direction` 增加 `"column"`。
  - 纵向时用 `heights` 指定每项高度，取值与 `widths` 相同：`equal`（等分）、`content`（随内容，被调模板的画板写 `"size": "hug"`）、`{ "fixed": 毫米 }`；每项宽度填满循环区域。`gap` 沿用。
  - 横向写法不变：`direction` 缺省仍是 `"row"`，横向时用 `widths`。纵向写 `widths`、横向写 `heights` 都报错，提示该用哪个。
  - `mergeBy` 与 `spanBy` 第一版只支持横向，纵向写了报明确的错误。切换条件：出现需要纵向合并相邻同值项的设计稿时再做。
  - 已有模板的解析、出图结果与布局摘要不变（ADR-0016）。
- [ ] 布局：纵向循环展开为纵向堆叠，元素检查与布局摘要给出真实坐标；列表项总高超出循环区域时，问题与横向超出宽度时一致。
- [ ] 合同与参考同步：
  - `schemas/template.schema.json`：Schema 与解析器对新写法同进同退，一致性测试的语料与变异覆盖 `column`、`heights` 与上述错误写法；
  - 人读参考 [docs/dsl/template.md](../../../docs/dsl/template.md) 的循环一节与「已知限制」；
  - Agent 参考 `agent/reference/template.md`：示例仍用非线路牌领域（会议胸牌一类），示例在测试中校验并出图 0 问题。
- [ ] 测试：
  - 纵向的等分、随内容、固定三种高度各有布局摘要快照；
  - 一张竖排列表的 golden，有意新增，目视核对；
  - 已有的 golden、布局快照与 M402 共享样例不变。
- [ ] 实跑：用 M162 示例图与 [scripts/agent-eval/scenarios/m162/](../../../scripts/agent-eval/scenarios/m162/README.md) 的材料跑一轮模板辅助设计（Haiku 5.5）。
  - 站点列表用纵向循环，模板里不再有旋转；
  - 审核页预览与示例图一致；
  - 出图本站 1、0、10 三张，0 问题。
- [ ] 改了 Agent 参考，按 M230 跑评估门槛（Haiku 5.5），连续两次达线。要用 Gemini 4 Argon，就同时在当前合同上复跑它的门槛。
- [ ] 全量测试、类型检查、构建在 Windows 与 Linux 上通过；需求记录记 M 编号，`CONTEXT.md` 同步；key 扫描命中 0。

**测试接缝：** 渲染与布局摘要从 `src/index.ts` 的 `render` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`，语料收集在 `test/support/dsl-corpus.ts`；golden 按 `CODING_STANDARDS.md` 的规则新增与核对。
