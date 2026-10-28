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
| 1.1.0 | 2026-10-27 | 审计补代建写入的内容（P1 票据 03，M347）：`AuditEvent` 加可选的 `beforeSha256`、`afterSha256`、`diff`（增删改计数加至多 50 个路径，各带前后内容哈希）、`round`、`reason`；`GET /v1/audit-events` 加可选的 `actorKind`、`from`、`to` 筛选；新增 `GET /v1/audit-events/export.csv` 按同样的筛选导出 | 兼容，只做加法 |
