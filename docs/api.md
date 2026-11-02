# 开放 API

出图服务的开放 API 写给客户开发者。它是 JSON over HTTP，路径带主版本 `/v1`。出图控制台也只调用这套 API。服务怎样部署、身份与权限怎样划分、各端点的业务规则，见[出图服务](service.md)。

## 描述与版本

- **机器可读的描述**：`GET /v1/openapi.json` 返回 OpenAPI 3.1，不需要鉴权，可以拿来生成客户端。仓库里的快照是 [docs/api/openapi.json](api/openapi.json)，与服务返回的相同。
- **请求体**：批量交付、草稿预览与数据集的请求体就是 DSL 1.0 的 JSON Schema（[schemas/](../schemas/)），描述原样收录。
- **当前版本**：`info.version`，见文末的[变更记录](#变更记录)。

## 鉴权

每个请求带 `Authorization: Bearer <令牌>`。令牌有三种：

| 令牌 | 前缀 | 怎么得到 |
|---|---|---|
| 会话 | `rws_` | `POST /v1/sessions`，用成员的邮箱与密码换，12 小时有效 |
| API 密钥 | `rwk_` | 客户管理员创建，只在创建时显示一次 |
| 代建令牌 | `rwa_` | 平台管理员签发给代建工程师 |

谁能调哪个端点，按 M247 的权限矩阵（[出图服务](service.md#账号与鉴权)）。每个端点需要的权限写在描述的 `x-access` 里。客户开发者一般用 API 密钥：它有操作员的全部权限，另外能管理 webhook。提交批次之前可以用 `GET /v1/usage` 看本月剩余的张数（M300）；用量明细只给客户管理员。

## 错误

错误回答一律是问题清单，格式与命令行、引擎的问题清单相同：

```json
{ "problems": [ { "level": "severe", "code": "quota.exceeded", "location": { "kind": "input", "source": "request.items" },
  "message": "本月（2026-10）额度不够这一批：……" } ],
  "quota": { "period": "2026-10", "limit": 100, "used": 98, "reserved": 0, "remaining": 2, "requested": 3 } }
```

- `level`：`severe`（严重）或 `hint`（提示）。错误回答里至少有一个严重问题。
- `location`：问题的位置。请求本身的问题是 `{ "kind": "input", "source": "request.body.url" }` 这样的写法；数据集、模板的问题定位到字段、参数或元素，与命令行相同。
- 额度不足时另带 `quota`，推送冲突时另带 `diff`。

HTTP 状态按类别映射，每个端点会有哪些状态写在描述里：

| 状态 | 类别 | 问题码 |
|---|---|---|
| 400 | 请求不合法 | `request.invalid`、`import.workbookUnreadable`、`webhook.urlNotAllowed`、`push.contentMissing`、`push.contentMismatch`、`resource.replacementInvalid`，以及数据集、模板、批次请求检查出的引擎问题码 |
| 401 | 未鉴权 | `auth.required`、`auth.invalidCredentials` |
| 403 | 无权限 | `auth.forbidden` |
| 404 | 不存在；别的租户的对象也答 404 | `request.notFound` |
| 409 | 与已有内容冲突 | `member.emailTaken`、`member.lastAdmin`、`push.conflict`、`batch.idempotencyConflict`、`input.duplicate`、`resource.replacementStale`、`webhook.limitReached` |
| 413 | 超出大小或规模 | `limit.requestTooLarge`、`limit.datasetTooLarge`、`limit.pixelsExceeded`、`limit.expansionExceeded`、`limit.workbookTooLarge` |
| 415 | 请求体的类型不对 | `request.invalid` |
| 429 | 额度不足，或超出频率与并发 | `quota.exceeded`、`preview.rateLimited`、`replay.rateLimited` |
| 500 | 服务内部错误 | `service.internalError`；出图记录与对象存储里的内容不符时是 `record.integrityMismatch` |
| 503 | 暂时无法完成，稍后再试 | `worker.unavailable`、`replay.buildUnavailable` |

开放 API 的用例逐个端点核对这张表：每个回答的状态都在描述里，正文都符合描述，严重问题的问题码与状态对应（M276）。

## 常用流程

1. **看模板**：`GET /v1/templates` 列出模板。每个模板带适用尺寸范围、所用的数据定义与对外参数。
2. **写数据**：`POST /v1/datasets` 保存数据集。保存时按所选的静态数据定义校验，有严重问题答 400 与问题清单。只想校验、不保存，用 `POST /v1/dataset-checks`。
   - 要按数据定义生成表单或核对字段，`GET /v1/static-schemas` 列出本租户的静态数据定义，`GET /v1/static-schemas/{name}/versions/{version}` 给出原文与编译产物（JSON Schema 2020-12，`title` 是显示名称）。出图控制台的表单就由它生成。
3. **预览**：`POST /v1/previews` 同步返回草稿图（base64）与问题清单。预览不计额度，按套餐的并发数与每分钟次数限流。
4. **交付**：`POST /v1/batches` 提交批次，答 202。
   - 带上 `Idempotency-Key`：网络抖动时重试，拿回的是同一批次（200），不重复交付，也不重复计费。
   - 本月额度不够时整批拒绝，答 429 `quota.exceeded`，回答带 `quota`。
5. **等结果**：注册 webhook，批次结束时会收到通知（见下节）。也可以轮询 `GET /v1/batches/{batchId}`，直到 `status` 为 `finished`。`outcome` 是结束时的结果：
   - `completed`：全部交付；
   - `partiallyFailed`：部分失败；
   - `failed`：全部失败；
   - `cancelled`：已取消。
6. **取图**：
   - 单张图：`GET /v1/batches/{batchId}/items/{index}/files/image.png`；
   - 整批图片：`GET /v1/batches/{batchId}/images.zip`；
   - 留档：`GET /v1/batches/{batchId}/export.zip`。导出包能用命令行 `renderweave replay` 离线重放。

## 数据定义草案

草案是一个数据定义名称还没发布的那一份（1.2.0）。每个名称至多一份，记它基于哪个静态版本。客户管理员用 `/v1/definitions…`，代建工程师用 `/v1/authoring/tenants/{tenantId}/definitions…`，同一组操作，请求与回答相同；客户操作员与 API 密钥只读。

| 操作 | 端点 | 说明 |
|---|---|---|
| 列出 | `GET /v1/definitions` | 每个名称的静态版本、各版本被多少数据集与模板直接使用，以及草案 |
| 新建 | `POST /v1/definitions/{name}/draft` | 请求体写 `{ "displayName": "…" }` 是空白新建，写 `{ "fromVersion": 1 }` 是从静态版本另起（复制原文，去掉版本号）。已有草案答 409 `input.duplicate`；空白新建不能用已有静态版本的名称，也答 409 |
| 读取 | `GET …/draft` | 登记信息与 `content`：原文，与保存时逐字节相同，它的 SHA-256 就是 `sha256` |
| 保存 | `PUT …/draft?expectedSha256=…` | 请求体是数据定义的 JSON 原文，整份替换，按原始字节存。预期哈希不是当前内容答 409 `draft.stale`，回答带 `currentSha256`；读回最新内容再改 |
| 校验与编译预览 | `GET …/draft/check` | 只读，见下 |
| 发布预检 | `POST …/draft/publish-check` | 请求体 `{ "expectedSha256": "…" }`，只读，见下 |
| 发布 | `POST …/draft/publish` | 同样的请求体。得到下一个静态数据定义，产物与本地 `renderweave publish` 逐字节相同，然后删除草案。严重问题答 400，问题码与本地发布相同；预期哈希不是当前内容答 409 `draft.stale`；版本刚被别的发布或推送占用答 409 `draft.versionTaken`，什么也没写，重新发布 |
| 删除 | `DELETE …/draft` | 静态版本不受影响 |

保存只要求请求体是 UTF-8 的 JSON 对象、`name` 与路径一致、数值不超过 15 位有效数字，还没写完的草案也能存。名称是身份，不能在草案里改；要换名称就新建一份。草案不进工作区，渲染、数据集与模板都看不到它。

校验回答这些字段：

```json
{ "sha256": "…", "problems": [ { "level": "severe", "code": "definition.constraintConflict",
    "location": { "kind": "definition", "schema": "线路牌", "path": "fare.constraints" }, "message": "约束冲突：下界 10 大于上界 1" } ],
  "affectedBindings": [ { "field": "fare", "templates": [ { "name": "标准线路单边", "base": { "name": "线路牌", "version": 1 } } ] } ] }
```

- `problems` 定位到字段，与发布走同一入口：写了不对的版本号、引用的静态数据定义不存在，这里都报。
- 没有严重问题时另有 `version`（发布后的版本号）与 `compiled`（编译产物 JSON Schema，与发布的产物相同）。
- `affectedBindings` 列出与基于的版本相比被删除的字段，改字段名称等于删一个、加一个。`templates` 是当前修订读到这个字段的模板，经过引用读到的也算（`nextStop.landmark` 算用到停靠站点的 `landmark`）。

发布预检回答这些字段，有严重问题时只有 `sha256`、`baseVersion` 与 `problems`：

- `version`：发布后的版本号。
- `diff`：与基于版本的字段级差异，结构同引擎的 `diffDefinition`。新名称没有基准，字段全算新增。
- `datasets`：绑定基于版本的数据集按 ID 排序，逐份按新编译产物校验。`total` 是总份数，`checked` 是校验了几份，`mismatched` 是会失配的份数，`samples` 是前 20 份的问题摘要。超过 1,000 份只校验前 1,000 份，`complete` 为 `false`，标为未全部核对。
- `templates`：基准是这个名称的模板。发布不改动它们，它们照旧绑定各自的版本。

回退没有单独的端点：从旧版本另起草案（`fromVersion`），再发布成新版本。旧版本不变。

## 模板工作副本

工作副本是一个模板还没保存的那一份（1.5.0）。每个模板至多一份，记它基于哪个修订。暂存不影响当前修订，出图照旧读当前修订。客户管理员用 `/v1/templates/{name}…`，代建工程师用 `/v1/authoring/tenants/{tenantId}/templates/{name}…`，同一组操作；客户操作员与 API 密钥只读。

| 操作 | 端点 | 说明 |
|---|---|---|
| 列出 | `GET /v1/template-working-copies` | 本租户全部工作副本，含复制出来还没保存的新模板 |
| 新建 | `POST /v1/templates/{name}/working-copy` | 从当前修订新建，记基准修订。已有工作副本答 409 `input.duplicate` |
| 读取 | `GET …/working-copy` | 登记信息与 `content`：原文，与暂存时逐字节相同 |
| 暂存 | `PUT …/working-copy?expectedSha256=…` | 请求体是模板的 JSON 原文，整份替换。预期哈希不是当前内容答 409 `draft.stale`，回答带 `currentSha256` |
| 检查 | `GET …/working-copy/check` | 只读：`problems` 是模板静态检查的问题，`changes` 是当前修订到工作副本的结构化差异；基准不是当前修订时另有 `conflict` |
| 保存 | `POST …/working-copy/save` | 请求体 `{ "expectedSha256": "…", "overwrite": false }`，见下 |
| 丢弃 | `DELETE …/working-copy` | 当前修订不受影响 |
| 复制为新模板 | `POST /v1/templates/{name}/copies` | 请求体 `{ "name": "新名称" }`。内容与基准数据定义取当前修订，成为没有基准修订的工作副本。名称已有模板或工作副本答 409 |
| 修订历史 | `GET /v1/templates/{name}/revisions` | 修订号、主体、时间与来源（`push`、`web`） |
| 指回旧修订 | `POST /v1/template-current` | 请求体 `{ "template": "…", "revision": 1 }`，客户管理员；代建工程师用原来的 `…/template-current` |

**保存**按顺序核对：

1. 预期哈希不是当前内容，答 409 `draft.stale`。
2. 模板静态检查有严重问题，答 400，问题清单同 `check`。
3. 基准修订不是当前修订，答 409 `template.revisionConflict`，`conflict` 带 `baseRevision`、`currentRevision`、`ours`（基准到工作副本）与 `theirs`（基准到当前修订）。看过之后带 `overwrite: true` 才覆盖。

通过之后记新修订（来源 `web`），当前修订指向它，删除工作副本，回答 `status: "saved"`。内容与当前修订字节相同时不记修订，回答 `status: "unchanged"`，工作副本照样删除。

**用工作副本预览**：`POST /v1/previews?workingCopies=true`，请求体不变，检查与限制也都一样。有工作副本的模板全部用工作副本，复制出来还没保存的新模板也能预览。不带这个参数时照旧读当前修订。

**元素定位**：预览回答多一个可选的 `elements`，列出会显示的元素实例：

```json
{ "elements": [ { "path": "标准线路单边/站点面板/站点列[3]/站名", "source": { "template": "停靠站点", "path": "停靠站点/站名" } } ] }
```

`path` 与布局摘要里的元素路径相同，带调用链与循环序号。`source` 是这个元素所在的模板文档与它在文档里的路径。页面按布局摘要的元素框命中，再按 `source` 打开模板文档里的位置。

## Excel 导入

一批简单数据（如几百张价签）可以从 Excel 导入，一行一个渲染项（M283–M286）。导入只做预览，确认后再提交批次。

1. **空白表**：`GET /v1/static-schemas/{name}/versions/{version}/workbook` 按数据定义生成一份只有表头的 `.xlsx`。
   - 主表以数据定义的显示名称命名，先是可选的"渲染项 ID"列，再是各字段，表头是字段的显示名称；
   - 引用与引用列表（如停靠站点）各另起一张表，第一列是关联值；
   - 文字类的列是文本格式，可选值固定的列有下拉选择，选中单元格时提示怎么填。
2. **填写**：
   - 表头写显示名称或字段名称都可以，不计空白与大小写；不认识的列提示后忽略。表头上方可以有标题行：前 5 行里第一个认得出列的行是表头。
   - 简单类型的列表写在一格里，用换行、顿号、逗号或分号分开。
   - 引用列表：主表这一列写关联值，引用表里同名的列写同一个值，几行按先后组成列表；主表的几行可以共用一个关联值。单个引用只能对应一行。
   - 日期、时刻可以是 Excel 的日期，也可以写 `2026/1/2`、`8:30` 这类文字；是否写 是/否、TRUE/FALSE 或 1/0；图片可以只写资源 ID。
   - 不写"渲染项 ID"时，项 ID 是"第 N 行"。
3. **预览**：`POST /v1/excel-imports`，请求体是 `{ template, workbook, parameters?, output }`，`workbook` 是文件内容的 base64。回答：
   - `rows`：逐行的 `itemId`、`status`（`accepted` 能提交，`rejected` 有严重问题）、读出的 `dataset` 与 `problems`；
   - `problems`：整份的问题，如不认识的列、没被引用的行；
   - `batch`：只含能提交的行的批量请求，数据集内联在各项里。
   每个问题与问题清单同一格式，另带 `cell`（工作表、行、列与表头）。各行的检查与保存数据集时相同，引擎的问题码照旧；导入自己的问题码如下：

   | 问题码 | 等级 | 说明 |
   |---|---|---|
   | `import.noRows` | 严重 | 主表在表头下面没有数据行 |
   | `import.columnUnknown` | 提示 | 表头不对应任何字段，这一列忽略 |
   | `import.columnDuplicate` | 严重 | 两列对应同一个字段（或两列渲染项 ID、两列关联值） |
   | `import.columnMissing` | 提示 | 必填字段没有对应的列，或引用表缺关联值的列 |
   | `import.fieldUnsupported` | 提示 | 字段是第二层引用，不能从 Excel 导入 |
   | `import.cellError` | 严重 | 单元格是 Excel 的错误值，如 `#N/A` |
   | `import.itemIdDuplicate` | 严重 | 渲染项 ID 与前面的行重复 |
   | `import.referenceNotFound` | 严重 | 关联值在引用表里没有对应的行，或没有那张表 |
   | `import.referenceTooManyRows` | 严重 | 单个引用的关联值对应了不止一行 |
   | `import.rowOrphan` | 提示 | 引用表里的行没被主表引用 |
   | `import.batchTooLarge` | 严重 | 能提交的行合起来超过批量请求的字节上限 |

   出图参数与对外参数按第一行能提交的数据检查一次，不合规的问题（如 `parameter.unknown`、`render.sizeOutOfRange`）列在整份的 `problems` 里。有严重问题的行不进 `batch`；整份有严重问题或没有能提交的行时，回答里没有 `batch`。
4. **提交**：确认后把 `batch` 原样提交到 `POST /v1/batches`（带上 `Idempotency-Key`），之后与常用流程相同。
5. **上限**：文件 5 MiB、解压后 32 MiB、非空单元格 50 万个、主表 1,000 行、引用展开 5 万行（几行共用一个关联值时重复计），超出整份拒绝，答 413 `limit.workbookTooLarge`。只解开用得到的部件与工作表，样式、图形与别的工作表不算。不是 `.xlsx`、文件损坏、旧版 `.xls` 或加了打开密码，答 400 `import.workbookUnreadable`。

## webhook

批次结束时（完成、部分失败、全部失败或取消），服务向本租户每个启用、订阅了 `batch.finished` 的 webhook 各投递一次事件，不用轮询（M277）。

### 注册与管理

客户管理员与 API 密钥可以管理 webhook：

```http
POST /v1/webhooks
{ "url": "https://example.com/renderweave/hooks", "description": "订单系统" }
```

回答 201，带 `webhook` 与 `secret`。

- **签名密钥**：`secret` 是这个 webhook 的签名密钥，以 `whsec_` 开头，只在这里出现一次，请存进你的密钥管理里。之后的列表只给它的前缀 `secretPrefix`。
- **地址**：只投递 https 与公网地址。指向本机、内网、链路本地与保留地址的 URL 答 400 `webhook.urlNotAllowed`。投递时还会再查解析出的地址，域名改指内网也不会投。
- **上限**：每个租户最多同时启用 10 个，超过答 409 `webhook.limitReached`。
- **管理**：
  - `GET /v1/webhooks` 列出；
  - `PATCH /v1/webhooks/{webhookId}` 停用（`{"active": false}`）、重新启用或改说明；
  - URL 与订阅的事件不改。要换地址或换签名密钥，先注册新的，确认收得到，再停用旧的。
- webhook 不删除。停用后不再投递，投递记录保留。

### 事件

```http
POST /renderweave/hooks HTTP/1.1
Content-Type: application/json
RenderWeave-Event-Id: 6d1f…
RenderWeave-Event-Type: batch.finished
RenderWeave-Delivery-Id: 42
RenderWeave-Attempt: 1
RenderWeave-Signature: t=1792468800,v1=5b2c…

{"id":"6d1f…","type":"batch.finished","createdAt":"2026-10-20T06:40:00.000Z","tenantId":"…","data":{"batch":{
  "id":"…","template":"问候牌","mode":"final","build":"sha256:…","outcome":"partiallyFailed","cancelRequested":false,
  "createdAt":"…","finishedAt":"…","summary":{"total":3,"delivered":2,"previewed":0,"failed":1,"notRun":0,"severe":1,"hints":0},"problems":[]}}}
```

- 正文是批次的摘要，不含逐项结果；要逐项结果时用 `GET /v1/batches/{batchId}` 取。
- 事件 ID 在重试时不变。服务至少投递一次，极少数情况下（投递中途服务重启）同一事件会到两次，请按 `RenderWeave-Event-Id` 去重。

### 校验签名

`RenderWeave-Signature` 的格式是 `t=<Unix 秒>,v1=<十六进制>`。其中 `v1` 是用签名密钥（整个 `whsec_…` 字符串的 UTF-8 字节）对 `<t>.<原始正文>` 算的 HMAC-SHA256。

1. 读原始正文的字节，不要先解析再序列化。
2. 用同样的方法算出 HMAC，以定长比较与 `v1` 比对。
3. 核对 `t` 与当前时间相差不超过 5 分钟。每次重试都用发送时刻重新签名，挡住重放。

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, header, rawBody, now = Date.now()) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(`${match[1]}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex')) && Math.abs(now / 1000 - Number(match[1])) <= 300;
}
```

### 重试与投递记录

- **成功**：在 10 秒内回答任何 2xx 都算收到。重定向不跟随，算作失败。
- **重试**：其余回答、超时与连接失败都按指数退避重试。缺省共试 8 次，间隔是 1、2、4、8、16、32、64 分钟，约 2 小时后不再试，这条投递记为失败。
- **投递记录**：`GET /v1/webhooks/{webhookId}/deliveries` 按时间倒序列出投递。每条投递带：
  - 状态：`pending` 还会再试，`succeeded` 已收到，`failed` 不再试；
  - 下一次尝试的时间；
  - 各次尝试的时间、耗时，以及收到的 HTTP 状态或失败原因。

## 兼容策略

1.x 只做加法，比照 DSL 的 [ADR-0016](adr/0016-dsl-1-compatibility.md)：升级不打断已有的集成（M276）。

**算加法，1.x 里会发生**：

- 新增端点、新增事件种类（要显式订阅，已注册的 webhook 收到的事件不变）；
- 请求里新增可选的参数与属性，放宽取值范围；
- 回答里新增属性、新增枚举值、新增可选的形状（如新的身份种类）；
- 新增问题码与错误状态；问题说明的措辞改进。

**不兼容，只在 `/v2` 里做**：

- 删除或改名端点、参数与属性；
- 新增必填的参数与属性，收窄类型、枚举与取值范围；
- 回答里删属性、必有的属性变成可有可无、改变类型与含义；
- 改变已有问题码的含义、错误状态的类别，改变签名算法。

**客户端要做到**：

- 忽略回答里不认识的属性与枚举值；
- 按状态的类别处理不认识的问题码；
- webhook 接收端按事件种类分发，忽略不认识的种类。

**怎样保证**：

- 用例把描述与 [docs/api/openapi.json](api/openapi.json) 快照比对。描述有变化时测试失败，要用 `npx vitest run -u` 显式更新快照，并在下面的变更记录里写明改了什么、是否兼容。
- 用例另把描述与 1.0.0 的基线 [docs/api/openapi-1.0.0.json](api/openapi-1.0.0.json) 比较，列出不是加法的改动，比如删端点、新增必填、回答删属性。有这样的改动时测试失败。
- 描述与基线不同时，版本号要升：只做加法升次版本号（1.1.0），并在变更记录里写一行。
- 基线已在阶段 4 验收时定稿（2026-10-22，[票据 15](../.scratch/render-service-v1/issues/15-capacity-and-acceptance.md)，M304）。此后不再重写基线：新增端点与属性升次版本号，不兼容的改动要另开主版本。定稿前并入 1.0.0 的改动见下面的变更记录。

## 变更记录

| 版本 | 日期 | 改动 | 兼容 |
|---|---|---|---|
| 1.0.0 | 2026-10-20 | 首个版本：账号与鉴权、模板与草稿预览、批量交付、数据集与资源、出图记录与重放、用量与套餐、代建推送、webhook；批次加 `outcome`。定稿前并入：静态数据定义的两个只读端点（票据 12），Excel 导入预览与空白表（票据 13）；`GET /v1/usage` 的访问要求从 `usage.read` 改为 `usage.summary`，操作员与 API 密钥也能看合计（票据 14，M300），按兼容检查算访问要求变了，重写基线。2026-10-22 阶段 4 验收时定稿 | — |
| 1.5.0 | 2026-11-01 | 模板工作副本（P1 票据 07，M346、M352）：新增 `GET /v1/template-working-copies`，`POST`、`GET`、`PUT`、`DELETE /v1/templates/{name}/working-copy`，`GET …/working-copy/check`，`POST …/working-copy/save`，`POST /v1/templates/{name}/copies`，`GET /v1/templates/{name}/revisions`，代建端点是同一组操作；`POST /v1/template-current` 把指回旧修订开放给客户管理员；`POST /v1/previews` 与代建预览加可选的 `workingCopies=true`，回答加可选的 `elements`（元素定位）；修订加 `source`；问题码 `template.revisionConflict`（409，回答带 `conflict`） | 兼容，只做加法 |
| 1.4.0 | 2026-11-01 | 发布数据定义草案（P1 票据 05，M346）：新增 `POST …/definitions/{name}/draft/publish-check` 与 `POST …/draft/publish`，客户端点与代建端点各一组；问题码 `draft.versionTaken`（409） | 兼容，只做加法 |
| 1.3.0 | 2026-11-01 | 平台管理页的汇总（P1 票据 12）：新增 `GET /v1/platform/overview`，服务健康（就绪、worker 报到数与构建、队列积压）与每个租户的套餐、本月用量和启用的成员数，记进每个租户的审计（`overview.read`） | 兼容，只做加法 |
| 1.2.0 | 2026-11-01 | 数据定义草案（P1 票据 04，M345、M346、M351）：新增 `GET /v1/definitions`，`POST`、`GET`、`PUT`、`DELETE /v1/definitions/{name}/draft`，`GET …/draft/check`，代建端点 `/v1/authoring/tenants/{tenantId}/definitions…` 是同一组操作；问题码 `draft.stale`（409，回答带 `currentSha256`）；权限矩阵加 `definitions.write`、`templates.write`、`authoring.publish`、`authoring.approve`、`authoring.policy` | 兼容，只做加法 |
| 1.1.0 | 2026-10-27 | 审计补代建写入的内容（P1 票据 03，M347）：`AuditEvent` 加可选的 `beforeSha256`、`afterSha256`、`diff`（增删改计数加至多 50 个路径，各带前后内容哈希）、`round`、`reason`；`GET /v1/audit-events` 加可选的 `actorKind`、`from`、`to` 筛选；新增 `GET /v1/audit-events/export.csv` 按同样的筛选导出 | 兼容，只做加法 |
