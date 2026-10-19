# 12: 循环容器可以纵向排列列表项

**What to build:** 模板作者与 Agent 用 `"itemLayout": { "direction": "column", … }` 让循环容器从上往下排列表项，竖排的站点列表不再靠把循环容器旋转 90° 绕过。

**Blocked by:** 无

**Status:** resolved

**Trace:** [第三阶段验收](../../../docs/stage3-acceptance.md)「真人走查（A11 补测）」与「后续」第 1 条；需求记录 M235；ADR-0016（1.x 只做加法）；第三阶段 PRD 第 1 条（DSL 1.0 照实写的限制"循环只能横向"）；验收 A01、A02、A03、A10。

背景：真人走查的 M162 竖版线路牌，Agent 把循环容器旋转 90°、被调模板再反向旋转，才排出竖排站点列表。出图是对的，但循环区域的坐标与宽高要按旋转前写，行高、字号与偏移还按站数分三档写死，审核与修改都难懂。站台竖牌、竖排列表在这个领域常见。

- [x] DSL：循环的 `itemLayout.direction` 增加 `"column"`。
  - 纵向时用 `heights` 指定每项高度，取值与 `widths` 相同：`equal`（等分）、`content`（随内容，被调模板的画板写 `"size": "hug"`）、`{ "fixed": 毫米 }`；每项宽度填满循环区域。`gap` 沿用。
  - 横向写法不变：`direction` 缺省仍是 `"row"`，横向时用 `widths`。纵向写 `widths`、横向写 `heights` 都报错，提示该用哪个。
  - `mergeBy` 与 `spanBy` 第一版只支持横向，纵向写了报明确的错误。切换条件：出现需要纵向合并相邻同值项的设计稿时再做。
  - 已有模板的解析、出图结果与布局摘要不变（ADR-0016）。
- [x] 布局：纵向循环展开为纵向堆叠，元素检查与布局摘要给出真实坐标；列表项总高超出循环区域时，问题与横向超出宽度时一致。
- [x] 合同与参考同步：
  - `schemas/template.schema.json`：Schema 与解析器对新写法同进同退，一致性测试的语料与变异覆盖 `column`、`heights` 与上述错误写法；
  - 人读参考 [docs/dsl/template.md](../../../docs/dsl/template.md) 的循环一节与「已知限制」；
  - Agent 参考 `agent/reference/template.md`：示例仍用非线路牌领域（会议胸牌一类），示例在测试中校验并出图 0 问题。
- [x] 测试：
  - 纵向的等分、随内容、固定三种高度各有布局摘要快照；
  - 一张竖排列表的 golden，有意新增，目视核对；
  - 已有的 golden、布局快照与 M402 共享样例不变。
- [x] 实跑：用 M162 示例图与 [scripts/agent-eval/scenarios/m162/](../../../scripts/agent-eval/scenarios/m162/README.md) 的材料跑一轮模板辅助设计（Haiku 5.5）。
  - 站点列表用纵向循环，模板里不再有旋转；
  - 审核页预览与示例图一致；
  - 出图本站 1、0、10 三张，0 问题。
- [x] 改了 Agent 参考，按 M230 跑评估门槛（Haiku 5.5），连续两次达线。要用 Gemini 4 Argon，就同时在当前合同上复跑它的门槛。
- [x] 全量测试、类型检查、构建在 Windows 与 Linux 上通过；需求记录记 M 编号，`CONTEXT.md` 同步；key 扫描命中 0。

**测试接缝：** 渲染与布局摘要从 `src/index.ts` 的 `render` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`，语料收集在 `test/support/dsl-corpus.ts`；golden 按 `CODING_STANDARDS.md` 的规则新增与核对。

## Answer

2026-10-18 完成。决定见 M236。

**成果**

- 引擎：
  - `LoopModel.itemLayout` 改为按方向区分的联合类型：横向带 `widths` 与可选 `spanBy`，纵向带 `heights`（`src/template/model.ts`）；
  - 解析器读 `direction: "row" | "column"`，方向与尺寸词不匹配、纵向写 `mergeBy`/`spanBy` 时报模板错误并提示该用哪个词（`src/template/parse.ts`）；
  - 求值时纵向循环展开为纵向堆叠，每项宽度填满、高度按 `heights`（`src/evaluate.ts`）。布局层没改，超出时沿用堆叠的 `layout.contentOverflow`。
- Schema：`itemLayout` 的 `direction` 取 `row`、`column`，按方向分别要求 `widths` 或 `heights`，纵向不许 `spanBy`；`mergeBy` 的条件分支要求 `direction` 为 `row`；尺寸写法提成 `$defs/loopItemSize`。
- 参考：
  - 人读参考的循环一节、可绑定数值与「已知限制」；
  - DSL README 新增「1.0 之后的加法」；
  - Agent 参考的循环说明，会议胸牌示例新增被调模板"日程行"与纵向循环"日程列"（参会场次，每项 4.5 mm），胸牌高度范围从 110–140 改为 130–140 mm，以放下 6 个场次。
- 测试：
  - `test/calls.test.ts` 新增「纵向循环（M236）」11 项：三种高度的布局摘要快照（`test/snapshots/loop-column-*.layout.json`）、超出问题与横向一致、6 种错误写法、竖排站点列表 golden（`test/golden/loop-column-stops.png`，有意新增，目视核对：五站自上而下等高，第 3 站黄底）；
  - `test/dsl-template-schema.test.ts` 的变异样本：原"循环方向为 column"改为"循环方向未知"，另加 7 种纵向相关的写错方式。
- 文档：需求记录 M236；`CONTEXT.md` 已实现能力与下一步；[开发环境与接续](../../../docs/dev-setup.md) 的期望测试数；[第三阶段验收](../../../docs/stage3-acceptance.md)「后续」与「验收后的变更」；[Agent 评估](../../../docs/agent-eval.md#历次评估)。

**验证**

- **一致性测试能变红**：换回旧 Schema 时，Agent 参考的胸牌示例被判"引擎接受、Schema 拒绝"；新 Schema 下 22 项通过，新增变异都被两边同时拒绝。
- **Agent 参考示例**：样例数据与 6 个场次（数据定义上限）都出图 0 问题。
- **兼容**：已有的 golden、布局快照与 M402 共享样例都没变。
- **Windows**：`npm run typecheck`、`npm run build` 退出码 0；`npm test` 39 个文件、763 项通过（原 752 项加新增 11 项）。
- **Linux**（`node:22-alpine`，从 tar 空目录安装）：759 项通过，4 项 Windows 专用用例跳过，新 golden 在 Linux 上比对通过。
- **M162 实跑**（Haiku 5.5，Claude Code 2.1.296，模板辅助设计，工作区只有数据定义与数据集）：
  - 一轮合格，389 秒、58 轮，交回 2 个模板、6 个待确认项（估色 3、字体 1、票制位置 1、字号分档 1），都不涉及循环写法；
  - 站点列表写成 `"direction": "column", "heights": "equal"`，两个模板里都没有 `rotation`；
  - 预览与示例图对照：21 站行位一致，方向条、箭头、本站黄底都在；差别是黄底撑满整行（示例图只包住站名）、箭头偏浅、线路号字体；
  - 经审核接口采纳全部待确认项并通过，`agent apply` 后用走查时的版本仓库 `deliver`：本站 1、不标本站、本站 10 三张交付，0 问题；目测本站 10 第 10 站黄底、前 9 站灰字，不标本站无高亮。
  - 字号仍按站数分档：横排没有缩字组，不在本票范围。
- **评估门槛**（Haiku 5.5，Claude Code 2.1.296，合同 0.5.0）通过，[2026-10-18-vertical-loop](../../../docs/agent-eval/reports/2026-10-18-vertical-loop.json)：
  - M402 数据定义 2/2（专家字段 14、15，约定 6、6）；M402 模板 2/2（压测 10、10，地标底线 0、0 mm，相似度 0.911、0.925）；366 2/2（站名 57、59，地标 15/15、15/15，设施 18/18、18/18）。
  - M402 是横排，两次的站点列、道路段与班次都仍是横向循环；第 2 次把每站竖叠的标识写成了纵向循环。
  - 没用 Gemini，所以没有复跑它的门槛，仍列在第三阶段验收的「后续」里。
- **key 扫描**：`node scripts/scan-keys.mjs out/t12 docs src scripts test agent schemas`，429 个文件命中 0；评估目录与 `docs` 另扫 343 个文件，命中 0。
