# 02: 循环容器支持反序、区间切片与纵向合并相邻同值项

**What to build:** 模板作者与 Agent 可在循环容器上配置 `reverse`（反序排列）、`slice`（按起止序号截取子列表），并在纵向循环（`direction: "column"`）中使用 `mergeBy` 与 `spanBy: "groupSize"` 合并相邻同值项。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** [父规格](../spec.md)；ADR-0016（DSL 1.x 只做加法）；验收 A01、A02、A04。

- [ ] DSL 与静态检查：
  - 循环容器新增可选 `"reverse": true | false`（布尔字面值或布尔模板变量，缺省 `false`）；
  - 循环容器新增可选 `"slice": { "start"?: 运算数, "end"?: 运算数 }`（1-based 闭区间，至少写 `start` 或 `end` 之一；字面值须为正整数，静态字面值 `start > end` 报 `template.invalid` 并登记到「Schema 之外的检查」；绑定数值模板变量时在求值期校验）；
  - 放开纵向循环（`itemLayout.direction: "column"`）对 `mergeBy` 与 `itemLayout.spanBy: "groupSize"` 的限制，要求纵向合并时 `heights: "equal"`（与横向合并要求 `widths: "equal"` 对称）。
- [ ] 求值与布局：
  - 执行顺序固定为：先为原始列表每项标记原始 1-based 序号，再按 `slice` 截取闭区间 `[start ?? 1, end ?? items.length]`（若 `start > items.length` 则结果为空列表，不报错；若绑定变量取值非正整数或 `start > end` 则报 `template.bindingValueInvalid`），接着按 `reverse` 决定排列顺序，最后按 `mergeBy` 合并相邻同值项（每组取排列顺序下的首项数据与首项原始序号）；
  - 循环信息与路径基准：`{ "loop": "index" }`、元素路径 `循环名[index]` 以及草稿缺值追溯的 `listOrigin` **始终使用该项（或合并组首项）在原始列表中的 1-based 序号**（使分栏切片与反序列表仍能直接与 `本站序号` 比对并准确定位数据集字段问题）；`{ "loop": "count" }` 为截取后（合并前）参与本次循环的项数，`isFirst` 与 `isLast` 表示是否为本次排列顺序下的首项/末项（含合并组覆盖首尾项的情形）；
  - 纵向合并循环按本次循环项数（`count`）等分可用高度，每组高度包含所跨项的内部行间距（与横向 `loopColumns` 逻辑完全对称）。
- [ ] 合同与参考同步：
  - 更新模板 JSON Schema、人读参考（含 `docs/dsl/README.md`「1.0 之后的变化」）与 Agent 参考的循环章节及「已知限制」；
  - 一致性测试更新原“纵向循环合并相邻同值项”变异为“纵向合并循环 `heights` 不是 `equal`”，并覆盖 `reverse`、`slice` 的正向与错误变异。
- [ ] 测试与验收：
  - 验证对向站牌反序站点列（含与本站序号比对）、长列表分两栏切片（含 `start` 超过列表长度时正常留空）、竖版线路牌纵向道路带合并的布局摘要与出图结果；
  - 现有全部语料、M402 共享样例、golden 与布局快照保持不变；Windows 与 Linux 全量测试通过，记录 M 编号并同步 `CONTEXT.md`。

**测试接缝：** 从公开渲染入口 `render` 与文档检查入口 `checkDslDocument` 进入；DSL 一致性测试在 `test/dsl-template-schema.test.ts`。
