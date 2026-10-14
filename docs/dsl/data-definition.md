# 数据定义与数据集（DSL 1.0）

数据定义描述一类图上随业务变化的信息：有哪些字段、各是什么类型、受什么约束。数据集是一份按某个静态数据定义填写的业务数据。版式、颜色与固定装饰写在模板里，不属于数据定义。

- 结构契约：[data-definition.schema.json](../../schemas/data-definition.schema.json)、[dataset.schema.json](../../schemas/dataset.schema.json)。
- 兼容策略：[ADR-0016](../adr/0016-dsl-1-compatibility.md)。
- 真实样例：[M402 线路牌](../examples/m402-dsl/README.md)。

## 数据定义文档

### 顶层

| 键 | 必填 | 写法 |
|---|---|---|
| `dslVersion` | 是 | 固定为 `"renderweave-schema/1"` |
| `name` | 是 | 名称，可用中文，不能只含空白 |
| `version` | 否 | 正整数。省略时由发布分配；写明时必须等于发布将分配的版本 |
| `displayName` | 否 | 显示名称，省略时取 `name` |
| `description` | 否 | 说明文本 |
| `fields` | 是 | 字段列表，可以为空 |

不允许出现其他键（M90 S7）。任何可选键都不能写成 `null`：要么写值，要么省略（M223）。

### 字段

| 键 | 必填 | 写法 |
|---|---|---|
| `name` | 是 | 英文字母开头，只含字母、数字与下划线（M89），同一数据定义内不能重复 |
| `displayName` | 是 | 显示名称，中文写在这里 |
| `description` | 否 | 说明文本 |
| `type` | 是 | 九种类型之一，见下表 |
| `constraints` | 否 | 约束对象；可写的键随类型而定。必填写成 `"required": true`，省略即可选 |
| `items` | 列表必填 | 列表元素的类型：`{ "type", "constraints"?, "ref"? }`；只有 `list` 能写 |
| `ref` | 引用必填 | 被引用的静态数据定义：`{ "name", "version" }`，必须是确切版本；只有 `ref` 能写 |

### 字段类型与约束

| 类型 | 含义 | 约束（另可写 `required`） | 数据集中的写法 |
|---|---|---|---|
| `text` | 文本 | `minLength`、`maxLength`（非负整数，按字符计）；`pattern`（ECMAScript 正则，Unicode 模式）；`enum`（非空、不重复的文本列表） | `"示例"` |
| `number` | 数值 | `min`、`max`；`integer`（布尔）；`enum`（非空、不重复的数值列表） | `12.5` |
| `date` | 日期 | 无 | `"2026-01-02"`，必须是真实存在的日期 |
| `time` | 时刻 | 无 | `"08:30"`，秒可选：`"08:30:15"` |
| `datetime` | 日期时间 | 无 | `"2026-01-02 08:30:00"`，空格分隔，必须带秒 |
| `boolean` | 是否 | 无 | `true` / `false` |
| `image` | 图片 | `allowedSources`：`["resource"]`、`["url"]` 或两者，省略时两者都允许 | 资源引用 `"res:资源ID"`，或 `http(s)://` 地址 |
| `list` | 列表 | `minItems`、`maxItems`（非负整数） | `[ … ]` |
| `ref` | 引用 | 无 | `{ … }`，按被引用定义的字段填写 |

- **日期与时刻不带时区**（M6）。
- **数值最多 15 位有效数字**（M112），约束中的 `min`、`max`、`enum` 与数据中的值都受此限。
- **列表元素**：写在 `items` 里，类型不能又是 `list`（M33）。元素的约束写在 `items.constraints` 中，不能写 `required`。基本类型列表的元素直接是值，例如 `["08:00", "08:25"]`；引用列表的元素是对象。
- **引用**：编译时内联展开被引用的定义。被引用的静态数据定义必须已经发布，且不能成环（M32、M39）。

### 发布与版本

数据定义可以修改；发布后形成不可变的静态数据定义，用名称加自增版本号标识（M18、ADR-0008）。

- 首次发布为 v1，之后每次发布在同名的最大版本上加 1。
- 已发布的版本不能修改；要改字段，就发布新版本，数据集与模板改为引用新版本。
- 发布同时生成编译产物：一份 JSON Schema 2020-12，是数据集校验的权威（ADR-0006）。编译产物的要点：
  - 引用内联展开；
  - 每个对象都写 `additionalProperties: false`（M90 S7）；
  - 日期、时刻、时间与图片写成自定义格式或正则，并用 `x-renderweave-type` 标明原类型；
  - 根上的 `x-renderweave-static-schema` 记录名称与版本。

## 数据集文档

```json
{
  "dataset": {
    "id": "badge-0001",
    "name": "张三的胸牌",
    "staticSchema": { "name": "胸牌", "version": 1 },
    "origin": { "kind": "manual", "note": "按会务名单录入" }
  },
  "data": {
    "fullName": "张三",
    "organization": "示例科技有限公司",
    "role": "讲者",
    "badgeNo": "SP0001",
    "photo": "res:test-quadrants-png",
    "seat": 12,
    "eventDate": "2026-11-20",
    "issuedAt": "2026-11-01 09:30:00",
    "vip": false,
    "mainSession": { "title": "主旨演讲", "startsAt": "09:30", "room": "一号厅" },
    "sessions": [
      { "title": "主旨演讲", "startsAt": "09:30", "room": "一号厅" },
      { "title": "分论坛：出图自动化", "startsAt": "14:00" }
    ],
    "tags": ["首次", "讲者"]
  }
}
```

- **根只有 `dataset` 与 `data` 两部分**（M223）。
- **身份部分 `dataset`**：
  - `staticSchema` 必填，写明所选静态数据定义的确切版本，只能有 `name` 与 `version`；
  - `id` 是文本，工作区中的数据集必须有，内联在渲染请求里时可以省略；
  - 其他键，如 `name`、`origin`，只作说明，引擎不作要求。
- **业务数据 `data`**：按所选静态数据定义的编译产物校验。
  - 出现未定义的键即报错；
  - 可选字段没有值时直接省略该键，不能写 `null`；
  - 数据集自成一体，不引用其他数据集（ADR-0010）。

## 示例：会议胸牌

被引用的"场次 v1"：

```json
{
  "dslVersion": "renderweave-schema/1",
  "name": "场次",
  "version": 1,
  "displayName": "参会场次",
  "fields": [
    { "name": "title", "displayName": "场次名称", "type": "text", "constraints": { "required": true, "maxLength": 20 } },
    { "name": "startsAt", "displayName": "开始时刻", "type": "time", "constraints": { "required": true } },
    { "name": "room", "displayName": "会场", "type": "text", "constraints": { "maxLength": 10 } }
  ]
}
```

"胸牌 v1"：

```json
{
  "dslVersion": "renderweave-schema/1",
  "name": "胸牌",
  "version": 1,
  "displayName": "会议胸牌",
  "description": "一位参会者的胸牌",
  "fields": [
    { "name": "fullName", "displayName": "姓名", "type": "text", "constraints": { "required": true, "minLength": 1, "maxLength": 12 } },
    { "name": "organization", "displayName": "单位", "type": "text", "constraints": { "maxLength": 30 } },
    { "name": "role", "displayName": "身份", "type": "text", "constraints": { "required": true, "enum": ["嘉宾", "讲者", "工作人员", "参会者"] } },
    { "name": "badgeNo", "displayName": "证件号", "type": "text", "constraints": { "required": true, "pattern": "^[A-Z]{2}[0-9]{4}$" } },
    { "name": "photo", "displayName": "照片", "type": "image", "constraints": { "allowedSources": ["resource"] } },
    { "name": "seat", "displayName": "座位排号", "type": "number", "constraints": { "integer": true, "min": 1, "max": 200 } },
    { "name": "eventDate", "displayName": "会议日期", "type": "date", "constraints": { "required": true } },
    { "name": "issuedAt", "displayName": "发证时间", "type": "datetime" },
    { "name": "vip", "displayName": "贵宾通道", "type": "boolean" },
    { "name": "mainSession", "displayName": "主场次", "type": "ref", "ref": { "name": "场次", "version": 1 } },
    { "name": "sessions", "displayName": "参会场次", "type": "list", "items": { "type": "ref", "ref": { "name": "场次", "version": 1 } }, "constraints": { "maxItems": 6 } },
    { "name": "tags", "displayName": "标签", "type": "list", "items": { "type": "text", "constraints": { "maxLength": 4 } }, "constraints": { "maxItems": 3 } }
  ]
}
```

上文「数据集文档」中的示例就是按"胸牌 v1"填写的。

## Schema 之外的检查

以下问题 JSON Schema 表达不了，由引擎报告。一致性测试会核对：凡是 Schema 接受、而引擎拒绝的文档，问题都在下面列出的类别里。

只看一份数据定义就能判断（公开入口 `checkDslDocument`）：

| 类别 | 问题代码 | 例子 |
|---|---|---|
| 约束冲突 | `definition.constraintConflict` | `minLength` 大于 `maxLength`；下界大于上界；`integer` 时上下界之间没有整数；枚举值违反长度、正则、范围或整数要求 |
| 正则不合法 | `definition.invalid` | `pattern` 不是合法的 ECMAScript 正则（Unicode 模式） |
| 有效数字超过 15 位 | `definition.invalid` | `min`、`max`、数值枚举超过 15 位有效数字（M112） |
| 字段名称重复 | `definition.invalid` | 同一数据定义中两个字段同名 |

需要其他文档才能判断（由发布与渲染入口报告）：

| 类别 | 问题代码 |
|---|---|
| 引用的静态数据定义不存在 | `definition.refNotFound` |
| 引用成环 | `definition.refCycle` |
| 文档中写的版本号与发布将分配的不符 | `definition.invalid` |
| 数据集选定的静态数据定义不存在或没有编译产物 | `input.staticSchemaNotFound`、`input.compiledSchemaMissing` |
| 数据集选定的静态数据定义与模板基准不是同一个版本（M37、ADR-0008） | `dataset.staticSchemaMismatch` |
| 数据不符合编译产物 | `dataset.requiredMissing`、`dataset.nullValue`、`dataset.unknownKey`、`dataset.typeMismatch`、`dataset.formatInvalid`、`dataset.constraintViolated`、`dataset.invalid` |
| 图片引用的资源不存在，或引用的是字体 | `dataset.resourceNotFound`、`dataset.resourceKindMismatch` |
| 数据中的数值超过 15 位有效数字 | `dataset.tooManyDigits` |

## 已知限制

DSL 1.0 照实记录以下能力边界；改变它们需要新的决定，按 ADR-0016 处理兼容。

- **没有嵌套列表**（M33）。列表的元素只能是基本类型或引用。
- **不能声明缺省值**，没有条件必填，也没有字段之间的约束（例如"首班早于末班"）。需要时在模板里用检查项表达。
- **枚举只支持文本与数值**，没有多选类型。多选写成文本枚举的列表。
- **展示格式不在数据定义里**：日期写法、小数位等由模板插槽的展示格式决定。
- **URL 图片尚未支持**：可以通过校验，但出图时不画内容并报问题；出图记录也不接受 URL 图片。
- **跨数据集共享实体**：不支持（ADR-0010）。
- **数据定义只能作为整体发布**：不能单独发布或修改某个字段。
