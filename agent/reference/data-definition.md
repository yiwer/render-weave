# RenderWeave 数据定义与数据集参考（DSL 1.0）

出图分两层：
- **数据定义**：描述一类图上随业务变化的信息，包括字段、类型与约束。
- **模板**：决定版式、颜色、字体和固定装饰。

固定装饰、颜色、版式不进数据定义。

## 数据定义（renderweave-schema/1）

```text
{
  "dslVersion": "renderweave-schema/1",
  "name": "数据定义名称（可用中文，唯一）",
  "version": 1,
  "displayName": "显示名称",
  "description": "可选说明",
  "fields": [ 字段, ... ]
}
```

- `version` 可以省略，首次发布为 1。被引用的数据定义必须先发布。
- 字段写成 `{ "name", "displayName", "description"?, "type", "constraints"?, "items"?, "ref"? }`，不允许其他键。
- 字段名称 `name` 用英文：字母开头，只含字母、数字和下划线；中文写在 `displayName`。同一数据定义内不能重名。
- 必填写在约束里：`"constraints": { "required": true }`；不写就是可选。
- 任何可选键都不能写成 `null`：要么写值，要么省略。

| type | 含义 | 可用约束（另可写 required） | 数据集中的写法 |
|---|---|---|---|
| text | 文本 | minLength、maxLength、pattern（正则）、enum（取值列表） | "文本" |
| number | 数值 | min、max、integer、enum | 12.5 |
| date | 日期 | 无 | "2026-01-02" |
| time | 时刻 | 无 | "08:30" |
| datetime | 日期时间 | 无 | "2026-01-02 08:30:00" |
| boolean | 是否 | 无 | true |
| image | 图片 | allowedSources：["resource"]、["url"] 或两者 | "res:资源ID" |
| list | 列表 | minItems、maxItems；用 `items` 写元素类型。元素不能再是列表，也不能写 required | [ ... ] |
| ref | 引用另一个数据定义 | 无；用 `ref: {"name": "被引用名称", "version": 1}` | { ... }，按被引用定义的字段填写 |

- **约束不能冲突**，例如 minLength 大于 maxLength，或枚举值违反长度约束。
- **数值最多 15 位有效数字**。
- **数据集里的键必须在数据定义中出现**，否则报错；可选字段没有值时，直接省略这个键。

## 数据集

```text
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

根上只能有 `dataset` 与 `data` 两部分；`staticSchema` 里只能写 `name` 与 `version`。

## 示例：会议胸牌

场次.json（被引用，先发布）：

```json
{
  "dslVersion": "renderweave-schema/1", "name": "场次", "version": 1, "displayName": "参会场次",
  "fields": [
    { "name": "title", "displayName": "场次名称", "type": "text", "constraints": { "required": true, "maxLength": 20 } },
    { "name": "startsAt", "displayName": "开始时刻", "type": "time", "constraints": { "required": true } },
    { "name": "room", "displayName": "会场", "type": "text", "constraints": { "maxLength": 10 } }
  ]
}
```

胸牌.json：

```json
{
  "dslVersion": "renderweave-schema/1", "name": "胸牌", "version": 1, "displayName": "会议胸牌",
  "fields": [
    { "name": "fullName", "displayName": "姓名", "type": "text", "constraints": { "required": true, "minLength": 1, "maxLength": 12 } },
    { "name": "role", "displayName": "身份", "type": "text", "constraints": { "required": true, "enum": ["嘉宾", "讲者", "工作人员", "参会者"] } },
    { "name": "badgeNo", "displayName": "证件号", "type": "text", "constraints": { "required": true, "pattern": "^[A-Z]{2}[0-9]{4}$" } },
    { "name": "photo", "displayName": "照片", "type": "image", "constraints": { "allowedSources": ["resource"] } },
    { "name": "seat", "displayName": "座位排号", "type": "number", "constraints": { "integer": true, "min": 1, "max": 200 } },
    { "name": "eventDate", "displayName": "会议日期", "type": "date", "constraints": { "required": true } },
    { "name": "issuedAt", "displayName": "发证时间", "type": "datetime" },
    { "name": "vip", "displayName": "贵宾通道", "type": "boolean" },
    { "name": "mainSession", "displayName": "主场次", "type": "ref", "ref": { "name": "场次", "version": 1 } },
    { "name": "sessions", "displayName": "参会场次", "type": "list", "items": { "type": "ref", "ref": { "name": "场次", "version": 1 } }, "constraints": { "maxItems": 6 } },
    { "name": "tags", "displayName": "标签", "type": "list", "items": { "type": "text", "constraints": { "maxLength": 4 } }, "constraints": { "minItems": 0, "maxItems": 3 } }
  ]
}
```

数据集：

```json
{
  "dataset": { "id": "badge-0001", "name": "张三的胸牌", "staticSchema": { "name": "胸牌", "version": 1 }, "origin": { "kind": "manual", "note": "示例" } },
  "data": {
    "fullName": "张三", "role": "讲者", "badgeNo": "SP0001", "photo": "res:test-quadrants-png", "seat": 12,
    "eventDate": "2026-11-20", "issuedAt": "2026-11-01 09:30:00", "vip": false,
    "mainSession": { "title": "主旨演讲", "startsAt": "09:30", "room": "一号厅" },
    "sessions": [ { "title": "主旨演讲", "startsAt": "09:30", "room": "一号厅" }, { "title": "分论坛：出图自动化", "startsAt": "14:00" } ],
    "tags": ["首次", "讲者"]
  }
}
```
