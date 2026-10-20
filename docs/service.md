# 出图服务

阶段 4 的出图服务（ADR-0017）由三部分组成：接口进程、PostgreSQL 里的任务队列、渲染 worker。代码在 `service/`，不进引擎的 `src/`，只经 `service/src/engine.ts` 调用引擎的公开入口。

目前完成了八部分：

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
  - 推送可以附带代建轮次，各轮的 token 记为用量事件；客户管理员与平台管理员看已用、预占、剩余与明细。

## 本机启动

需要 Docker 与 Node.js 22 以上，不需要在本机装服务的依赖。在仓库根目录执行：

```bash
node service/scripts/up.mjs
```

这条命令做三件事：

1. **生成凭据**：在仓库根的 `.env` 里补上缺少的随机凭据：数据库属主、应用账号与对象存储各一项。已有的值不动，`.env` 不进版本库，命令也不打印凭据。
2. **构建并启动**：构建镜像；起 PostgreSQL 与 S3 兼容存储；执行部署步骤 `setup`，包括迁移、应用账号与建桶；再起接口进程和一个 worker，等到全部就绪。
3. **打标签**：用渲染器构建标识给镜像打标签，形如 `renderweave-service:sha256-<哈希>`。

`.env` 齐全之后，也可以直接用 `docker compose up -d --build --wait`。停止用 `docker compose down`；连数据一起清掉，加 `-v`。

| 组件 | Compose 服务 | 端口 |
|---|---|---|
| 接口进程 | `api` | `8080`，可用 `RW_API_PORT` 改 |
| 渲染 worker | `worker` | `8081`，可用 `RW_WORKER_PORT` 改 |
| PostgreSQL 17 | `postgres` | 只在 Compose 网络内 |
| S3 兼容存储（RustFS 1.0.3） | `s3` | 只在 Compose 网络内 |
| 部署步骤 | `setup` | 迁移、设置应用账号、建桶后退出 |

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
| `RW_RENDER_TIMEOUT_MS` | worker | 单项超时，缺省 30000（M266） |
| `RW_RENDER_RECYCLE_AFTER` | worker | 渲染子进程做满这么多项后换新，缺省 500 |
| `RW_WORKER_POLL_MS` | worker | 队列空时隔多久再看，缺省 100 |
| `RW_RECONCILE_MS` | 接口进程 | 对账任务隔多久做一次，缺省 60000（M275） |
| `RW_RESERVATION_GRACE_MS` | 接口进程 | 批次闲置多久、又没有它的构建的 worker 时退回预占，缺省 600000（10 分钟） |
| `RW_WORKER_MEMORY` | Compose | worker 容器的内存上限，缺省 `2g`，不用交换分区 |
| `RW_WORKER_STOP_GRACE` | Compose | worker 的停止宽限，缺省 `30m`：停止时做完本构建已接受的批次项再退出（M269） |

本机的 `.env` 有四项：`RW_POSTGRES_PASSWORD`、`RW_APP_DB_PASSWORD`、`RW_S3_ACCESS_KEY_ID`、`RW_S3_SECRET_ACCESS_KEY`。Compose 用这四项拼出上面的变量。

## 进程与命令

一个镜像，按命令区分：`node service/dist/main.js <命令>`。

| 命令 | 作用 |
|---|---|
| `setup` | 部署步骤：用属主账号执行数据库迁移，让应用账号能登录并设置密码，再建桶。运行时的服务只用读、写、取头信息、列举 |
| `api` | 等迁移与代码一致，再启动接口进程；启动时与之后定期对账，退回崩溃后遗留的预占（见[计量与额度](#计量与额度)） |
| `worker` | 等迁移与代码一致，再启动渲染 worker：调度进程领取任务，交给渲染子进程；收到停止信号时排空（见[渲染 worker](#渲染-worker)） |
| `platform-admin <邮箱>` | 建平台管理员账号，随机初始密码只显示一次；操作记审计 |
| `build-id` | 输出渲染器构建标识 |

**健康检查**：接口进程与 worker 都有两个端点。

- `GET /healthz`：存活，返回服务名与构建标识；worker 另带渲染器的计数（`renderer`：已做的任务、超时、内存超限、崩溃、取消时结束的项与子进程换新的次数）。
- `GET /readyz`：就绪。要求数据库可连、迁移与代码一致、对象存储可列举；否则返回 503，并列出没通过的检查项与原因，不带连接串或凭据。

**日志**：每行一个 JSON 对象，带时间、级别、服务名（`api`、`worker`、`setup`）与构建标识。请求体不进日志；请求头里的凭据会被遮盖。

## 账号与鉴权

五种身份（M247）。每个请求用 `Authorization: Bearer <令牌>`（M261）：

| 身份 | 怎么得到令牌 | 能做什么 |
|---|---|---|
| 客户操作员 | 邮箱加密码登录 `POST /v1/sessions`，会话 12 小时 | 本租户的数据集、上传新资源、预览、交付、查记录 |
| 客户管理员 | 同上 | 操作员的全部，另管成员与角色、API 密钥、webhook，替换已有资源，看用量与审计 |
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
| `GET /v1/usage`、`GET /v1/usage/events` | 客户管理员；本租户的用量与明细 |

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

**审计**：代建端点的每次调用都记进目标租户的审计，标为跨租户：`authoring.access`、`authoring.read`、`content.read`、`content.upload`、`push.plan`、`push.commit`、`push.reject`、`template.setCurrent`。

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

这些数值与单项超时、内存上限都是暂定的，容量基线（票据 15）实测后再定。

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

- `GET /v1/usage?period=YYYY-MM`：客户管理员看本租户的，缺省当前周期；`plan` 是当前套餐，`images.limit` 是那个周期的限额。
- `GET /v1/usage/events?period&kind&limit&before`：用量事件，按 ID 倒序，`kind` 是 `image` 或四种 token 之一，`limit` 1–500，`before` 带上一页的 `next`。
- 平台管理员用 `GET /v1/platform/tenants/{租户}/usage` 与 `…/usage/events` 看任一租户的，回答相同。
- 用量事件只追加，应用账号不能改、不能删。

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
- **取消**：渲染批次项时每 200 ms 查看一次批次是否已取消，取消了就结束子进程，本项标为未执行。
- **没渲染完的批次项**：超时、内存超限或崩溃的项写出问题清单文件，标为失败，没有记录；这一项已登记时以登记的为准。
- **租约与重领**：批次项的租约是单项超时加 60 秒。worker 中途退出（例如容器被杀）时，过了租约，同构建的 worker 重领。
  - 重领前先看这一项是否已登记：已登记就沿用，不重渲染，记录只提交一次；
  - 写回以领取次数作凭据，重领之后旧的写回不生效；
  - 领了 3 次仍没做完，记 `worker.crashed`。
- **排空**：收到 SIGTERM 时先离开、不再领预览与重放，做完本构建排队的批次项再退出。发布新版本时，旧构建的 worker 就这样做完已接受的批次（Compose 的停止宽限缺省 30 分钟，`RW_WORKER_STOP_GRACE`）。旧构建的 worker 全都不在了，它接受的批次会停在排队中，要再起一个旧构建的 worker 才能做完。
- **实测**（Windows，Node v24，问候牌草稿）：每像素约 13 字节，1 亿像素的草稿峰值约 1.3 GB、3 秒；只有一种字体的小图峰值约 210 MB。6,000 项文字的循环约 4 秒、峰值约 400 MB。缺省的 2 GB 内存上限放得下引擎上限的一张图。

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
  - 资源用例（`service/test/resources.test.ts`）：替换检查的影响与引擎对本机 M402 工作区的 `resourceImpact` 相同；应用后旧版本内容保留；用过的、工作区已变化的报告被拒绝；同一份报告同时应用两次只有一次成功。
  - 共用的存储合同用例在 `test/support/storage-contract.ts`，本地与内存两种实现在 `test/storage-contract.test.ts` 里跑。
  - `pretest` 会在服务依赖缺失或锁文件变动时自动安装 `service/` 的依赖。
- **Docker 后端测试**：从空环境起全部服务，在 Compose 网络里的 tester 容器中跑 `service/test/*.docker.test.ts`，再核对服务日志每行都是合格的 JSON。默认前后都清空容器与数据卷，加 `--keep` 保留。

```bash
node service/scripts/test-docker.mjs
```

Docker 后端测试覆盖以下内容：

- 同一组开放 API、代建推送、模板与草稿预览、批量交付、数据集与资源、出图记录的用例跑 PostgreSQL 加 S3 后端；预览由 Compose 里真实的 worker 进程渲染；替换的提交与工作区指纹的核对在同一个事务里；
- 构建固定：tester 跑的是引擎源码，构建标识与镜像里的不同。tester 里的接口进程接受的批次由 tester 里同构建的 worker 交付，Compose 里的 worker 不领；成果与引擎在本进程交付的逐字节相同，也就证明别的构建没有插手。经 Compose 里的接口进程提交的批次由真实的 worker 交付；
- 执行隔离：脚本给 worker 设极小的值（单项超时 1.5 秒、内存上限 512 MB、做满 5 项换新）。6,000 项的循环触发超时，1 亿像素的草稿触发内存超限，之后的预览照常；做满 5 项的子进程换新；
- 批量交付（经真实的接口进程与 worker）：批次中内存超限的一项失败、同批其他项照常交付；取消时正在渲染的一项被结束；同样的批次再交一次不多一个对象。正式模式有严重问题时不画图、很快结束，能画完的正式图在缺省限值内又都在 1 秒左右，所以批次里的超时不在这里测；超时结束子进程由预览的用例覆盖，结束之后标失败、写问题清单的处理与内存超限相同；
- 崩溃后对账：在 tester 里用镜像里编译好的服务（另加一个标记文件，构建标识与 Compose 里的不同）起接口进程与 worker 进程，批次进行中把两个进程都强杀，只起接口进程：被强杀的 worker 30 秒后不再算在线，对账退回遗留的预占；再起 worker 交付完，每项只计一次；
- 出图记录：测试进程的 worker 与 Compose 里的 worker 是两个构建，各自交付的记录各自重放成功，镜像构建的记录在测试进程里离线重放被拒；直接改写对象存储里的一个对象，下载、整批图片、两种导出都答 `record.integrityMismatch`，重放报同样的问题；
- 行级安全：
  - 每张租户表都开启，漏写条件只返回当前租户；
  - 没设置租户时查不到，平台模式看不到租户数据；
  - 越权写入被拒，审计与用量事件只能追加，应用账号不能改表结构；
- 存储：
  - PostgreSQL 加 S3 实现跑同一组合同用例；
  - 对象键与去重、文档原文、事务提交点、并发提交与同一项只登记一次；
- 迁移的顺序、回滚与启动检查；
- 健康检查、服务用的是应用账号、未就绪时的响应与结构化日志。

服务的类型检查：先 `npm run build`，再 `npm run typecheck:service`。
