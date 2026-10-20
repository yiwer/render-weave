# RenderWeave DSL 1.0

DSL 1.0 是 RenderWeave 五种 JSON 文档的成文契约（M219）。它冻结的是现行写法，不新增能力。兼容策略见 [ADR-0016](../adr/0016-dsl-1-compatibility.md)：1.x 只做加法；解析器继续拒绝未知键；破坏性改动升到 `/2`，并附迁移说明。

| 文档 | 标识 | 参考 | JSON Schema |
|---|---|---|---|
| 数据定义 | `"dslVersion": "renderweave-schema/1"` | [数据定义与数据集](data-definition.md) | [data-definition.schema.json](../../schemas/data-definition.schema.json) |
| 数据集 | 由 `dataset` 与 `data` 两部分组成 | [数据定义与数据集](data-definition.md#数据集文档) | [dataset.schema.json](../../schemas/dataset.schema.json) |
| 模板 | `"dslVersion": "renderweave-template/1"` | [模板](template.md) | [template.schema.json](../../schemas/template.schema.json) |
| 渲染请求 | 含 `template` 与 `output`，是命令行 `render --request` 与公开渲染入口的输入 | [渲染请求与批次请求](requests.md) | [render-request.schema.json](../../schemas/render-request.schema.json) |
| 批次请求 | 含 `template`、`mode` 与 `items`；交付后的批次清单另有标识 `renderweave-batch/1` | [渲染请求与批次请求](requests.md#批次请求) | [batch-request.schema.json](../../schemas/batch-request.schema.json) |

## 1.0 之后的变化

按 ADR-0016，1.x 只做加法与布局缺陷修正，标识仍是 `/1`。用了新写法的文档，在加入它之前的引擎上会被拒绝；缺陷修正只改变原本有缺陷的出图。

| 日期 | 类别 | 内容 | 决定 |
|---|---|---|---|
| 2026-10-18 | 加法 | 循环 `itemLayout` 可写 `"direction": "column"` 与 `heights`，列表项从上往下排（[模板 · 循环](template.md#循环)） | M236 |
| 2026-10-18 | 缺陷修正 | 网格：随内容测量时比例轨道保持比例且放得下内容；跨多条轨道的元素撑开所跨的随内容轨道；元素超出单元格报 `layout.contentOverflow`（[模板 · 布局与位置](template.md#布局与位置)）。修正前统计现有语料与 Agent 成果，命中为零 | M237 |
| 2026-10-18 | 加法 | 画板可写 `minFontSize`（不低于 1.5 mm），作为本模板缩字的下限；元素与缩字组的下限缺省取它，只能更高（[模板 · 画板](template.md#画板)） | M238 |
| 2026-10-19 | 加法 | 派生变量增加数值 `multiply`、`divide`、`mod`，按分隔符拆取文本 `splitPart`，以及 `branch` 条件中的 `all` / `any` 复合条件（[模板 · 派生变量](template.md#派生变量)） | M239 |

## Schema 与引擎的分工

- **JSON Schema 只检查结构**：键是否允许、类型、枚举取值、必填项。Schema 拒绝的文档，引擎一定拒绝。
- **引擎另做语义检查**：约束冲突、正则合法性、字段名称重复、引用是否存在、数据是否符合所选静态数据定义等。这类问题 Schema 表达不了，每份参考的「Schema 之外的检查」逐类列出。
- **一致性测试**：`test/dsl-schema.test.ts`（数据定义与数据集）和 `test/dsl-template-schema.test.ts`（模板与请求），用仓库中的全部语料与结构错误的变异样本核对两边的判断。改动解析器或 Schema 时，这两项测试必须保持通过。

## 在编辑器中使用

文档中不能写 `$schema` 键：解析器会把它当作未知键而拒绝。请在编辑器设置里按文件名关联 Schema，例如 VS Code 的 `settings.json`：

```jsonc
{
  "json.schemas": [
    { "fileMatch": ["schema-*.json"], "url": "./schemas/data-definition.schema.json" },
    { "fileMatch": ["dataset-*.json"], "url": "./schemas/dataset.schema.json" }
  ]
}
```

工作区文件按内容归类、不看文件名，所以上面的文件名规则只是编辑器约定，可以按自己的命名调整。

## Agent 用的参考

Agent 读的是 [`agent/reference/`](../../agent/reference/) 中的精简版。它与本目录的人读参考同源，示例换成了第三个领域（M222），测试会核对两份参考覆盖相同的类型与约束。
