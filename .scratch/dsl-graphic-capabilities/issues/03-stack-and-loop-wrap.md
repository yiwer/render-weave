# 03: 堆叠布局与循环容器支持自动流式换行 `wrap`

**What to build:** 模板作者与 Agent 可在堆叠布局（`layout.mode: "stack"`）与循环容器（`itemLayout`）上开启 `"wrap": true` 与交叉方向行/列间距 `crossGap`，使放不下的子元素或循环项自动折入下一行或下一列。

**Blocked by:** 02

**Status:** resolved

**Trace:** [父规格](../spec.md)；ADR-0016（DSL 1.x 只做加法）；验收 A01、A02、A04。

- [x] DSL 与静态检查：
  - 堆叠布局 `layout`（`mode: "stack"`）新增可选 `"wrap": true | false`（缺省 `false`）与 `"crossGap": 毫米或数值变量`（非负，缺省等于 `gap`）；
  - 循环容器 `itemLayout` 新增可选 `"wrap": true | false`（缺省 `false`）与 `"crossGap": 毫米或数值变量`；
  - 静态检查约束：开启 `wrap: true` 的循环容器，`widths`（横向）或 `heights`（纵向）只能取 `"content"` 或 `{ "fixed": … }`，不能取 `"equal"`，也不能与 `mergeBy` 同时使用（违反时报明确的模板错误）。
- [x] 测量与排版：
  - 当 `wrap: true` 时，沿主方向依次排布子元素（或循环项）；当前行/列剩余空间不足以放下下一个元素（含外边距与 `gap`）且当前行/列已有至少一项时，开启新行/列，行/列之间间隔 `crossGap`；
  - 堆叠容器内主方向设为 `"fill"` 的子元素，在 `wrap: true` 下先按自身自然尺寸（`hug`）参与折行判定，行内项确定后再按权重分配该行的剩余主方向空间；循环容器开启 `wrap: true` 时每项交叉方向尺寸取被调模板的自然尺寸（`hug`）；
  - 在每一行/列内独立应用 `justifyContent` 与 `alignItems`（每行的交叉方向高度/宽度取该行内各元素的最大交叉尺寸）；
  - 当 `wrap: true` 的容器在交叉方向为随内容（`"hug"`）时，结合容器在主方向已知的可用尺寸（来自 `fixed`、`maxWidth`/`maxHeight` 或父容器分配的宽度/高度）计算折行后的总交叉尺寸（各行/列交叉尺寸之和加 `crossGap`）；若主方向本身也是无上限的 `"hug"`，则不发生折行；
  - 所有行/列在交叉方向总跨度超出容器可用空间，或单个元素在主方向已超出容器总宽/高时，报告 `layout.contentOverflow`。
- [x] 合同与参考同步：
  - 更新模板 JSON Schema、人读参考（含 `docs/dsl/README.md`「1.0 之后的变化」）与 Agent 参考的布局与循环章节，更新「已知限制」中“循环只排成一行或一列”的说明；
  - 一致性测试覆盖 `wrap`、`crossGap` 及非法组合变异样本。
- [x] 测试与验收：
  - 覆盖多枚宽度不一的标签自动折行（含外层容器高度 `"hug"` 自适应撑高）、固定格宽班次表多行折行、超出交叉方向高度报错的布局摘要快照与出图验证；
  - 现有全部语料、M402 共享样例、golden 与布局快照保持不变；Windows 与 Linux 全量测试通过，记录 M 编号并同步 `CONTEXT.md`。

**测试接缝：** 从公开渲染入口 `render` 与文档检查入口 `checkDslDocument` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`。

## Answer

- **完成日期**：2026-10-19
- **决定记录**：`M253`（`docs/discovery/requirements.md`）
- **验证命令与结果**：
  - `npm run typecheck`：0 错误
  - `npm run build`：通过
  - `npx vitest run test/layout.test.ts test/calls.test.ts test/dsl-template-schema.test.ts`：3 个测试文件、116 项测试全部通过
  - `npx vitest run`：39 个测试文件、807 项测试全部通过，现有语料、M402 共享样例、golden 与已有布局快照无变化
- **成果路径**：
  - 引擎实现：`src/template/model.ts`、`src/template/parse.ts`、`src/evaluate.ts`、`src/layout/index.ts`
  - 契约与参考：`schemas/template.schema.json`、`docs/dsl/template.md`、`docs/dsl/README.md`、`agent/reference/template.md`
  - 测试与布局快照：`test/layout.test.ts`、`test/calls.test.ts`、`test/dsl-template-schema.test.ts`、`test/snapshots/loop-wrap-tags-hug.layout.json`、`test/snapshots/loop-wrap-departures-fixed.layout.json`、`test/snapshots/loop-wrap-overflow.layout.json`
- **验收偏差**：无（Agent 评估门槛按父规格 A08 在整批票据收尾时统一复跑）。
