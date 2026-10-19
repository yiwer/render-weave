# 02: 批量项与单次渲染对同一问题给出同一问题码

**What to build:** 批量项遇到数据集不存在、静态定义不存在这类问题时，报与单次渲染相同的精确问题码，不再统一报 `record.invalid`。

**Blocked by:** 无

**Status:** resolved

**Trace:** [阶段 4 PRD](../spec.md)「开放 API」中的问题码对齐；用户故事 14、29；验收 A01、A06；M203 遗留、M246；ADR-0016 的缺陷修正口径。

背景：这是第二阶段审查转出的 Spec P2。批量项找不到数据集或静态定义时报 `record.invalid`，单次渲染则给 `input.datasetNotFound` 等精确问题码，指南只能让人去看说明文字。开放 API 之后，问题码就是对外合同。

- [x] 先写失败的测试：同一份有问题的输入，分别走单次渲染和只有一项的批量交付，比较两边的问题码、等级与位置。覆盖：
  - 数据集不存在；
  - 静态定义不存在；
  - 数据集与模板的基准不符；
  - 内联数据集不合法。
- [x] 修正后，批量交付对这些情况给出与单次渲染相同的问题码。`record.invalid` 只留给记录本身不合法的情况。
- [x] 按 ADR-0016 的缺陷修正口径统计影响：现有测试、样例与评估成果中，凡是输出受影响的，逐一核对并记录。
- [x] [出图记录说明](../../../docs/output-records.md)和指南里"去看 message"的说法同步修改。
- [x] 全量测试、类型检查、构建在 Windows 与 Linux 上通过；决定记 M 编号。

**测试接缝：** 引擎的公开入口（单次渲染与批量交付），以及命令行的 `deliver`。

## Answer

2026-10-19 完成，决定见 M258。

**规则**：单次渲染也会报的问题，由渲染入口的同一段同步检查给出，批量交付不另写检查。

- **本项**：准备失败时，先问渲染入口这一项能否展开；不能展开就用它的问题清单，问题码、等级、位置与说明都与单次 `render` 相同。
- **整批**：根模板准备失败时只看模板一侧；工作区有严重读取问题时，报这些读取问题本身。
- **`record.invalid`**：只留给出图记录特有的要求，即能展开、却成不了自足记录的情况（例如静态定义缺少原文、同一资源既当图片又当字体），以及读取时记录本身不合法。

**实现**

- `src/render.ts`：拆出同步前段 `prepareRender`（解析请求加出图前检查），`render` 改为调用它；新增 `templateBlocked`，只看根模板一侧。
- `src/preflight.ts`：模板一侧的检查拆成 `readTemplate` 与 `checkTemplateSide`，问题顺序不变；新增 `preflightTemplate`。
- `src/output-records.ts`：`freezeBatch` 在项级或批次级准备失败时调用上面两个函数。能展开的项照旧不多做检查，所以合法项的固定与交付路径没有变化。

**范围比票据多一步**：整批拒绝的一侧也对齐了，包括根模板不存在、被调模板不存在、根模板读不出、根模板基准缺失与工作区读取问题。原因有两条：[DSL 参考](../../../docs/dsl/requests.md#schema-之外的检查)早已写明交付入口报 `input.templateNotFound`；开放 API 之后，整批拒绝的问题也是对外合同。

**影响统计**（ADR-0016 的缺陷修正口径）：只改问题清单，状态、出图与记录都不变。原来失败的项仍失败，整批拒绝的仍拒绝。

| 范围 | 结果 |
|---|---|
| 批次请求样例（5 个） | 只有[混合样例](../../../docs/examples/output-record/m402-mixed-batch-request.json)的两项变化：`wrong-version` 从 `record.invalid` 变为 `input.staticSchemaNotFound`、`dataset.staticSchemaMismatch`、`render.expansionBlocked`；`no-dataset` 变为 `input.datasetNotFound`、`render.expansionBlocked`。草稿样例、带码线路牌样例、单项样例与 35 项样例在修正前后固定得到的问题完全相同 |
| 现有测试与验收脚本 | `test/batch-delivery.test.ts` 与 `scripts/accept-batch.mjs` 各 2 处断言改为新问题码；其余用例不变 |
| golden、布局快照、M402 共享样例 | 无变化（全量测试通过，没有更新） |
| 已有出图记录 | 记录的读取与重放路径没有改动 |
| Agent 成果与评估 | Agent 任务与 MCP 工具不经批量交付，不受影响 |

**文档**：[使用指南](../../../docs/guide.md)第 4 节的失败项表格与原先"看 message"的提示；[出图记录说明](../../../docs/output-records.md)的执行规则；[存储接口](../../../docs/storage-interfaces.md)；[渲染请求与批次请求](../../../docs/dsl/requests.md)；[DSL 变化记录](../../../docs/dsl/README.md#10-之后的变化)；[第二阶段验收](../../../docs/stage2-acceptance.md)两轴审查第 1 条指向本票。

**验证**

- **先写失败的测试**：`test/batch-problem-codes.test.ts` 共 21 项，修正后全部通过。在修正前的源码上：
  - 14 项失败；
  - 6 项通过，是本来就一致的基准不符、内联数据集结构不合法、内联数据不符合定义三种，各在两种模式下；
  - 记录特有要求那一项也通过，它钉住不该变的一边。

  覆盖：
  - 同一份坏输入走单次渲染和一项批次，草稿与正式两种模式，问题清单逐项相等：数据集不存在、内联或已保存数据集的静态定义不存在、静态定义没有编译产物、基准不符、内联数据集结构不合法、内联数据不符合定义；
  - 整批拒绝的问题都是单次渲染同样会报的问题：根模板不存在、根模板基准缺失、被调模板不存在、根模板读不出、工作区有严重读取问题；
  - 能展开却成不了自足记录时，单次渲染照常出图，批量交付仍报 `record.invalid`；
  - CLI `deliver` 写出的 `problems.json` 与单次渲染的问题清单相同。
- **Windows**：`npm run typecheck`、`npm run build` 退出码 0；`npm test` 41 个文件、824 项通过。
- **Linux**（`node:22-alpine`，从 tar 在空目录安装）：构建、类型检查通过，820 项通过，4 项 Windows 专用用例跳过。
- **验收脚本**（基于构建产物，输出在 `out/t02/`）：`accept-batch`、`accept-batch-cancel`、`accept-output-record`、`accept-record-closure`、`accept-coded-sign` 全部退出码 0。`accept-batch` 的混合批次按新问题码断言，其中已交付项的图片与同一次运行的 35 项逐一相同。千项长批次没有重跑：合法项的固定与交付路径没有改动。
