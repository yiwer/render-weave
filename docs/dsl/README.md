# RenderWeave DSL 1.0

DSL 1.0 是 RenderWeave 五种 JSON 文档的成文契约（M219）。它冻结的是现行写法，不新增能力。兼容策略见 [ADR-0016](../adr/0016-dsl-1-compatibility.md)：1.x 只做加法；解析器继续拒绝未知键；破坏性改动升到 `/2`，并附迁移说明。

| 文档 | 标识 | 参考 | JSON Schema |
|---|---|---|---|
| 数据定义 | `"dslVersion": "renderweave-schema/1"` | [数据定义与数据集](data-definition.md) | [data-definition.schema.json](../../schemas/data-definition.schema.json) |
| 数据集 | 由 `dataset` 与 `data` 两部分组成 | [数据定义与数据集](data-definition.md#数据集文档) | [dataset.schema.json](../../schemas/dataset.schema.json) |
| 模板 | `"dslVersion": "renderweave-template/1"` | 第三阶段票据 02 | 第三阶段票据 02 |
| 渲染请求 | 命令行 `render --request` 与公开渲染入口的输入 | 第三阶段票据 02 | 第三阶段票据 02 |
| 批次请求 | `"format": "renderweave-batch/1"` | 第三阶段票据 02；现有说明见[出图记录](../output-records.md) | 第三阶段票据 02 |

## Schema 与引擎的分工

- **JSON Schema 只检查结构**：键是否允许、类型、枚举取值、必填项。Schema 拒绝的文档，引擎一定拒绝。
- **引擎另做语义检查**：约束冲突、正则合法性、字段名称重复、引用是否存在、数据是否符合所选静态数据定义等。这类问题 Schema 表达不了，每份参考的「Schema 之外的检查」逐类列出。
- **一致性测试**：`test/dsl-schema.test.ts` 用仓库中的全部语料与结构错误的变异样本，核对两边的判断。改动解析器或 Schema 时，这项测试必须保持通过。

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
