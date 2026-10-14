# RenderWeave 数据定义与数据集参考

出图分两层：**数据定义**描述一类图上随业务变化的信息（字段、类型、约束）；**模板**决定版式、颜色、字体和固定装饰。本任务只做数据定义与数据集，固定装饰、颜色、版式不进数据定义。

## 数据定义 DSL（renderweave-schema/1）

```json
{
  "dslVersion": "renderweave-schema/1",
  "name": "数据定义名称（可用中文，唯一）",
  "version": 1,
  "displayName": "显示名称",
  "description": "可选说明",
  "fields": [ 字段, ... ]
}
```

- `version` 可省略；首次发布为 1。被引用的数据定义必须先发布。
- 字段：`{ "name", "displayName", "description"?, "type", "constraints"?, "items"?, "ref"? }`，不允许其他键。
- 字段名称 `name` 用英文：字母开头，只含字母、数字、下划线；中文写在 `displayName`。同一数据定义内不能重名。
- 必填写在约束里：`"constraints": { "required": true }`。未写即可选。

| type | 含义 | 可用约束（除 required 外） | 数据集中的写法 |
|---|---|---|---|
| text | 文本 | minLength、maxLength、pattern（正则）、enum（取值列表） | "文本" |
| number | 数值 | min、max、integer、enum | 12.5 |
| date | 日期 | 无 | "2026-01-02" |
| time | 时刻 | 无 | "08:30" |
| datetime | 日期时间 | 无 | "2026-01-02 08:30:00" |
| boolean | 是否 | 无 | true |
| image | 图片 | allowedSources：["resource"]、["url"] 或两者 | "res:资源ID" |
| list | 列表 | minItems、maxItems；用 `items` 写元素类型（元素不能再是列表，元素不能写 required） | [ ... ] |
| ref | 引用另一个数据定义 | 无；用 `ref: {"name": "被引用名称", "version": 1}` | { ... } 按被引用定义的字段 |

- 约束之间不能冲突（如 minLength 大于 maxLength、枚举值违反长度约束）。
- 数据集出现数据定义里没有的键会报错；可选字段没有值时直接省略该键。

## 数据集

```json
{
  "dataset": {
    "id": "英文或数字标识",
    "name": "显示名称",
    "staticSchema": { "name": "数据定义名称", "version": 1 },
    "origin": { "kind": "manual", "note": "来源说明" }
  },
  "data": { 按数据定义填写的业务数据 }
}
```

## 示例（另一个领域：商品价签）

规格项.json
```json
{
  "dslVersion": "renderweave-schema/1", "name": "规格项", "version": 1, "displayName": "规格项",
  "fields": [
    { "name": "label", "displayName": "规格名", "type": "text", "constraints": { "required": true, "maxLength": 6 } },
    { "name": "value", "displayName": "规格值", "type": "text", "constraints": { "required": true, "maxLength": 12 } }
  ]
}
```

价签.json
```json
{
  "dslVersion": "renderweave-schema/1", "name": "价签", "version": 1, "displayName": "商品价签",
  "fields": [
    { "name": "productName", "displayName": "品名", "type": "text", "constraints": { "required": true, "minLength": 1, "maxLength": 24 } },
    { "name": "price", "displayName": "售价（元）", "type": "number", "constraints": { "required": true, "min": 0 } },
    { "name": "unit", "displayName": "计价单位", "type": "text", "constraints": { "enum": ["件", "千克", "盒"] } },
    { "name": "promoEnds", "displayName": "促销截止", "type": "date" },
    { "name": "logo", "displayName": "品牌标志", "type": "image", "constraints": { "allowedSources": ["resource"] } },
    { "name": "specs", "displayName": "规格", "type": "list", "items": { "type": "ref", "ref": { "name": "规格项", "version": 1 } }, "constraints": { "maxItems": 4 } }
  ]
}
```

数据集：
```json
{
  "dataset": { "id": "tag-001", "name": "示例价签", "staticSchema": { "name": "价签", "version": 1 }, "origin": { "kind": "manual", "note": "示例" } },
  "data": { "productName": "示例商品", "price": 9.9, "unit": "件", "logo": "res:brand-logo", "specs": [ { "label": "产地", "value": "示例" } ] }
}
```

## 可用工具

- `mcp__rw__list_resources`：资源仓库中可引用的资源。
- `mcp__rw__check_definitions`：按顺序在内存中发布数据定义文件（被引用的放前面），返回问题清单与编译出的 JSON Schema。
- `mcp__rw__check_dataset`：发布数据定义后校验数据集，并检查 res: 资源引用。
