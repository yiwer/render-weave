# 出图服务

阶段 4 的出图服务（ADR-0017）由三部分组成：接口进程、PostgreSQL 里的任务队列、渲染 worker。代码在 `service/`，不进引擎的 `src/`，只经 `service/src/engine.ts` 调用引擎的公开入口。

目前完成了四部分：

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

批量交付、出图记录、数据集与资源接口、计量与额度由后续票据加入。

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
| `RW_WORKER_MEMORY` | Compose | worker 容器的内存上限，缺省 `2g`，不用交换分区 |

本机的 `.env` 有四项：`RW_POSTGRES_PASSWORD`、`RW_APP_DB_PASSWORD`、`RW_S3_ACCESS_KEY_ID`、`RW_S3_SECRET_ACCESS_KEY`。Compose 用这四项拼出上面的变量。

## 进程与命令

一个镜像，按命令区分：`node service/dist/main.js <命令>`。

| 命令 | 作用 |
|---|---|
| `setup` | 部署步骤：用属主账号执行数据库迁移，让应用账号能登录并设置密码，再建桶。运行时的服务只用读、写、取头信息、列举 |
| `api` | 等迁移与代码一致，再启动接口进程 |
| `worker` | 等迁移与代码一致，再启动渲染 worker：调度进程领取任务，交给渲染子进程（见[渲染 worker](#渲染-worker)） |
| `platform-admin <邮箱>` | 建平台管理员账号，随机初始密码只显示一次；操作记审计 |
| `build-id` | 输出渲染器构建标识 |

**健康检查**：接口进程与 worker 都有两个端点。

- `GET /healthz`：存活，返回服务名与构建标识；worker 另带渲染器的计数（`renderer`：已做的任务、超时、内存超限、崩溃与子进程换新的次数）。
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
| `GET`、`POST /v1/platform/tenants` | 平台管理员 |
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

**错误**一律是 `{ "problems": [...] }`，格式与引擎的问题一致：

| 状态 | 问题码 |
|---|---|
| 400 | `request.invalid`（位置写到出错的字段）、`push.contentMissing`、`push.contentMismatch` |
| 401 | `auth.required`、`auth.invalidCredentials` |
| 403 | `auth.forbidden` |
| 404 | `request.notFound` |
| 409 | `member.emailTaken`、`member.lastAdmin`、`push.conflict` |
| 413 | `limit.requestTooLarge`、`limit.datasetTooLarge`、`limit.pixelsExceeded`、`limit.expansionExceeded` |
| 415 | `request.invalid`：上传内容不是 `application/octet-stream` |
| 429 | `preview.rateLimited` |
| 503 | `worker.unavailable`：等不到 worker 渲染完 |

JSON 请求体里超过 15 位有效数字的数值按双精度读取会失真，一律答 400 `request.invalid`，与命令行一致（M112）。

客户端点的租户由身份决定，路径里没有租户 ID。

## 租户隔离

两道防线（ADR-0018、M262）：

1. **应用层**：鉴权之后只拿到本租户的句柄，对象键与查询条件都由句柄生成，客户端不能提交键或路径。对象不在本租户时，与不存在同样答 404，不泄露对象是否存在。
2. **数据库**：每张带 `tenant_id` 的表都开了行级安全。
   - **账号**：接口进程与 worker 用应用账号 `renderweave_app` 连库，它不是超级用户，也不是表的属主。
   - **当前租户**：每个事务设置当前租户。漏写租户条件的查询只返回当前租户的行，没设置时什么也查不到。
   - **平台模式**：只对账号、会话、审计、租户与代建令牌有效，对文档、资源、批次与密钥无效。
   - **跨租户查找**：按邮箱登录、按令牌解析身份，由属主身份执行的两个函数完成。
   - **权限**：应用账号不能改表结构；审计只能追加。

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
renderweave push --server http://127.0.0.1:8080 --tenant <租户ID> --workspace <工作区> --resources <资源版本仓库> [--dry-run]
```

- **令牌**：代建令牌只经环境变量传入，缺省 `RENDERWEAVE_AUTHORING_TOKEN`，可用 `--token-env` 换名；不写进参数、日志与输出。令牌只能推送到被指定的租户，别的租户与不存在的租户同样答 404。
- **推送什么**：
  - 工作区里的静态数据定义、编译产物、模板与样例数据集，按原始字节；其他 JSON（如渲染请求）不推送，列在输出的 `skipped` 里；
  - 资源版本仓库里的全部资源及其全部内容版本。
- **推送前先检查本地**：工作区有严重问题（如模板重名、无法解析）时不推送；资源目录还不是版本仓库或是旧版目录时，问题说明与 `resources-list` 等命令一致（M239）。
- **输出**：标准错误流逐条列出新增、更新与冲突，标准输出是 JSON 汇总（`summary`、逐项的 `documents` 与 `resources`）。退出码 0 已推送（`--dry-run` 时为没有冲突）；1 有冲突、本地有严重问题、连不上服务或请求被拒绝；2 用法错误或缺少令牌。

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
- **不计额度**；按租户限制：同时排队与渲染中的预览最多 2 个，一分钟内最多入队 60 次（撤回的也算），超过答 429 `preview.rateLimited`。入队超过等待时长的任务不再占并发，worker 中途退出时不会一直卡住。
- **代建工程师**用 `POST /v1/authoring/tenants/{租户}/previews`，以被指定租户的身份预览，同一套检查与限制，记审计 `authoring.preview`。

**入队前的限制**（ADR-0017）：接口进程用引擎的 `measureRender` 量出像素与展开规模，不出图；超限答 413，不占 worker。

| 限制 | 缺省 | 问题码 |
|---|---|---|
| 请求体字节数（内联的数据集算在里面） | 1 MiB | `limit.requestTooLarge` |
| 引用的已保存数据集的字节数 | 1 MiB | `limit.datasetTooLarge` |
| 单张图的像素总数 | 1 亿（引擎上限）；套餐（票据 09）出来后取套餐值 | `limit.pixelsExceeded` |
| 展开后会显示的元素数 | 20,000 | `limit.expansionExceeded` |
| 展开后的循环项数（嵌套逐层累计） | 2,000 | `limit.expansionExceeded` |

这些数值与单项超时、内存上限都是暂定的，容量基线（票据 15）实测后再定。

## 渲染 worker

一个 worker 容器有一个调度进程和一个渲染子进程，一次只做一项（ADR-0017、M266）：

- **领取**：调度进程用 `rw_claim_task` 领最早排队的一项（`SELECT … FOR UPDATE SKIP LOCKED`，跨租户，由属主身份执行），队列空时每 100 ms 再看。入队、查结果与写回结果都在租户的事务里，行级安全照常生效。
- **渲染子进程**：调度进程 fork 它，经 IPC 一次交一项。子进程自己连数据库与对象存储读租户的工作区与资源，启动时先加载 CanvasKit，准备好才接任务；单项时限从交出任务起算。
- **单项超时**：到时调度进程结束子进程，本项答 `worker.timeout`。
- **内存超限**：内存上限是容器的限制（`mem_limit`，不用交换分区）。子进程启动时把自己的 `oom_score_adj` 调到最高，内存不够时内核先结束它；调度进程看本容器 cgroup 的 `memory.events` 里 `oom_kill` 增加了，本项答 `worker.memoryExceeded`。
- **换新**：子进程在任务之间复用；做满 `RW_RENDER_RECYCLE_AFTER` 项、超时、内存超限或崩溃后换一个新的，换下后立即起新的预热。
- **实测**（Windows，Node v24，问候牌草稿）：每像素约 13 字节，1 亿像素的草稿峰值约 1.3 GB、3 秒；只有一种字体的小图峰值约 210 MB。6,000 项文字的循环约 4 秒、峰值约 400 MB。缺省的 2 GB 内存上限放得下引擎上限的一张图。

## 数据库迁移

- **写法**：迁移是 `service/migrations/NNNN_名称.sql`，版本号从 1 连续递增，只追加，不修改已执行的文件。
- **执行**：部署步骤 `setup` 用属主账号，在咨询锁下按版本号逐个执行，每个迁移一个事务，并记下文件的 SHA-256（M262）。
- **检查**：接口进程与 worker 启动时只检查，等到迁移执行完再就绪。
- **拒绝启动**：已执行的迁移被改过，或数据库有代码不认识的版本时，拒绝启动。

## 存储布局

依据 ADR-0018、ADR-0019：

- **对象**：内容按 SHA-256 存在租户前缀下，键是 `tenants/<租户>/blobs/sha256/<哈希>`。同一租户内相同字节只存一份，跨批次也是；不同租户各存一份。
- **提交**：先写对象，再在一个数据库事务里登记。没登记的对象不会被读到；v1.0 不回收它们。
- **工作区文档**：按原始字节存，数据库只记来源、哈希与字节数。读出时按登记的哈希核对。
  - 推送进来的文档，来源写成"种类:键"：`definition:名称@版本`、`compiled:名称@版本`、`template:模板名`、`dataset:数据集ID`。渲染问题里的位置就是它。
  - 模板的修订另记一张表，只追加；另一张表按模板名记当前修订，工作区里模板那一行跟着指向当前修订的内容（M265）。
- **资源仓库**：语义与 `renderweave-resources/1` 相同，由引擎的 `resourceBackend` 统一负责（M260）。
  - 同一租户的提交锁住一行依次进行，清单只追加；
  - 读取时引擎核对字节数与哈希。
- **出图记录**：
  - 一项的全部文件与完成清单在一个事务里登记，"批次加项序号"唯一，同一项不会登记两次；
  - 批次清单在全部项结束后登记；
  - 记录与批次的读取、重放用引擎的同一组函数。

## 构建标识与镜像

- **算法**：渲染器构建标识按引擎文件、锁文件与实际安装的生产依赖计算（ADR-0013）。
- **镜像里的标识**：构建镜像时，把它写进 `/app/BUILD_ID`，启动脚本据此打标签。
- **与本机一致**：2026-10-19 实测，Windows 本机构建的引擎与镜像里的引擎得到同一个构建标识。所以服务交出的记录导出后，能用本机的 `renderweave replay` 重放（ADR-0019）。

## 测试

两种后端跑同一组 API 用例（M263）：

- **`npm test`**：不需要 Docker。
  - 开放 API 用例跑内存后端（`service/test/api.test.ts`），覆盖权限矩阵、跨租户端点清单、审计与日志里不出现密钥。
  - 代建推送用例（`service/test/push.test.ts`）从 `src/cli.ts` 跑命令行，推送到本机端口上的内存后端，再经开放 API 读回核对。
  - 模板与草稿预览用例（`service/test/preview.test.ts`）用进程内 worker；预览的图片与本机直接渲染的逐字节相同。
  - 共用的存储合同用例在 `test/support/storage-contract.ts`，本地与内存两种实现在 `test/storage-contract.test.ts` 里跑。
  - `pretest` 会在服务依赖缺失或锁文件变动时自动安装 `service/` 的依赖。
- **Docker 后端测试**：从空环境起全部服务，在 Compose 网络里的 tester 容器中跑 `service/test/*.docker.test.ts`，再核对服务日志每行都是合格的 JSON。默认前后都清空容器与数据卷，加 `--keep` 保留。

```bash
node service/scripts/test-docker.mjs
```

Docker 后端测试覆盖以下内容：

- 同一组开放 API、代建推送、模板与草稿预览的用例跑 PostgreSQL 加 S3 后端；预览由 Compose 里真实的 worker 进程渲染；
- 执行隔离：脚本给 worker 设极小的值（单项超时 1.5 秒、内存上限 512 MB、做满 5 项换新）。6,000 项的循环触发超时，1 亿像素的草稿触发内存超限，之后的预览照常；做满 5 项的子进程换新；
- 行级安全：
  - 每张租户表都开启，漏写条件只返回当前租户；
  - 没设置租户时查不到，平台模式看不到租户数据；
  - 越权写入被拒，审计只能追加，应用账号不能改表结构；
- 存储：
  - PostgreSQL 加 S3 实现跑同一组合同用例；
  - 对象键与去重、文档原文、事务提交点、并发提交与同一项只登记一次；
- 迁移的顺序、回滚与启动检查；
- 健康检查、服务用的是应用账号、未就绪时的响应与结构化日志。

服务的类型检查：先 `npm run build`，再 `npm run typecheck:service`。
