# 出图服务

阶段 4 的出图服务（ADR-0017）由三部分组成：接口进程、PostgreSQL 里的任务队列、渲染 worker。代码在 `service/`，不进引擎的 `src/`，只经 `service/src/engine.ts` 调用引擎的公开入口。

目前完成了十二部分：

- **骨架**（[票据 03](../.scratch/render-service-v1/issues/03-service-skeleton.md)，M259、M260）：
  - Compose 编排、数据库迁移与健康检查；
  - 工作区文档、版本化资源仓库与出图记录的 PostgreSQL 加 S3 实现。
- **租户、账号与鉴权**（[票据 04](../.scratch/render-service-v1/issues/04-tenants-and-auth.md)，M261–M263）：
  - 成员登录、API 密钥与代建令牌；
  - 权限矩阵、行级安全与审计。
- **代建推送**（[票据 05](../.scratch/render-service-v1/issues/05-authoring-push.md)，M264、M265）：
  - 命令行 `renderweave push` 把本地工作区与资源版本仓库推送到客户的租户：先列差异，有冲突整体拒绝；
  - 模板记修订，可以把当前修订指回旧修订。
- **渲染 worker 与草稿预览**（[票据 06](../.scratch/render-service-v1/issues/06-draft-preview-and-workers.md)，M266、M267）：
  - PostgreSQL 里的任务队列，worker 的调度进程与渲染子进程，单项超时与内存上限；
  - 模板列表与只读查看、同步的草稿预览，入队前的限制与按租户的并发、频率。
- **批量正式交付**（[票据 07](../.scratch/render-service-v1/issues/07-batch-delivery.md)，M268、M269）：
  - 接口进程固定批次、按项入队，worker 逐项交付出图记录，全部项结束后发布批次清单；
  - 查询逐项进度与结果、取消、幂等键；批次只由接受它的构建交付，worker 停止前做完已接受的项。
- **数据集与资源接口**（[票据 10](../.scratch/render-service-v1/issues/10-datasets-and-resources-api.md)，M270、M271）：
  - 数据集的新建、读取、修改、复制、列出与只校验，按原始字节存，校验与渲染时对数据集的检查相同；
  - 图片与字体资源的上传、列出、读回，替换先检查影响、再凭报告按预期版本应用。
- **出图记录**（[票据 08](../.scratch/render-service-v1/issues/08-records-export-replay.md)，M272、M273）：
  - 按时间、模板与批次查询，下载单个文件与整批图片，按项或按批次导出，导出包能离线核对与重放；
  - 重放按记录里的构建标识交给那个构建的 worker，没有那个构建的 worker 时拒绝；镜像按构建保留。
- **计量与额度**（[票据 09](../.scratch/render-service-v1/issues/09-metering-and-quotas.md)，M274、M275）：
  - 平台管理员设置套餐（每月出图张数、单张最大像素、并发数）；提交批次先预占，额度不够整批拒绝，逐项结算，对账退回崩溃后遗留的预占；
  - 推送可以附带代建轮次，各轮的 token 记为用量事件；客户管理员与平台管理员看已用、预占、剩余与明细（合计后来也给操作员与 API 密钥，M300）。
- **开放 API 合同与 webhook**（[票据 11](../.scratch/render-service-v1/issues/11-api-contract-and-webhooks.md)，M276、M277）：
  - `GET /v1/openapi.json` 返回 OpenAPI 3.1 描述，有快照与 1.0.0 基线，1.x 只做加法；错误回答按类别映射状态，用例逐个端点核对。客户开发者的使用说明见[开放 API](api.md)；
  - 批次结束时向客户注册的 webhook 投递带签名的事件，失败按指数退避重试，投递记录可查。
- **出图控制台的第一条纵切**（[票据 12](../.scratch/render-service-v1/issues/12-console-form-preview-delivery.md)，M278–M282）：
  - 客户的管理员与操作员登录网页，以数据集为中心：按数据定义生成的表单填数据，看草稿预览、调对外参数，问题叠加在图上；
  - 正式出图在侧栏里进行，可以按一个整数参数的范围出多张，逐项看进度、能取消，下载单张图片与整批压缩包。见下文[出图控制台](#出图控制台)。
- **Excel 导入**（[票据 13](../.scratch/render-service-v1/issues/13-console-excel-import.md)，M283–M286）：
  - 服务端解析 `.xlsx`，一行一个渲染项，答导入预览：逐行的数据集与问题（定位到工作表、行与列），以及只含能提交的行的批量请求；确认后照常提交批次；
  - 按数据定义下载空白表；控制台在数据集页的侧栏里导入、预览与提交。见下文[Excel 导入](#excel-导入)。
- **控制台的记录、用量、资源与管理**（[票据 14](../.scratch/render-service-v1/issues/14-console-records-usage-admin.md)，M300、M301）：
  - 按时间、模板与批次查询出图记录，下载图片，按项或按批次导出；看本期的已用、预占与剩余，客户管理员另看用量明细；
  - 上传新资源，客户管理员替换资源前看影响、确认后应用；管理页只给客户管理员：成员与角色、只显示一次的 API 密钥、webhook 与投递记录、审计日志。见下文[出图控制台](#出图控制台)。

## 本机启动

需要 Docker 与 Node.js 22 以上，不需要在本机装服务的依赖。在仓库根目录执行：

```bash
node service/scripts/up.mjs
```

这条命令做三件事：

1. **生成凭据**：在仓库根的 `.env` 里补上缺少的随机凭据：数据库属主、应用账号、对象存储，以及加密 webhook 签名密钥的服务密钥。已有的值不动，`.env` 不进版本库，命令也不打印凭据。
2. **构建并启动**：构建镜像；起 PostgreSQL 与 S3 兼容存储；执行部署步骤 `setup`，包括迁移、应用账号与建桶；再起接口进程和一个 worker，等到全部就绪。
3. **打标签**：用渲染器构建标识给镜像打标签，形如 `renderweave-service:sha256-<哈希>`。

`.env` 齐全之后，也可以直接用 `docker compose up -d --build --wait`。停止用 `docker compose down`；连数据一起清掉，加 `-v`。

| 组件 | Compose 服务 | 端口 |
|---|---|---|
| 接口进程 | `api` | `8080`，可用 `RW_API_PORT` 改 |
| 渲染 worker | `worker` | `8081`，可用 `RW_WORKER_PORT` 改；起几个由 `RW_WORKERS` 定（见[容量基线](#容量基线)） |
| PostgreSQL 17 | `postgres` | 只在 Compose 网络内 |
| S3 兼容存储（RustFS 1.0.3） | `s3` | 只在 Compose 网络内 |
| 部署步骤 | `setup` | 迁移、设置应用账号、建桶后退出 |

**出图控制台**：浏览器打开 <http://localhost:8080/console/>，用租户成员（客户管理员或操作员）的账号登录。

**第一个平台管理员**：服务起来后执行下面的命令。它建一个平台管理员账号，随机初始密码只在终端显示一次，然后用这个邮箱和密码登录。

```bash
docker compose exec api node service/dist/main.js platform-admin admin@example.com
```

## 配置

配置只从环境变量读取，镜像与仓库里没有凭据（M259）。缺少变量时，进程只报变量名，不输出取值。

| 变量 | 谁用 | 含义 |
|---|---|---|
| `RW_DATABASE_URL` | 接口进程、worker | 应用账号 `renderweave_app` 的连接串（M262） |
| `RW_OWNER_DATABASE_URL` | `setup` | 属主账号的连接串，用来执行迁移 |
| `RW_APP_DATABASE_PASSWORD` | `setup` | 应用账号的密码，至少 16 个字符 |
| `RW_S3_ENDPOINT`、`RW_S3_BUCKET` | 全部 | 对象存储地址与桶名 |
| `RW_S3_ACCESS_KEY_ID`、`RW_S3_SECRET_ACCESS_KEY` | 全部 | 对象存储凭据 |
| `RW_S3_REGION` | 全部 | 缺省 `us-east-1` |
| `RW_S3_FORCE_PATH_STYLE` | 全部 | 缺省开启路径形式地址；写 `false` 关闭 |
| `RW_PORT` | 接口进程、worker | 监听端口，接口进程缺省 8080，worker 缺省 8081 |
| `RW_LOG_LEVEL` | 全部 | 缺省 `info` |
| `RW_RENDER_TIMEOUT_MS` | worker | 单项超时，缺省 60000（M266、M302） |
| `RW_RENDER_RECYCLE_AFTER` | worker | 渲染子进程做满这么多项后换新，缺省 500 |
| `RW_WORKER_POLL_MS` | worker | 队列空时隔多久再看，缺省 100 |
| `RW_RECONCILE_MS` | 接口进程 | 对账任务隔多久做一次，缺省 60000（M275） |
| `RW_RESERVATION_GRACE_MS` | 接口进程 | 批次闲置多久、又没有它的构建的 worker 时退回预占，缺省 600000（10 分钟） |
| `RW_TASK_RETENTION_MS` | 接口进程 | 预览与重放的任务行保留多久，缺省 3600000（1 小时），至少 120000；与对账同一个间隔清理 |
| `RW_SECRET_KEY` | 接口进程 | 服务密钥：64 位小写十六进制（32 字节），加密各 webhook 的签名密钥；必填，各接口进程用同一个（M277） |
| `RW_WEBHOOK_POLL_MS` | 接口进程 | 投递任务隔多久看一次到期的投递，缺省 1000 |
| `RW_WEBHOOK_RETRY_BASE_MS`、`RW_WEBHOOK_MAX_ATTEMPTS` | 接口进程 | 第一次重试前等多久（之后每次翻倍）与最多试几次，缺省 60000 与 8 |
| `RW_WEBHOOK_TIMEOUT_MS` | 接口进程 | 一次投递等回答的时间，缺省 10000 |
| `RW_WEBHOOK_ALLOW_PRIVATE` | 接口进程 | `true` 时允许 http 与本机、内网地址，只用于本机开发与测试；缺省 `false` |
| `RW_WORKER_MEMORY` | Compose | worker 容器的内存上限，缺省 `2g`，不用交换分区 |
| `RW_WORKER_CPUS` | Compose | 每个 worker 容器的 CPU，缺省 1（渲染是单线程的，见[容量基线](#容量基线)） |
| `RW_WORKERS` | Compose | 起几个 worker，缺省 1；多于 1 个时 `RW_WORKER_PORT` 写一段端口，如 `8081-8086` |
| `RW_WORKER_STOP_GRACE` | Compose | worker 的停止宽限，缺省 `30m`：停止时做完本构建已接受的批次项再退出（M269） |

本机的 `.env` 有五项：`RW_POSTGRES_PASSWORD`、`RW_APP_DB_PASSWORD`、`RW_S3_ACCESS_KEY_ID`、`RW_S3_SECRET_ACCESS_KEY` 与 `RW_SECRET_KEY`。Compose 用这几项拼出上面的变量；票据 11 之前生成的 `.env` 没有 `RW_SECRET_KEY`，再运行一次 `up.mjs` 会补上。

## 进程与命令

一个镜像，按命令区分：`node service/dist/main.js <命令>`。

| 命令 | 作用 |
|---|---|
| `setup` | 部署步骤：用属主账号执行数据库迁移，让应用账号能登录并设置密码，再建桶。运行时的服务只用读、写、取头信息、列举 |
| `api` | 等迁移与代码一致，再启动接口进程；启动时与之后定期对账，退回崩溃后遗留的预占（见[计量与额度](#计量与额度)）；投递 webhook（见 [webhook](#webhook)）；定期清理预览与重放的任务行（见[渲染 worker](#渲染-worker)） |
| `worker` | 等迁移与代码一致，再启动渲染 worker：调度进程领取任务，交给渲染子进程；收到停止信号时排空（见[渲染 worker](#渲染-worker)） |
| `platform-admin <邮箱>` | 建平台管理员账号，随机初始密码只显示一次；操作记审计 |
| `build-id` | 输出渲染器构建标识 |

**健康检查**：接口进程与 worker 都有两个端点。

- `GET /healthz`：存活，返回服务名与构建标识；worker 另带渲染器的计数（`renderer`：已做的任务、超时、内存超限、崩溃、取消时结束的项、子进程换新的次数，`renderMs` 是各项渲染用时之和、`maxRenderMs` 是最慢的一项，毫秒）。
- `GET /readyz`：就绪。要求数据库可连、迁移与代码一致、对象存储可列举；否则返回 503，并列出没通过的检查项与原因，不带连接串或凭据。
- **队列积压**（M303）：worker 就绪时 `/readyz` 另带 `queue`（跨租户，只有计数）：`queued` 与 `running` 按种类（`preview`、`batchItem`、`replay`）给任务数，`oldestQueuedMs` 是排队最久的一项已经等了多久。积压查不出来时不带它，就绪与否不受影响。接口进程的 `/readyz` 对外公开，不带积压；接口进程与对账同一个间隔，队列不空时记一行日志"队列积压"，worker 全停时看这行。逐项的渲染用时在 worker 的日志里，每项一行，`ms` 字段。

**日志**：每行一个 JSON 对象，带时间、级别、服务名（`api`、`worker`、`setup`）与构建标识。请求体不进日志；请求头里的凭据会被遮盖。

## 账号与鉴权

五种身份（M247）。每个请求用 `Authorization: Bearer <令牌>`（M261）：

| 身份 | 怎么得到令牌 | 能做什么 |
|---|---|---|
| 客户操作员 | 邮箱加密码登录 `POST /v1/sessions`，会话 12 小时 | 本租户的数据集、上传新资源、预览、交付、查记录，看本期用量的合计（M300） |
| 客户管理员 | 同上 | 操作员的全部，另管成员与角色、API 密钥、webhook，替换已有资源，看用量明细与审计 |
| API 密钥 | 客户管理员创建，只显示一次 | 操作员的全部加 webhook 管理；不能管成员与密钥，也不能替换已有资源 |
| 代建工程师 | 平台管理员签发代建令牌，指定租户，缺省 30 天 | 只对被指定的租户读取、推送与预览 |
| 平台管理员 | 邮箱加密码登录 | 租户、成员账号与重置密码、代建令牌、套餐 |

- **密码**：用 scrypt 慢哈希保存，参数随哈希保存。初始密码与重置后的密码随机生成，只在响应里出现一次。
- **登录失败**：不区分邮箱不存在与密码错误，邮箱不存在时也算一次哈希。
- **不做的事**：自助注册、第三方登录与邮件找回；密码由平台管理员重置。
- **令牌**：会话、API 密钥与代建令牌都是带前缀的随机串（`rws_`、`rwk_`、`rwa_`），服务端只存 SHA-256。
- **立即失效**：
  - 登出、过期、吊销后，令牌立即失效；
  - 停用成员与重置密码都会吊销该成员的全部会话，重新启用后旧会话也不恢复。
- **至少一个管理员**：租户至少保留一个启用的管理员，最后一个管理员不能降级或停用。

| 端点 | 访问要求 |
|---|---|
| `POST /v1/sessions` | 公开 |
| `DELETE /v1/sessions/current`、`GET /v1/me` | 持有会话；任何身份 |
| `GET`、`POST /v1/platform/tenants` | 平台管理员；建租户时可以一并设套餐 |
| `GET`、`PUT /v1/platform/tenants/{租户}/plan`，`GET …/{租户}/usage`、`GET …/{租户}/usage/events` | 平台管理员；见[计量与额度](#计量与额度) |
| `GET`、`POST /v1/platform/tenants/{租户}/members`，`POST …/members/{成员}/password-reset` | 平台管理员 |
| `GET`、`POST /v1/platform/authoring-tokens`，`DELETE …/{令牌}` | 平台管理员 |
| `GET /v1/tenant` | 管理员、操作员、API 密钥 |
| `GET /v1/members`，`PATCH /v1/members/{成员}` | 客户管理员 |
| `GET`、`POST /v1/api-keys`，`DELETE /v1/api-keys/{密钥}` | 客户管理员 |
| `GET /v1/audit-events` | 客户管理员；按时间倒序，`limit` 最多 500，`before` 翻页 |
| `GET /v1/authoring/tenants/{租户}` | 代建工程师，只认被指定的租户 |
| `GET …/authoring/tenants/{租户}/workspace`、`GET …/contents/{哈希}` | 代建工程师；推送的读回，见[代建推送](#代建推送) |
| `POST …/push-plans`、`PUT …/contents/{哈希}`、`POST …/pushes`、`POST …/template-current` | 代建工程师；推送与改当前修订 |
| `GET /v1/templates`、`GET /v1/templates/{模板名}` | 管理员、操作员、API 密钥；见[模板与草稿预览](#模板与草稿预览) |
| `POST /v1/previews` | 管理员、操作员、API 密钥 |
| `POST /v1/authoring/tenants/{租户}/previews` | 代建工程师，用被指定租户的身份预览 |
| `POST /v1/batches`、`POST /v1/batches/{批次}/cancel` | 管理员、操作员、API 密钥；见[批量交付](#批量交付) |
| `GET /v1/batches/{批次}` | 管理员、操作员、API 密钥 |
| `GET /v1/datasets`、`GET /v1/datasets/{数据集}`、`GET /v1/resources`、`GET /v1/resources/{资源}`、`GET …/{资源}/versions/{版本}/content` | 管理员、操作员、API 密钥；见[数据集与资源](#数据集与资源) |
| `POST /v1/datasets`、`PUT /v1/datasets/{数据集}`、`POST …/{数据集}/copies`、`POST /v1/dataset-checks` | 管理员、操作员、API 密钥 |
| `POST /v1/resources` | 管理员、操作员、API 密钥；上传新资源 |
| `POST /v1/resources/{资源}/replacement-checks`、`POST …/replacements` | 客户管理员；替换已有资源 |
| `GET /v1/records`、`GET /v1/batches/{批次}/items/{序号}/files/{文件}`、`GET …/images.zip`、`GET …/export.zip`、`GET …/items/{序号}/export.zip`、`POST …/items/{序号}/replay` | 管理员、操作员、API 密钥；见[出图记录](#出图记录) |
| `GET /v1/platform/builds` | 平台管理员；被记录引用的构建与在线的 worker |
| `GET /v1/usage` | 管理员、操作员、API 密钥；本租户一个周期的用量合计（M300） |
| `GET /v1/usage/events` | 客户管理员；用量明细 |

**错误**一律是 `{ "problems": [...] }`，格式与引擎的问题一致：

| 状态 | 问题码 |
|---|---|
| 400 | `request.invalid`（位置写到出错的字段）、`push.contentMissing`、`push.contentMismatch`、`resource.replacementInvalid`；批量交付整批拒绝、数据集校验不过时是引擎的问题清单（如 `input.templateNotFound`、`dataset.requiredMissing`） |
| 401 | `auth.required`、`auth.invalidCredentials` |
| 403 | `auth.forbidden` |
| 404 | `request.notFound` |
| 409 | `member.emailTaken`、`member.lastAdmin`、`push.conflict`、`batch.idempotencyConflict`、`input.duplicate`、`resource.replacementStale`；替换检查遇到工作区本身有严重问题时是引擎的问题清单 |
| 413 | `limit.requestTooLarge`、`limit.datasetTooLarge`、`limit.pixelsExceeded`、`limit.expansionExceeded` |
| 415 | `request.invalid`：上传内容不是 `application/octet-stream`，或数据集不是 `application/json` |
| 429 | `quota.exceeded`：本月额度不够这一批，整批拒绝；`preview.rateLimited`、`replay.rateLimited` |
| 500 | `record.integrityMismatch`：读出的文件与登记的 SHA-256 或字节数不符；其他是 `service.internalError` |
| 503 | `worker.unavailable`：等不到 worker 渲染完；`replay.buildUnavailable`：记录所属的构建没有在线的 worker |

JSON 请求体里超过 15 位有效数字的数值按双精度读取会失真，答 400 `request.invalid`，与命令行一致（M112）。写数据集的端点例外：请求体原文交给引擎，按原文报 `dataset.tooManyDigits`。

客户端点的租户由身份决定，路径里没有租户 ID。

## 租户隔离

两道防线（ADR-0018、M262）：

1. **应用层**：鉴权之后只拿到本租户的句柄，对象键与查询条件都由句柄生成，客户端不能提交键或路径。对象不在本租户时，与不存在同样答 404，不泄露对象是否存在。
2. **数据库**：每张带 `tenant_id` 的表都开了行级安全。
   - **账号**：接口进程与 worker 用应用账号 `renderweave_app` 连库，它不是超级用户，也不是表的属主。
   - **当前租户**：每个事务设置当前租户。漏写租户条件的查询只返回当前租户的行，没设置时什么也查不到。
   - **平台模式**：只对账号、会话、审计、租户与代建令牌有效，对文档、资源、批次与密钥无效。
   - **跨租户查找**：按邮箱登录、按令牌解析身份，由属主身份执行的两个函数完成。
   - **权限**：应用账号不能改表结构；审计与用量事件只能追加。

**跨租户端点清单**在 `service/test/cross-tenant-endpoints.ts`。用例对清单里的每个端点，用另一租户的会话、API 密钥与代建令牌访问：

- 带对象 ID 的，回答必须与访问随机 ID 完全相同；
- 不带对象 ID 的，回答里不能出现另一租户的 ID。

用例还核对已注册的路由：能触及租户数据的端点漏列时，测试失败。后续票据新增端点时要加进这张清单。

## 审计

写操作与跨租户操作都追加写入审计：

- **记录内容**：人、租户、操作、对象与时间，不记业务数据内容、密码与令牌。
- **跨租户标记**：平台管理员与代建工程师对客户租户的操作标为跨租户，记进目标租户的审计，客户管理员能看到。
- **不属于任何租户的事件**：例如建平台用户、签发代建令牌，记在平台级。
- **代建写入另记内容**（ADR-0022、M347，P1 票据 03，迁移 0010）：可选字段 `beforeSha256`、`afterSha256`（一份对象写入前后的内容哈希）、`diff`（差异摘要）、`round` 与 `reason`（轮次与理由，给 P2 的 Agent 用，本期留空）。别的事件与迁移之前的旧行没有这些字段。
  - **差异摘要**：增删改计数是全部的，`paths` 至多 50 项，每项是路径（`种类:键` 或 `resource:资源ID`）、改动与前后内容哈希；计数之和大于项数就说明没列全。
  - **推送提交**（`push.commit`）：改动的每份文档与资源各一项，模板的前是推送前的当前修订，资源的前是推送前的当前内容版本；事件本身不填前后哈希，一次推送改的是多份对象。
  - **指回旧修订**（`template.setCurrent`）：前后哈希是改前、改后两个当前修订的内容，差异摘要是这个模板一项；指向内容相同的修订时差异为空。
- **查询与导出**：`GET /v1/audit-events` 按时间倒序翻页，可按主体种类（`actorKind`：`member`、`apiKey`、`authoringToken`、`platformUser`、`system`）与时间（`from` 含、`to` 不含）筛选。`GET /v1/audit-events/export.csv` 按同样的筛选导出 CSV：列名同接口字段，`diffPaths` 是 JSON；UTF-8 带 BOM、CRLF 换行；以 `=`、`+`、`-`、`@` 开头的格子前加单引号，防 Excel 当公式执行。一次至多 10,000 条，超出答 400，要缩小时间范围分次导出。只有客户管理员能看与导出（`audit.read`），导出不记审计。

## 代建推送

代建工程师照[代建指南](agent-guide.md)在本机做好数据定义、模板与资源后，用一条命令推送到客户的租户（ADR-0017、M264）：

```bash
renderweave push --server http://127.0.0.1:8080 --tenant <租户ID> --workspace <工作区> --resources <资源版本仓库> [--rounds <轮次目录>] [--dry-run]
```

- **令牌**：代建令牌只经环境变量传入，缺省 `RENDERWEAVE_AUTHORING_TOKEN`，可用 `--token-env` 换名；不写进参数、日志与输出。令牌只能推送到被指定的租户，别的租户与不存在的租户同样答 404。
- **推送什么**：
  - 工作区里的静态数据定义、编译产物、模板与样例数据集，按原始字节；其他 JSON（如渲染请求）不推送，列在输出的 `skipped` 里；
  - 资源版本仓库里的全部资源及其全部内容版本。
- **推送前先检查本地**：工作区有严重问题（如模板重名、无法解析）时不推送；资源目录还不是版本仓库或是旧版目录时，问题说明与 `resources-list` 等命令一致（M239）。
- **代建的 token**（M275）：`--rounds` 给这一单的轮次目录（`agent run --out` 的目录，有 `round.json`），或它下面一层的各轮目录。各轮 `round.json` 里的输入、输出、缓存读、缓存写 token 随清单交给服务，与推送同一事务记为该租户的用量事件，只记不拦；同一轮（`round.json` 字节相同）只记一次。只看差异、有冲突被拒绝时不记。`round.json` 读不到或不是 `renderweave-round/1` 时本地就报问题，不推送。
- **输出**：标准错误流逐条列出新增、更新与冲突，标准输出是 JSON 汇总（`summary`、逐项的 `documents` 与 `resources`；附了轮次时另有 `usage`：附了几轮、新记几轮与新记的 token 合计）。退出码 0 已推送（`--dry-run` 时为没有冲突）；1 有冲突、本地有严重问题、连不上服务或请求被拒绝；2 用法错误或缺少令牌。

**差异与冲突**由服务按它的当前状态判定（M264）：

| 内容 | 身份 | 新增 | 更新 | 冲突 |
|---|---|---|---|---|
| 静态数据定义、编译产物 | 名称@版本 | 服务端没有 | 不会有 | 服务端已有而字节不同（ADR-0008） |
| 数据集 | 数据集 ID | 服务端没有 | 不会有 | 服务端已有而字节不同：推送不覆盖租户里的数据集 |
| 模板 | 模板名 | 服务端没有 | 与当前修订的字节不同，记一个新修订 | 不会有 |
| 资源 | 资源 ID | 服务端没有 | 本地多出内容版本，追加 | 种类不同，或两边都有的内容版本字节不同 |

- 字节相同是"不变"。服务端的资源已有更新的内容版本、本地落后时也是"不变"，不覆盖。
- 推送只新增与更新，不删除服务端已有的内容。
- 有冲突就整体拒绝，服务端保持原样；没有冲突就在一个事务里提交。

**模板修订**（M265）：模板每次推送改了内容就记一个新修订，修订号逐个递增，旧修订保留。模板按名称指向当前修订，渲染读到的是当前修订。可以把当前修订指回旧修订，之后再推送，就相对当前修订比较：

```bash
renderweave template-revisions --server … --tenant <租户ID> --template <模板名> [--current <修订号>]
```

**协议**：命令行先把清单（每份文档与每个资源内容版本的身份、SHA-256 与字节数）交给 `POST …/push-plans` 算差异，返回差异与服务端还缺的内容；`--dry-run` 到此为止，不写任何东西。没有冲突时，按 `PUT …/contents/{哈希}` 上传缺的内容（单份最大 64 MiB），再 `POST …/pushes` 提交。提交时：

- 锁住租户的一行，与资源提交、改当前修订依次进行；
- 按最新状态重算差异：有冲突答 409 `push.conflict`，附差异；
- 核对要写入的内容都已上传，字节数相符；文档的种类与键按内容核对，不信声明：不符答 400 `push.contentMissing` 或 `push.contentMismatch`。

有冲突时命令行不上传内容，仍提交一次，由服务拒绝并记审计。

**读回**：`GET …/workspace` 列出租户的文档（模板为当前修订）、模板的全部修订与资源的全部内容版本；`GET …/contents/{哈希}` 按 SHA-256 读回已登记的原始字节，只上传、没登记的内容答 404。

**审计**：代建端点的每次调用都记进目标租户的审计，标为跨租户：`authoring.access`、`authoring.read`、`content.read`、`content.upload`、`push.plan`、`push.commit`、`push.reject`、`template.setCurrent`。`push.commit` 与 `template.setCurrent` 另记前后内容哈希与差异摘要，见[审计](#审计)。

## 模板与草稿预览

**模板**（M267）：`GET /v1/templates` 列出本租户的模板，`GET /v1/templates/{模板名}` 看一个。每项有名称、当前修订、所用的数据定义（`base`）、适用尺寸范围与对外参数（名称、显示名称、类型、约束与缺省值）；内部参数不列。读不了的模板只有问题清单。

**草稿预览**：`POST /v1/previews` 的请求体就是渲染请求（模板、数据集、对外参数与出图参数），不写 `mode` 或写 `draft`；写 `final` 答 400，正式图只走批量交付。回答与引擎的 `render` 相同：

```json
{ "image": { "format": "png", "widthPx": 756, "heightPx": 189, "dpi": 120, "base64": "…" }, "problems": [], "layout": { … } }
```

- **同步**：接口进程入队后等 worker 渲染完再回答，最多等 60 秒；等不到答 503 `worker.unavailable`，还在排队的任务撤回。
- **不入队就能答的**：请求无法展开（模板或数据集不存在、请求不合法等）时，接口进程直接答与单次渲染相同的问题清单，没有图片。
- **worker 没能渲染完**：回答仍是 200，没有图片，问题清单写明原因：`worker.timeout`（超过单项时限）、`worker.memoryExceeded`（超出内存上限）、`worker.crashed`（子进程意外退出）或 `worker.failed`（读不到存储等）。
- **不计额度**；按租户限制：同时排队与渲染中的预览数不超过套餐的并发数（缺省 2），一分钟内最多入队 60 次（撤回的也算），超过答 429 `preview.rateLimited`。入队超过等待时长的任务不再占并发，worker 中途退出时不会一直卡住。
- **代建工程师**用 `POST /v1/authoring/tenants/{租户}/previews`，以被指定租户的身份预览，同一套检查与限制，记审计 `authoring.preview`。

**入队前的限制**（ADR-0017）：接口进程用引擎的 `measureRender` 量出像素与展开规模，不出图；超限答 413，不占 worker。

| 限制 | 缺省 | 问题码 |
|---|---|---|
| 请求体字节数（内联的数据集算在里面） | 1 MiB | `limit.requestTooLarge` |
| 引用的已保存数据集的字节数 | 1 MiB | `limit.datasetTooLarge` |
| 单张图的像素总数 | 套餐的单张最大像素（缺省 1 亿，不超过引擎上限） | `limit.pixelsExceeded` |
| 展开后会显示的元素数 | 20,000 | `limit.expansionExceeded` |
| 展开后的循环项数（嵌套逐层累计） | 2,000 | `limit.expansionExceeded` |

这些数值经容量基线核对后不变（M302，见[容量基线](#容量基线)）。

## 批量交付

正式图只走批量交付：单张也是一项的批次，所以每张正式图都有出图记录（M246、M268）。

**提交**：`POST /v1/batches` 的请求体与本地 `renderweave deliver` 的批量请求相同：根模板与 `items`（1–1,000 项，每项带唯一 `id`、数据集、对外参数与出图参数）。不写 `mode` 或写 `final`；写 `draft` 答 400，草稿走预览。

- **整批拒绝**：接口进程按本地的语义固定批次（M153）。外层非法、根模板无法准备时整批拒绝，答 400 与本地交付相同的问题清单，不建批次。
- **预占额度**（M274）：建批次时预占本批项数，额度不够整批拒绝，答 429 `quota.exceeded`，不建批次；见[计量与额度](#计量与额度)。
- **入队**：固定好的批次快照存成本租户的内容，各项入队，立即答 202 与批次。
- **单项的限制**：入队前逐项检查像素、展开规模与已保存数据集的字节数（数值同[预览](#模板与草稿预览)）。超限的项不渲染，直接失败，问题码与预览相同，位置写到 `request.items.{从 0 起的序号}`；其他项照常。请求体超过 8 MiB 整批答 413。
- **幂等**：请求头 `Idempotency-Key`，1–200 个可见字符。同一租户内同一个键再提交同样的请求，答 200 与同一批次，不重复交付、不重复预占与计费，额度用完后也一样；请求不同答 409 `batch.idempotencyConflict`。

**查询**：`GET /v1/batches/{批次}`。

```json
{ "id": "…", "template": "问候牌", "mode": "final", "build": "sha256:…", "status": "running", "cancelRequested": false,
  "createdAt": "…", "progress": { "completed": 1, "total": 3 },
  "summary": { "total": 3, "delivered": 1, "previewed": 0, "failed": 0, "notRun": 0, "severe": 0, "hints": 0 },
  "items": [
    { "index": 1, "id": "a", "status": "delivered", "files": { "image": "image.png", "problems": "problems.json", "layout": "layout.json", "record": "record.json" }, "severe": 0, "hints": 0, "problems": [] },
    { "index": 2, "id": "b", "status": "running" },
    { "index": 3, "id": "c", "status": "queued" } ],
  "problems": [] }
```

- `status` 是 `running`（还有项没结束）或 `finished`（全部项结束，批次清单已发布）。
- 结束后另有 `outcome`（M276）：
  - `completed`：全部交付；
  - `partiallyFailed`：部分失败；
  - `failed`：全部失败；
  - `cancelled`：请求过取消。

  它与 webhook 事件里的相同。
- 每项先是 `queued`、`running`，结束后是 `delivered`、`failed` 或 `notRun`，带问题清单。失败项的问题清单与单次渲染相同（票据 02）；worker 没渲染完的项写 `worker.timeout`、`worker.memoryExceeded` 等，并写出问题清单文件。
- 批次清单（`batch.json`）在最后一项结束时发布，语义与字节都与本地 `deliver` 的相同；结束后的 `summary` 与 `problems` 取自它。

**取消**：`POST /v1/batches/{批次}/cancel`。

- 还在排队的项立即标为未执行；
- 正在渲染的一项由 worker 结束，也标为未执行；
- 已交付的保留；
- 批次清单带批次级问题 `delivery.cancelled`；
- 已结束的批次再取消不改变什么。

本地只能在项与项之间取消，服务端能结束正在渲染的一项（ADR-0017）。

**交付与记录**（ADR-0019）：

- **提交点**：渲染子进程按批次快照交付一项，先把文件按 SHA-256 写进对象存储，再在一个事务里登记这一项，并在同一个事务里结算额度（ADR-0020）。"批次加项序号"唯一；登记之前，这一项对任何读者都不存在。
- **去重**：同一租户内相同字节只存一份，跨批次也是；同样的批次再交一次，对象存储里不多一个对象。
- **记录**：内容与本地 `deliver` 的相同，能用引擎的 `replayRecord` 重放；查询、下载、导出与重放见[出图记录](#出图记录)。

**审计**：`batch.create`、`batch.cancel`。

## 数据集与资源

**数据集**（M270）：

| 端点 | 说明 |
|---|---|
| `GET /v1/datasets` | 按 ID 排列：ID、名称、所选的静态数据定义、SHA-256 与字节数 |
| `GET /v1/datasets/{数据集}` | 读回保存时的原始字节（`application/json`） |
| `POST /v1/datasets` | 新建；请求体就是数据集文档，要写 `dataset.id`；已有答 409 `input.duplicate` |
| `PUT /v1/datasets/{数据集}` | 整份替换；正文的 `dataset.id` 要与路径一致，不存在答 404 |
| `POST /v1/datasets/{数据集}/copies` | 复制：`{ "id": "新 ID", "name": "可选的新名称" }`，答 201 |
| `POST /v1/dataset-checks` | 只校验、不保存，供表单实时提示；不要求 `dataset.id`；答 200 与 `{ "problems": [...] }` |
| `GET /v1/static-schemas` | 本租户的静态数据定义：名称、版本、显示名称与说明（M278）；引擎内置的与没有编译产物的不列 |
| `GET /v1/static-schemas/{名称}/versions/{版本}` | 一个静态数据定义的原文与编译产物；表单按编译产物生成 |
| `GET /v1/static-schemas/{名称}/versions/{版本}/workbook` | Excel 导入的空白表（M285），见下文[Excel 导入](#excel-导入) |

- **按原始字节存**：写数据集的请求体不经 JSON 解析就交给引擎，存的就是原文，读回逐字节相同。超过 15 位有效数字的数值按原文报 `dataset.tooManyDigits`（M112）。
- **保存时校验**：引擎的 `checkDataset` 按所选静态数据定义的编译产物与本租户的资源校验，与渲染时对同一数据集的检查是同一段代码，字段问题定位到字段路径（如 `stops[4].landmark`）。有严重问题答 400 与问题清单，什么也不存；只有提示时照常保存，回答里带上提示。保存成功的回答是 `{ "dataset": { id, name, staticSchema, sha256, byteLength }, "problems": [...] }`。
- **ID**：经接口保存的数据集 ID 有 1–200 个字符，不能有控制字符，首尾不能是空白；推送进来的数据集沿用本地的 ID。路径里的中文 ID 按 URL 编码写。
- **复制**：副本只改身份部分的 ID 与名称，重新写成缩进 2 格的 JSON；先按原件校验，原件有严重问题时不复制。
- **上限**：请求体不超过已保存数据集的字节上限（缺省 1 MiB，与预览的 `limit.datasetTooLarge` 同一个值），超过答 413 `limit.requestTooLarge`。
- **与推送的关系**：保存数据集与推送、资源提交锁住同一行，依次进行。客户改过的数据集，代建工程师再推送本地的旧内容时是冲突，整体拒绝（M264）。
- **没做**：删除（v1.0 不删）；并发修改的版本条件，后写的覆盖先写的。
- **审计**：`dataset.create`、`dataset.update`、`dataset.copy`，只记数据集 ID，不记内容。

**资源**（M271）：

| 端点 | 说明 |
|---|---|
| `GET /v1/resources`、`GET /v1/resources/{资源}` | 资源 ID、种类、当前版本与全部内容版本（版本号、SHA-256、字节数） |
| `GET /v1/resources/{资源}/versions/{版本}/content` | 读回一个内容版本的原始字节，经引擎按登记的哈希核对；一律 `application/octet-stream` 加 `nosniff` |
| `POST /v1/resources?kind=image\|font&id=资源ID` | 上传新资源，请求体是 `application/octet-stream`，最大 64 MiB；不写 `id` 时由服务生成（如 `image-1a2b3c4d5e6f`）。答 201 与 v1 的元信息 |
| `POST /v1/resources/{资源}/replacement-checks` | 替换检查（客户管理员），请求体是候选内容 |
| `POST /v1/resources/{资源}/replacements` | 应用替换（客户管理员），请求体是 `{ "check": 检查报告 }` |

- **新资源**：资源 ID 的写法与资源引用 `res:资源ID` 相同。同一 ID 已有答 409 `input.duplicate`，换种类也一样，ID 与种类创建后不变。字体不做授权确认（M241）。内容按原始字节存，能不能用于绘制由渲染器在预览里报告，与本地资源仓库相同。上传的图片随即可以写进数据集的图片字段，保存时核对资源存在、是图片。
- **替换检查**（M152）：只读，不改资源。候选内容先存成本租户还没登记的内容，返回检查报告：

```json
{ "check": {
    "resource": { "id": "landmark-2", "kind": "image", "version": 1, "sha256": "…", "byteLength": 5120 },
    "replacement": { "sha256": "…", "byteLength": 1266 },
    "impact": { "workspaceFingerprint": "…", "renderOptions": { "fallbackFonts": ["font-hei-regular", "…"], "svgFonts": ["…"] },
      "references": [{ "kind": "datasetImage", "document": "ds-m402-wanguocheng", "source": "dataset:ds-m402-wanguocheng", "path": "/data/stops/3/landmark" }],
      "configuration": [], "scope": "…" } },
  "problems": [] }
```

  - 影响由引擎的 `resourceImpact` 算，与本地 `resources-check` 对同一工作区的结果相同：模板（当前修订）与数据集里的直接引用（JSON Pointer，含隐藏元素与所有状态分支），以及字体配置。服务用引擎的缺省后备字体，替换其中的字体时列在 `configuration` 里。
  - 工作区本身有严重问题、或数据集缺少编译产物时检查不了，答 409 与问题清单。
- **应用替换**：
  - 按报告里的资源版本、哈希与字节数提交，得到下一个内容版本，旧版本的内容保留；
  - 工作区指纹（全部文档的来源、哈希与字节数，加字体配置）在资源提交的同一个事务、同一把锁里核对。检查之后资源已有新版本、或模板与数据集变了，答 409 `resource.replacementStale`，资源不变；
  - 报告不属于路径里的资源、种类不符、候选内容不在服务端，答 400 `resource.replacementInvalid`；
  - 同一份报告只能用一次，同时应用两次也只有一次成功。
- **审计**：`resource.upload`、`resource.replace`，只记资源 ID；检查是只读的，不记。

## 出图记录

出图记录是正式交付成功、已登记的项（ADR-0019，M272、M273）。

**查询**：`GET /v1/records`，按登记时间倒序。

| 参数 | 说明 |
|---|---|
| `batchId` | 只看这个批次 |
| `template` | 只看这个根模板 |
| `from`、`to` | 登记时间，ISO 8601 带时区；`from` 含、`to` 不含 |
| `limit` | 1–500，缺省 100 |
| `before` | 上一页回答里的 `next`，原样带回 |

```json
{ "records": [{ "batchId": "…", "index": 1, "id": "m402-01", "template": "标准线路单边", "build": "sha256:…", "deliveredAt": "…", "image": "image.png" }], "next": "…" }
```

**下载**：

- `GET /v1/batches/{批次}/items/{序号}/files/{文件}`：一项登记的任一文件（`image.png`、`record.json`、资源副本等）。图片按图片类型、JSON 按 JSON、其他按字节回答，一律带 `nosniff`；失败项只有 `problems.json`。
- `GET /v1/batches/{批次}/images.zip`：交付成功各项的图片，名字是项目录名加扩展名，如 `0001.png`。项标识只作数据，不进文件名，与本地一致。

**导出**：

- `GET /v1/batches/{批次}/export.zip`：解开是 `batch-{批次}/`，与本地 `deliver` 的批次目录逐字节相同：批次清单发布了就有 `batch.json`，各项目录（`0001/` 等）里是登记的全部文件。能直接交给 `renderweave batch-read`、`record-read` 与 `replay`。
- `GET /v1/batches/{批次}/items/{序号}/export.zip`：解开是 `batch-{批次}-{项目录}/`，一项的目录，能直接交给 `record-read` 与 `replay`。
- 离线重放要用产出记录的确切构建（ADR-0013）：服务交出的记录，用同一构建的引擎才能重放。

**完整性**：下载与导出时，每个文件都按登记的 SHA-256 与字节数核对，不符答 500 `record.integrityMismatch`，位置写到文件。zip 先写进临时文件，每个文件写进去之前核对，全部写完才回答，所以损坏时回答的是问题清单，不是半个压缩包。文件按需读取，一大批图片不会同时留在内存里；超过 4 GiB 时用 ZIP64。

**重放**：`POST /v1/batches/{批次}/items/{序号}/replay`，同步回答：

```json
{ "batchId": "…", "index": 1, "id": "m402-01", "build": "sha256:…", "matched": true,
  "replay": { "format": "renderweave-replay/1", "build": "sha256:…", "itemId": "m402-01", "matched": true, "files": [ … ] }, "problems": [] }
```

- **按构建路由**：重放交给记录里的构建的 worker，引擎从记录本身重新渲染、与记录比对。重放成了 `matched` 为真；记录被改坏、或重新渲染与记录不一致时为假，问题清单写明原因（`record.integrityMismatch`、`record.replayMismatch`）。
- **构建不在时拒绝**：worker 每 5 秒报到自己的构建，停止时离开，30 秒内报到过的算作在线。记录里的构建没有在线的 worker 时答 503 `replay.buildUnavailable`，说明写明缺哪个构建与它的镜像标签；起那个构建的 worker 见[构建标识与镜像](#构建标识与镜像)。
- **限制**：不计额度；按租户限并发（套餐的并发数）与频率，数值同预览、与预览各算各的，超过答 429 `replay.rateLimited`；等不到结果答 503 `worker.unavailable`。
- 只有交付成功的项能重放，失败项与不存在的项答 404。

查询、下载、导出与重放都是只读的，不记审计。

## 计量与额度

按月额度计量正式交付的张数与代建的 token（M242、ADR-0020、M274、M275）。

**套餐**由平台管理员设置，不接在线支付：

| 项 | 取值 | 作用 |
|---|---|---|
| `monthlyImages` | 0–10 亿 | 每月可正式交付的张数 |
| `maxPixels` | 1–1 亿 | 单张最大像素，预览与批次项入队前检查（ADR-0017） |
| `concurrency` | 1–64 | 预览与重放同时排队与渲染中的任务数，按种类各算各的；批次项不按租户限并发，按项序号轮转（M269） |

- `POST /v1/platform/tenants` 可以带 `plan` 一并设；不设就是缺省套餐：每月 0 张、1 亿像素、并发 2，正式交付前要先设。
- `PUT /v1/platform/tenants/{租户}/plan` 整份设置，三项都要写；当期计数的限额随之改变，以后的周期按新套餐。
- 设置与读取都记进该租户的审计，标为跨租户（`plan.update`、`plan.read`、`usage.read`）。

**计费周期**是按 UTC+8 切分的自然月，写作 `YYYY-MM`，不结转。

**计什么**：

| 用量 | 计入 | 说明 |
|---|---|---|
| 正式交付成功的一项 | 1 张 | 记一条用量事件（批次与项序号） |
| 失败项、未执行的项 | 不计 | 退回预占 |
| 草稿预览、记录重放 | 不计 | 只限并发与频率 |
| 代建的 token | 只记不拦 | 推送时随附，按输入、输出、缓存读、缓存写各记一条（轮次的 `round.json` 哈希、任务与轮次） |

**批量交付先预占，再逐项结算**：

1. **提交**：在一个事务里锁住当期计数行，"已用 + 预占 + 本批项数"超过限额就整批拒绝，答 429 `quota.exceeded`，说明里写限额、已用、预占、剩余与本批项数，响应另带 `quota` 对象；不做"能交几项交几项"。够就预占本批项数，记在批次上。批次的周期按接受它的时间定，结算都记在这个周期，跨过月底才交付完的也是。
2. **每项成功**：与登记这一项同一个事务，已用加 1、预占减 1，记一条用量事件。"批次加项序号"唯一，同一幂等键重试、worker 重领同一项都只计一次。
3. **失败与未执行**：登记失败项时退回 1；没登记就结束的项（取消时还在排队的、被结束的）在写回或取消时退回。
4. **批次结束**：与发布批次清单同一个事务，退回剩下的预占。退回的总数不超过预占的总数。

**对账**：接口进程启动时与之后每 `RW_RECONCILE_MS` 对一次账（跨租户，属主函数 `rw_reconcile_reservations`）。

- **何时退回**：批次已结束还有预占的，全部退回。没结束的，接受它的构建 30 秒内没有 worker 报到、批次在 `RW_RESERVATION_GRACE_MS` 内也没有动静（建批次、领取、写回），视为没人再交付，退回剩余预占，记一行日志（租户、批次与数目）。
- **何时会遗留**：worker 被强杀、滚动发布时旧 worker 没排空就没了。worker 单独崩溃不会遗留，同构建的 worker 过了租约会重领。
- **之后又交付**：那个构建的 worker 回来把批次交付完时，成功的项照样计已用；限额因此最多超出这一批的剩余项数。

**查询**：剩余 = 限额 − 已用 − 预占，不小于 0。

```json
{ "period": "2026-10", "start": "2026-09-30T16:00:00.000Z", "end": "2026-10-31T16:00:00.000Z",
  "plan": { "monthlyImages": 1000, "maxPixels": 100000000, "concurrency": 2 },
  "images": { "limit": 1000, "used": 120, "reserved": 30, "remaining": 850 },
  "tokens": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreationTokens": 0 } }
```

- `GET /v1/usage?period=YYYY-MM`：本租户一个周期的合计，缺省当前周期；`plan` 是当前套餐，`images.limit` 是那个周期的限额。客户管理员、操作员与 API 密钥都能看（M300）：提交批次额度不够时，429 本来就把这些数告诉提交者，操作员要靠它安排出图。
- `GET /v1/usage/events?period&kind&limit&before`：用量事件，只给客户管理员，按 ID 倒序，`kind` 是 `image` 或四种 token 之一，`limit` 1–500，`before` 带上一页的 `next`。
- 平台管理员用 `GET /v1/platform/tenants/{租户}/usage` 与 `…/usage/events` 看任一租户的，回答相同。
- 用量事件只追加，应用账号不能改、不能删。

## 开放 API 描述

给客户开发者的说明在[开放 API](api.md)：鉴权、错误与状态、常用流程、webhook 的接收与校验、1.x 兼容策略与变更记录。这里只写维护时要知道的（M276）。

- **生成**：`GET /v1/openapi.json` 按已注册的路由生成 OpenAPI 3.1 描述，第一次请求时生成一次。
  - 路径、方法与请求的 JSON Schema 取自路由的声明；
  - 说明、回答与错误状态写在 `service/src/api/openapi.ts` 的 `ROUTE_DOCS`；
  - 加端点时要一并写说明，否则生成时报错。
- **错误状态**：每个端点会有的错误状态，由访问要求（401、403）、请求体与查询串（400）、路径里的对象（404）自动列出，再加上说明里列的。问题码与状态的对应在 `PROBLEM_STATUS`。
- **核对**：测试里 `createWorld` 的每个回答都按描述核对（`service/test/openapi-check.ts`）。改了回答的形状却没改描述，用例就失败。
- **快照与基线**：
  - 描述的快照是 `docs/api/openapi.json`，有意改动时用 `npx vitest run -u` 更新；
  - 1.0.0 基线是 `docs/api/openapi-1.0.0.json`，`service/test/openapi-compat.ts` 列出相对它不是加法的改动；
  - 描述变了要升 `API_VERSION`，并在 `docs/api.md` 的变更记录里写一行。
- **DSL 的 Schema**：批次请求、渲染请求与数据集的请求体引用 `schemas/` 里的 JSON Schema，镜像里因此带着 `schemas/`。

## webhook

客户管理员与 API 密钥注册 webhook，批次结束时接口进程把带签名的事件投递过去（M277）。接收端怎样校验见[开放 API](api.md#webhook)。

- **注册**：`POST /v1/webhooks`，回答里的签名密钥只出现这一次。
  - 库里存的是用服务密钥 `RW_SECRET_KEY` 以 AES-256-GCM 加密、绑定租户的密文，列表只给前缀；
  - 各接口进程用同一个服务密钥。它丢了，已有的 webhook 只能重新注册。
- **URL 检查**：只收 https 与公网地址，`RW_WEBHOOK_ALLOW_PRIVATE=true` 时放开。每个租户最多同时启用 10 个。
- **事件**：批次结束时，在发布批次清单的同一个事务里记一个 `batch.finished` 事件，并给当时启用、订阅了它的每个 webhook 各记一条投递。没有这样的 webhook 就不记。
- **投递任务**：在接口进程里，与对账任务并列。
  - 每 `RW_WEBHOOK_POLL_MS` 用属主函数 `rw_claim_webhook_deliveries` 领取到期的投递（跨租户，`FOR NO KEY UPDATE SKIP LOCKED`，带租约），并行发送；
  - 连接前再查解析出的地址，指向本机、内网或保留地址的不投；
  - 2xx 算成功，其余按 `RW_WEBHOOK_RETRY_BASE_MS` 起翻倍退避，试满 `RW_WEBHOOK_MAX_ATTEMPTS` 次记失败。每次尝试记一行，只记时间、耗时与状态码或原因；
  - 多个接口进程同时投递时，一条投递只被一个领走；投递任务中途退出，租约过了别人再领。
- **日志**：投递失败时记一行警告：租户、webhook、投递、第几次与原因，不记 URL、正文与密钥。
- **表**：`webhooks`、`webhook_events`、`webhook_deliveries`、`webhook_attempts`，都开行级安全。事件与尝试只追加，webhook 只能停用、不能删。
- **审计**：`webhook.create`、`webhook.update`。

## 出图控制台

客户的管理员与操作员用的网页（M248、M279）。它是开放 API 的客户端，没有自己的后端接口；接口进程把构建好的文件放在 `/console/` 下提供。页面结构按原型方案一（M282），一次性原型存档在分支 `prototype/console-v1`；框架与视觉在阶段 5 P1 换成桌面工作台原型第 29 版（P1 票据 01，M208、M341），原型存档在分支 `prototype/desktop-workbench`。

- **框架**（`service/console/src/frame.tsx`，模块与动作的清单在 `modules.ts`）：
  - 标题栏：品牌、"模块与动作"（`Ctrl+K`）、模块下拉、账号与退出。模块是数据定义、模板、数据集、出图、资源、用量、管理，按角色只列能进的（管理只给客户管理员），`Ctrl+1`… 按列出的顺序切换；
  - `Ctrl+K` 只列模块与常用动作（新建数据集、从 Excel 导入、上传资源；客户管理员另有管理成员、创建 API 密钥、查看审计日志），输入几个字筛选，不搜数据集、模板这类对象；
  - 状态栏：连接状态（最近一次请求连没连上）、当前租户（`GET /v1/tenant`）、本月剩余张数、本标签页进行中的批次。开放 API 没有列出批次的端点，进行中的批次只数本标签页提交过的；
  - 左栏留给 Agent（P2），现在不显示；窄窗口下模块占满宽度，宽表格在自己的分组里横向滚动，页面不横向滚动；
  - 视觉：近白米纸底 `#FDFBF6`，正文 `#22150F`、次要文字 `#5B4334`、弱提示 `#7F6A59`，细线 `#D9C8B0`，强调与主按钮咖啡红 `#8E3B24`；调和橙 `#F17D13` 只用在标志、进度条、选中页签下划线、进行中的圆点这类不承载文字的位置。一页一事，用细分隔线分组，状态用圆点加文字；
  - 各页的 # 路由没有变，旧链接照旧能打开。
- **页面**：
  - **数据集**是首页：列出本租户的数据集，可以勾几份同一数据定义的一起出图。Excel 导入与几份一起出图都是这一页上的侧栏，属于数据集模块。
  - **数据定义**：先只读列出已发布的静态数据定义，每个名称一行，带各版本、用到它的模板与数据集份数；草案、详情与发布记录在 P1 票据 06 做。
  - **编辑一份数据集**：左边是按编译产物生成的表单，字段用显示名称；右边是草稿预览、对外参数与尺寸。
    - 边填边经 `POST /v1/dataset-checks` 校验，问题显示在字段下面；预览的问题定位到元素的，按布局摘要叠加在图上。
    - 顶层简单字段排成网格；对象的列表能放进单元格时排成表格（一行一项，如停靠站点）；简单值的列表是一排小输入框。
    - 图片字段从本租户的资源中选，或上传新图（`POST /v1/resources?kind=image`）。
  - **出图**：侧栏里选模板、对外参数与尺寸，可以按一个整数对外参数的范围出多张，项 ID 写成"数据集/参数=值"。提交带幂等键；提交后侧栏显示逐项进度，点一项看图、下载或看问题说明，能取消；结束后下载整批压缩包。
  - **模板**：只读。缩略预览、适用尺寸范围、数据定义与对外参数；调参看草稿预览，按模板新建数据集。
  - **出图**模块分出图记录与批次两页（下划线页签）。**批次**列出本标签页提交过的出图任务与状态，点开是逐项进度。
  - **出图记录**（M301）：按登记日期、模板与批次查询 `GET /v1/records`，一页 50 条，"加载更多"接着翻。筛选写在 # 路由的查询串里，可以收藏、转发；日期按浏览器的本地时间，起止都含当日（截止日期换成第二天零点作 `to`）。每行能下载图片、导出这一项；按批次筛选时另有导出整批、下载整批图片与打开出图任务。
  - **资源**（M301）：列出图片与字体资源，客户管理员与操作员都能上传新资源。替换只给客户管理员：选新内容 → 检查影响（列出直接引用它的模板与数据集、服务的字体配置）→ 确认替换；报告过期时服务端答 409，页面丢掉报告、要重新检查。
  - **用量**（M300）：一个计费周期的限额、已用、预占与剩余，套餐与代建 token 的合计；可以换周期。用量明细只在客户管理员的页面上，操作员的页面不请求它。
  - **管理**（M301）：只给客户管理员，操作员的模块下拉里没有这一项，直接打开只看到说明、不请求管理端点。分四个标签：
    - 成员与角色：改角色、停用与启用；自己的角色与状态不在这里改；新成员与重置密码由平台管理员办理；
    - API 密钥：创建时密钥显示一次，列表只有开头几位，可以吊销；
    - webhook：注册时签名密钥显示一次，停用与启用，查看投递记录（各次尝试的状态码或原因）；
    - 审计日志：操作人、操作、对象与跨租户标记，一页 50 条；代建写入另显示前后内容哈希（开头 8 位，悬停看全文）与差异摘要（展开看路径与各自的前后哈希）。可按主体种类与日期筛选，筛选结果导出 CSV（P1 票据 03）。
    - 只出现一次的密钥只放在那一块面板的状态里，关掉、换标签或离开就没了，不写进 sessionStorage。
- **出图参数**：缺省取模板适用尺寸的下限、120 DPI、PNG。预览与正式交付用同样的尺寸与分辨率，因为低分辨率的草稿会给条码报假问题（M280）。
- **身份**：只有客户管理员与操作员能用，令牌只放在本标签页的 sessionStorage。状态栏显示本月剩余张数，两种角色都有（M300；票据 12 时只给管理员）。
- **静态文件**：启动时读进内存，只回答构建目录里认识的类型。index.html 不缓存，带内容哈希的文件长期缓存；内容安全策略只许同源的脚本、样式、请求与字体，图片另许 `blob:` 与 `data:`。这些路由不属于开放 API，不在 OpenAPI 描述里。没有构建时 `/console/` 答 404 并说明怎样构建。
- **构建**：源码在 `service/console/`（React 加 Vite），镜像构建时做类型检查并构建到 `service/dist/console`。本机构建在 `service/` 下执行 `npm run build`。
- **本机开发**：先 `node service/scripts/up.mjs` 起服务，再在 `service/` 下执行 `npx vite console`，开放 API 的请求转给 8080。

## Excel 导入

一批数据从 Excel 导入，确认后作为一批正式交付（M248、M283–M286）。写法与问题码见[开放 API](api.md#excel-导入)。

| 端点 | 说明 |
|---|---|
| `GET /v1/static-schemas/{名称}/versions/{版本}/workbook` | 空白表：主表一行表头，引用与引用列表各一张表；文字类的列是文本格式，单值的可选值有下拉选择 |
| `POST /v1/excel-imports` | 导入预览：`{ template, workbook（base64）, parameters?, output }`，答逐行的数据集与问题、整份的问题与批量请求；不保存任何东西 |

- **解析**：`service/src/xlsx.ts` 用 yauzl 在内存里解压，分三遍只解开关系、工作簿、共享字符串与选中的工作表（主表与引用表），按登记的解压大小累计、超限即停，实际字节多于登记的读不了；工作表、共享字符串与关系由本文件的 XML 扫描器读取，不接受 DTD，部件按 BOM 认 UTF-8 或 UTF-16。只取单元格的值，不读样式（M284）。空白表也在这里写出，用 yazl 打包，只写 DOS 时间戳。
- **写法**：`service/src/excel-import.ts` 按编译产物把工作簿换成逐行的数据，记下每个字段路径来自哪个单元格；引擎的问题按字段路径找回单元格，找不到就往上一级找，都没有就是整行（M285）。
- **校验**：每行的数据集由引擎的 `checkDataset` 按租户的工作区校验，与保存数据集时相同；出图参数与对外参数由 `measureRender` 按第一行能提交的数据检查一次。数据集内联在批量请求里，不另存（M283）。
- **上限**：`DEFAULT_LIMITS` 里的 `maxWorkbookBytes`（5 MiB）、`maxWorkbookUnzippedBytes`（32 MiB）、`maxWorkbookCells`（50 万）、`maxImportRows`（1,000）与 `maxImportReferenceRows`（5 万），超出答 413 `limit.workbookTooLarge`（M286）。
- **控制台**：数据集页的"从 Excel 导入…"打开侧栏，选模板、对外参数与尺寸，下载空白表，上传文件；逐行显示能不能提交与问题所在的单元格；提交后转到出图任务的进度页。对外参数与尺寸只写进批量请求，改了不用重新导入。
- **样例**：`fixtures/excel/` 里有两份样例及导入后应得到的数据：`price-tags.xlsx`（商品价签，字段扁平）与 `route-signs.xlsx`（M402 线路牌，停靠站点在另一张表）。它们用 openpyxl 生成（`make-samples.py`），与服务写空白表的代码无关。价签的数据定义与模板在 `fixtures/workspaces/price-tag/`。

## 渲染 worker

一个 worker 容器有一个调度进程和一个渲染子进程，一次只做一项（ADR-0017、M266）：

- **领取**：调度进程用 `rw_claim_task` 领一项（`SELECT … FOR UPDATE SKIP LOCKED`，跨租户，由属主身份执行），队列空时每 100 ms 再看。入队、查结果与写回结果都在租户的事务里，行级安全照常生效。
- **顺序**（M269）：预览与重放优先；批次项按项序号轮转，各批次的第 1 项先于任何批次的第 2 项，小批次不被大批次堵住。
- **构建固定**：批次记下接受它的构建标识，worker 只领本构建的批次项与重放（M273）；预览哪个构建都可以领。
- **报到**：调度进程每 5 秒报到自己的构建（另用定时器，渲染一项期间照样报到，一次接一次），停止时等进行中的报到写完再离开，否则报到晚于离开落库，停下的 worker 会显得在线 30 秒；接口进程据此判断重放的记录所属的构建有没有在线的 worker，对账也据此判断批次还有没有人交付。
- **渲染子进程**：调度进程 fork 它，经 IPC 一次交一项。子进程自己连数据库与对象存储读租户的工作区与资源，启动时先加载 CanvasKit，准备好才接任务；单项时限从交出任务起算。
- **单项超时**：到时调度进程结束子进程，本项答 `worker.timeout`。
- **内存超限**：内存上限是容器的限制（`mem_limit`，不用交换分区）。子进程启动时把自己的 `oom_score_adj` 调到最高，内存不够时内核先结束它；调度进程看本容器 cgroup 的 `memory.events` 里 `oom_kill` 增加了，本项答 `worker.memoryExceeded`。
- **换新**：子进程在任务之间复用；做满 `RW_RENDER_RECYCLE_AFTER` 项、超时、内存超限、取消或崩溃后换一个新的，换下后立即起新的预热。
- **两项之间退出**（M350）：子进程在两项之间退出（被内存上限结束、被外部杀掉或自己崩溃）时，调度进程立即换新预热，下一项照常交给新的子进程。这次退出不属于哪一项，只记一次换新与一条警告日志。交任务时才发现子进程已退出或 IPC 已断开（退出还没传到调度进程），这一项还没交到子进程手里，换新后再交一次；仍交不出去答 `worker.crashed`。子进程的 `error` 事件有常驻的监听，交任务、启动或结束子进程失败都不会让调度进程退出。
- **取消**：渲染批次项时每 200 ms 查看一次批次是否已取消，取消了就结束子进程，本项标为未执行。
- **没渲染完的批次项**：超时、内存超限或崩溃的项写出问题清单文件，标为失败，没有记录；这一项已登记时以登记的为准。
- **租约与重领**：批次项的租约是单项超时加 60 秒。worker 中途退出（例如容器被杀）时，过了租约，同构建的 worker 重领。
  - 重领前先看这一项是否已登记：已登记就沿用，不重渲染，记录只提交一次；
  - 写回以领取次数作凭据，重领之后旧的写回不生效；
  - 领了 3 次仍没做完，记 `worker.crashed`。
- **任务行的清理**：预览与重放的结果由接口进程同步取走，之后没人再读。接口进程与对账同一个间隔，删掉入队超过 `RW_TASK_RETENTION_MS`（缺省 1 小时）的预览与重放任务行，表不随预览次数一直长大。批次项的行是批次逐项状态与出图记录列表的来源，一直保留。
- **排空**：收到 SIGTERM 时先离开、不再领预览与重放，做完本构建排队的批次项再退出。发布新版本时，旧构建的 worker 就这样做完已接受的批次（Compose 的停止宽限缺省 30 分钟，`RW_WORKER_STOP_GRACE`）。旧构建的 worker 全都不在了，它接受的批次会停在排队中，要再起一个旧构建的 worker 才能做完。
- **数值**：每个 worker 1 个 CPU、2 GB 内存、单项超时 60 秒、做满 500 项换新，依据见[容量基线](#容量基线)。

## 容量基线

票据 15 在本机 Docker Compose 上经开放 API 实测，定下 worker 的数值（M302）。测量用 `node service/scripts/capacity.mjs profile|long|scale|soak`，每个阶段都从空环境起服务；逐项数字与测试机见[第四阶段验收](stage4-acceptance.md#容量基线)。

**每个 worker 的预算**：

| 项 | 定值 | 依据 |
|---|---|---|
| CPU | 1 个（`RW_WORKER_CPUS`） | 渲染是单线程的：给 4 个 CPU 时 M402 线路牌与大图只快 2–4%（1,061 → 1,022 ms），渲染时 worker 一直用满约 1 个核；本来就快的价签快一些（107 → 92 ms） |
| 内存上限 | 2 GB（`RW_WORKER_MEMORY`，不用交换分区） | 单张上限 1 亿像素的图峰值 1.3 GB；M402 线路牌（740 × 165 mm、120 dpi）约 0.3 GB，价签约 0.35 GB，1500 mm 宽的线路牌 0.6–0.7 GB |
| 单项超时 | 60 秒（`RW_RENDER_TIMEOUT_MS`，原暂定 30 秒） | 限制之内最慢的一项是单边 2 万像素的线路牌（1500 mm、338 dpi）：用时随本站序号增长，第 10 站 12.6 秒，本机第 35 站比第 10 站再多约 5 秒，推断约 18 秒。多起 worker、核不够用时单项会慢到 1.8 倍（见下表），30 秒不够；60 秒留 3 倍余量。展开上限之内最重的草稿（2,000 项循环）约 1 秒 |
| 子进程换新 | 做满 500 项（`RW_RENDER_RECYCLE_AFTER`） | 千项长批次不换新时，容器内存从 270 MiB 到 293 MiB，逐项用时不变；换新一次约 1 秒，每 500 项一次 |

**吞吐**：M402 线路牌每个 worker 每分钟约 60 张，价签约 9 张每秒。多起 worker 吞吐按个数增长，直到物理核用完：

| worker | 每分钟 | 每个 worker | 单项中位数 |
|---|---|---|---|
| 1 | 59.6 | 59.6 | 1,103 ms |
| 2 | 115.2 | 57.6 | 1,129 ms |
| 4 | 220.2 | 55.1 | 1,184 ms |
| 8 | 361.7 | 45.2 | 1,429 ms |
| 16 | 525.1 | 32.8 | 1,987 ms |

测试机是 8 个性能核加 12 个能效核：超过 8 个 worker 后有的落到能效核与超线程上，单项变慢。16 个 worker 时对象存储约用半个核、PostgreSQL 约四分之一个核，接口进程平时不到十分之一个核，提交批次时会冲到 1.5 个核。

**并发数**（worker 个数，`RW_WORKERS`）：每个物理核一个 worker，留 1–2 个核给接口进程、PostgreSQL 与对象存储；内存按每个 worker 2 GB，另留 2 GB 给其余服务与系统。例如 8 核 16 GB 的云服务器起 6 个 worker，M402 线路牌每小时约 2 万张。起多个 worker 时宿主端口给一段：

```bash
RW_WORKERS=6 RW_WORKER_PORT=8081-8086 docker compose up -d --wait
```

**入队前的限制与套餐**：数值不变（见[模板与草稿预览](#模板与草稿预览)）。展开上限之内最重的一项也远在超时之内；草稿预览从提交到拿到图约 1.2 秒，每个租户同时 2 个、每分钟 60 次够用。

**接口进程里的同步工作**（票据 13 留到这里定）：Excel 解析与提交批次都在接口进程里做，不另限流。期间每 20 ms 探一次 `/healthz`，最长的一次就是接口进程被占住的时长：

| 请求 | 答完 | `/healthz` 最长等 |
|---|---|---|
| Excel 导入：一千行的价签表 | 80–110 ms | 45 ms |
| Excel 导入：主表补到单元格上限（50 万个） | 0.7 秒 | 0.57 秒 |
| Excel 导入：超出解压上限的 3.4 MB 文件 | 约 220 ms，答 413 | 50 ms |
| 提交千项价签（数据写在请求里，390 KB） | 0.9 秒 | 0.25 秒 |
| 提交千项 M402（引用已保存的数据集，150 KB） | 2.7–3.1 秒 | 0.9 秒 |

- 提交千项 M402 原先要 4 秒：每项检查数据集字节数时都去库里读一遍文档清单。已改为一个请求读一次，逐项量规模时每 25 项让出一次事件循环。
- 剩下最长的约 0.9 秒，推断是引擎一次固定整批（`freezeBatch`，同步），服务只经公开入口调用它，拆不开。
- 限制之内最坏的一次占住接口进程不到 1 秒，健康检查的超时是 5 秒，所以不另限流。一个接口进程每分钟要处理多个这样的大请求、别的请求的延迟明显变长时，把固定批次、量规模与 Excel 解析挪出事件循环（M302）。

**长期负载**：3 个租户、2 个 worker 连续出图 3 小时，32,091 项全部交付；接口进程与 worker 的内存不随时间增长（接口进程约 110 MiB，worker 约 335 MiB），各种批次大小的用时前后一样，计量与 webhook 逐个对得上。本机模拟对象存储用的 RustFS 内存 3 小时从 0.7 GiB 涨到 2.25 GiB，没看到封顶，生产换对象存储时另设内存上限。

## 数据库迁移

- **写法**：迁移是 `service/migrations/NNNN_名称.sql`，版本号从 1 连续递增，只追加，不修改已执行的文件。
- **执行**：部署步骤 `setup` 用属主账号，在咨询锁下按版本号逐个执行，每个迁移一个事务，并记下文件的 SHA-256（M262）。
- **检查**：接口进程与 worker 启动时只检查，等到迁移执行完再就绪。
- **拒绝启动**：已执行的迁移被改过，或数据库有代码不认识的版本时，拒绝启动。

## 存储布局

依据 ADR-0018、ADR-0019：

- **对象**：内容按 SHA-256 存在租户前缀下，键是 `tenants/<租户>/blobs/sha256/<哈希>`。同一租户内相同字节只存一份，跨批次也是；不同租户各存一份。
- **提交**：先写对象，再在一个数据库事务里登记。没登记的对象不会被读到；v1.0 不回收它们（包括替换检查存下、最后没应用的候选内容）。
- **工作区文档**：按原始字节存，数据库只记来源、哈希与字节数。读出时按登记的哈希核对。
  - 推送进来的文档与经接口保存的数据集，来源写成"种类:键"：`definition:名称@版本`、`compiled:名称@版本`、`template:模板名`、`dataset:数据集ID`。渲染问题里的位置就是它。
  - 模板的修订另记一张表，只追加；另一张表按模板名记当前修订，工作区里模板那一行跟着指向当前修订的内容（M265）。
- **资源仓库**：语义与 `renderweave-resources/1` 相同，由引擎的 `resourceBackend` 统一负责（M260）。
  - 同一租户的资源提交、推送、改模板的当前修订与保存数据集锁住同一行依次进行，清单只追加；
  - 读取时引擎核对字节数与哈希。
- **出图记录**：
  - 一项的全部文件与完成清单在一个事务里登记，"批次加项序号"唯一，同一项不会登记两次；
  - 批次清单在全部项结束后登记；
  - 记录与批次的读取、重放用引擎的同一组函数。

## 构建标识与镜像

- **算法**：渲染器构建标识按引擎文件、锁文件与实际安装的生产依赖计算（ADR-0013）。
- **镜像里的标识**：构建镜像时，把它写进 `/app/BUILD_ID`，启动脚本据此打标签。
- **与本机一致**：2026-10-19 实测，Windows 本机构建的引擎与镜像里的引擎得到同一个构建标识。所以服务交出的记录导出后，能用本机的 `renderweave replay` 重放（ADR-0019）。
- **保留规则**（M273）：只要还有记录引用某个构建，就不删它的镜像。发布新构建时旧标签照样保留；平台管理员用 `GET /v1/platform/builds` 看被记录引用的构建、各自的记录数、最近交付时间、镜像标签与在线的 worker 数，没有记录引用、也没有 worker 的构建才可以清理。
- **重放旧构建的记录**：Compose 的 `replay` 配置用保留的镜像起一个 worker，它只领自己构建的批次项与重放：

```bash
RW_REPLAY_IMAGE=renderweave-service:sha256-<构建的十六进制> docker compose --profile replay up -d replay-worker
```

## 测试

两种后端跑同一组 API 用例（M263）：

- **`npm test`**：不需要 Docker。
  - 开放 API 用例跑内存后端（`service/test/api.test.ts`），覆盖权限矩阵、跨租户端点清单、审计与日志里不出现密钥。
  - 代建推送用例（`service/test/push.test.ts`）从 `src/cli.ts` 跑命令行，推送到本机端口上的内存后端，再经开放 API 读回核对。
  - 模板与草稿预览用例（`service/test/preview.test.ts`）用进程内 worker；预览的图片与本机直接渲染的逐字节相同。
  - 出图记录用例（`service/test/records.test.ts`）用进程内 worker：查询与翻页；下载的文件与登记的相同；导出包解开后与引擎在本地 `deliver` 的批次目录逐字节相同，并用命令行的 `batch-read`、`record-read` 与 `replay` 离线通过；重放与构建不在时的拒绝。
  - 批量交付用例（`service/test/batch.test.ts`）用进程内 worker：批次清单与出图记录和引擎在本进程交付的逐字节相同，记录能重放；另测构建固定、排空、租约重领与过期的写回。
  - 数据集用例（`service/test/datasets.test.ts`）：读回的字节与保存的相同；校验的问题与引擎对同一份数据的 `checkDataset` 相同（引擎的 `test/dataset-check.test.ts` 再核对它与渲染时相同）；按 ID 预览与内联同一份数据的预览逐字节相同。
  - 计量与额度用例（`service/test/metering.test.ts`）用进程内 worker：套餐的设置与校验；预占、整批拒绝与剩余额度；逐项结算与失败项退回；同一幂等键重试与 worker 重领只计一次；取消退回；草稿与重放不计；单张最大像素；UTC+8 的周期与不结转；对账；明细的筛选、翻页与可见范围。代建 token 的记账在推送用例里，从命令行附带轮次目录。
  - webhook 用例（`service/test/webhooks.test.ts`）在测试进程里起投递任务，接收端在本机：
    - 注册、停用与上限；签名按文档独立核对；
    - 四种结果的事件各投递一次；500、超时、断开之后的退避重试；试满次数记失败；
    - 重定向不跟随；停用后不再投递；投递时挡住解析到回环的地址；日志里没有密钥与 URL。
  - OpenAPI 合同用例（`service/test/openapi.test.ts`）：
    - 描述覆盖全部端点，与快照相同，Schema 在严格模式下都能编译；
    - 相对 1.0.0 基线只做了加法，兼容检查本身另有不兼容与加法的例子；
    - 逐个端点探查 401、404 与 400。
    - 其余 API 用例的每个回答都按描述核对。
  - Excel 导入用例（`service/test/imports.test.ts`）用测试进程里的 worker：
    - 两份样例读出的数据与样例的 JSON 相同，线路牌的第一行与 M402 数据集逐字段相同；按预览提交后全部交付；
    - 问题定位到工作表、行与列，有问题的行不进批量请求；引用的各种问题；
    - 共享字符串、内联字符串、富文本与注音、公式、命名空间前缀、省略坐标、1904 日期系统都读出同样的数据；
    - 空白表的结构，原样导回去表头全都认得；
    - 上限与读不了的文件。测试用的工作簿由 `service/test/xlsx-fixture.ts` 按 Excel 与其他程序的写法拼出。
  - 出图控制台的静态文件（`service/test/console.test.ts`）：缓存与内容安全策略的响应头、只回答构建目录里认识的文件、没有构建时的说明、不进路由表与 OpenAPI 描述。
  - 出图控制台的浏览器用例另有本机快速版（`service/test/console.browser.test.ts`）：内存后端、进程内 worker，设了 `RW_BROWSER`（本机 Chromium 内核浏览器的可执行文件）并先构建控制台才运行，否则跳过；取消的用例在快速版里跳过（M281）。
  - 资源用例（`service/test/resources.test.ts`）：替换检查的影响与引擎对本机 M402 工作区的 `resourceImpact` 相同；应用后旧版本内容保留；用过的、工作区已变化的报告被拒绝；同一份报告同时应用两次只有一次成功。
  - 渲染子进程用例（`service/test/child-runner.test.ts`）用假的子进程脚本代替 render-child：子进程在两项之间自己退出、被外部结束、IPC 已断开，下一项都在新的子进程上照常完成，调度进程不退出（M350）。超时、内存超限与做满项数换新只在 Docker 后端测。
  - 共用的存储合同用例在 `test/support/storage-contract.ts`，本地与内存两种实现在 `test/storage-contract.test.ts` 里跑。
  - `pretest` 会在服务依赖缺失或锁文件变动时自动安装 `service/` 的依赖。
- **Docker 后端测试**：从空环境起全部服务，在 Compose 网络里的 tester 容器中跑 `service/test/*.docker.test.ts`，再核对服务日志每行都是合格的 JSON。默认前后都清空容器与数据卷，加 `--keep` 保留。

```bash
node service/scripts/test-docker.mjs
```

Docker 后端测试覆盖以下内容：

- 同一组开放 API、代建推送、模板与草稿预览、批量交付、数据集与资源、出图记录、Excel 导入的用例跑 PostgreSQL 加 S3 后端；预览由 Compose 里真实的 worker 进程渲染；替换的提交与工作区指纹的核对在同一个事务里；
- 构建固定：tester 跑的是引擎源码，构建标识与镜像里的不同。tester 里的接口进程接受的批次由 tester 里同构建的 worker 交付，Compose 里的 worker 不领；成果与引擎在本进程交付的逐字节相同，也就证明别的构建没有插手。经 Compose 里的接口进程提交的批次由真实的 worker 交付；
- 执行隔离：脚本给 worker 设小的值（单项超时 8 秒、内存上限 512 MB、做满 5 项换新）。16,000 项的循环触发超时，1 亿像素的草稿触发内存超限，之后的预览照常；做满 5 项的子进程换新。单项超时照 M302 的规则取（M349）：测试里最慢的正常一项是换新后第一项的 M402 与问候牌的重放，本机约 2 秒，不到超时的三分之一；
- 批量交付（经真实的接口进程与 worker）：批次中内存超限的一项失败、同批其他项照常交付；取消时正在渲染的一项被结束；同样的批次再交一次不多一个对象。正式模式有严重问题时不画图、很快结束，能画完的正式图在缺省限值内又都在 1 秒左右，所以批次里的超时不在这里测；超时结束子进程由预览的用例覆盖，结束之后标失败、写问题清单的处理与内存超限相同；
- webhook：投递由 Compose 里真实的接口进程完成。它与 tester 用同一个服务密钥，脚本把退避与超时缩短，并放开内网地址；接收端在 tester 容器里。另核对库里只存签名密钥的密文；
- 开放 API 描述：Compose 里的接口进程返回的描述与测试进程按同一份代码生成的相同，镜像里带着 DSL 的 JSON Schema；
- 出图控制台（M281）：tester 容器里的 Chromium 由 playwright-core 驱动，打开 Compose 里接口进程提供的 `/console/`，像客户操作员一样走完以下流程，每一步再经开放 API 核对：
  - 登录、看模板、调参；
  - 按表单填一份覆盖九种字段类型的数据，选图与上传，保存、修改、复制；
  - 问题叠加在图上；
  - 线路牌按本站序号 1–6 出 6 张，下载单张与整批压缩包，与开放 API 读到的字节相同；
  - 几份数据集一起出图时失败项的问题说明；
  - Excel 导入：下载的空白表与开放 API 给的相同；上传一份价签表，逐行预览，问题定位到单元格，提交能提交的行；
  - 取消进行中的批次；
  - 出图记录（票据 14）：不筛选、按模板、按批次、按日期查到的与开放 API 相同；下载的图片、按项与按批次的导出包解开后与开放 API 的逐个文件相同；
  - 用量：操作员与管理员看到的合计与开放 API 相同，只有管理员有明细；
  - 管理：改成员的角色、停用之后会话失效；API 密钥只显示一次、能用、刷新后页面上没有它、吊销后立即失效；注册 webhook，Compose 里的接口进程把批次结束的事件投递给 tester 里的接收端，投递记录与开放 API 相同，签名用页面上显示的密钥核得上；审计日志与开放 API 相同；
  - 资源：操作员上传新图、没有替换入口；客户管理员替换 landmark-2，页面上的影响与检查的回答相同，确认前资源不变，确认后是 v2、v1 保留；
  - 操作员的模块下拉里没有"管理"，直接打开管理页不请求管理端点；操作员直接调用管理端点都答 403；
  - 新框架（P1 票据 01）：模块下拉按角色列出模块与快捷键，`Ctrl+数字` 切换；`Ctrl+K` 按角色只列模块与常用动作，筛选后回车打开，焦点落在要做的那一步上；状态栏的连接、租户、本月剩余与开放 API 相同，进行中的批次在提交后出现、取消结束后消失；旧链接照旧能打开；1440 与 375 像素宽时各模块页都没有横向滚动，正文与页面底的对比度不低于 4.5，带字的元素不用调和橙；
  - 退出。

  整个过程没有脚本错误，也没有被内容安全策略拦下的资源；
- 崩溃后对账：在 tester 里用镜像里编译好的服务（另加一个标记文件，构建标识与 Compose 里的不同）起接口进程与 worker 进程，批次进行中把两个进程都强杀，只起接口进程：被强杀的 worker 30 秒后不再算在线，对账退回遗留的预占；再起 worker 交付完，每项只计一次；
- 出图记录：测试进程的 worker 与 Compose 里的 worker 是两个构建，各自交付的记录各自重放成功，镜像构建的记录在测试进程里离线重放被拒；直接改写对象存储里的一个对象，下载、整批图片、两种导出都答 `record.integrityMismatch`，重放报同样的问题；
- 行级安全：
  - 每张租户表都开启，漏写条件只返回当前租户；
  - 没设置租户时查不到，平台模式看不到租户数据；
  - 越权写入被拒，审计、用量事件与 webhook 的事件、尝试只能追加，webhook 不能删，应用账号不能改表结构；
- 存储：
  - PostgreSQL 加 S3 实现跑同一组合同用例；
  - 对象键与去重、文档原文、事务提交点、并发提交与同一项只登记一次；
- 迁移的顺序、回滚与启动检查；
- 健康检查、服务用的是应用账号、未就绪时的响应与结构化日志。

服务的类型检查：先 `npm run build`，再 `npm run typecheck:service`，它也检查控制台的源码。
