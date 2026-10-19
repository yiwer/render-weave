# 出图服务

阶段 4 的出图服务（ADR-0017）由三部分组成：接口进程、PostgreSQL 里的任务队列、渲染 worker。代码在 `service/`，不进引擎的 `src/`，只经 `service/src/engine.ts` 调用引擎的公开入口。

目前完成的是骨架（[票据 03](../.scratch/render-service-v1/issues/03-service-skeleton.md)，M259、M260）：
- Compose 编排、数据库迁移与健康检查；
- 工作区文档、版本化资源仓库与出图记录的 PostgreSQL 加 S3 实现。

开放 API、鉴权、任务队列与渲染子进程由后续票据加入。

## 本机启动

需要 Docker 与 Node.js 22 以上，不需要在本机装服务的依赖。在仓库根目录执行：

```bash
node service/scripts/up.mjs
```

这条命令做三件事：

1. **生成凭据**：没有 `.env` 时，在仓库根生成随机凭据。`.env` 不进版本库，命令也不打印凭据。
2. **构建并启动**：构建镜像，起 PostgreSQL、S3 兼容存储、建桶步骤、接口进程和一个 worker，等到全部就绪。
3. **打标签**：用渲染器构建标识给镜像打标签，形如 `renderweave-service:sha256-<哈希>`。

`.env` 生成之后，也可以直接用 `docker compose up -d --build --wait`。停止用 `docker compose down`；连数据一起清掉，加 `-v`。

| 组件 | Compose 服务 | 端口 |
|---|---|---|
| 接口进程 | `api` | `8080`，可用 `RW_API_PORT` 改 |
| 渲染 worker | `worker` | `8081`，可用 `RW_WORKER_PORT` 改 |
| PostgreSQL 17 | `postgres` | 只在 Compose 网络内 |
| S3 兼容存储（RustFS 1.0.3） | `s3` | 只在 Compose 网络内 |
| 建桶 | `setup` | 建好桶后退出 |

## 配置

配置只从环境变量读取，镜像与仓库里没有凭据（M259）。缺少变量时，进程只报变量名，不输出取值。

| 变量 | 含义 |
|---|---|
| `RW_DATABASE_URL` | PostgreSQL 连接串 |
| `RW_S3_ENDPOINT`、`RW_S3_BUCKET` | 对象存储地址与桶名 |
| `RW_S3_ACCESS_KEY_ID`、`RW_S3_SECRET_ACCESS_KEY` | 对象存储凭据 |
| `RW_S3_REGION` | 缺省 `us-east-1` |
| `RW_S3_FORCE_PATH_STYLE` | 缺省开启路径形式地址；写 `false` 关闭 |
| `RW_PORT` | 监听端口，接口进程缺省 8080，worker 缺省 8081 |
| `RW_LOG_LEVEL` | 缺省 `info` |

本机的 `.env` 只有三项：`RW_POSTGRES_PASSWORD`、`RW_S3_ACCESS_KEY_ID`、`RW_S3_SECRET_ACCESS_KEY`。Compose 用这三项拼出上面的变量。

## 进程与命令

一个镜像，按命令区分：`node service/dist/main.js <命令>`。

| 命令 | 作用 |
|---|---|
| `api` | 先执行数据库迁移，再启动接口进程 |
| `worker` | 等迁移与代码一致，再启动渲染 worker 的调度进程；现在只提供健康检查 |
| `setup` | 建桶，属于部署步骤。运行时的服务只用读、写、取头信息、列举 |
| `build-id` | 输出渲染器构建标识 |

**健康检查**：接口进程与 worker 都有两个端点。

- `GET /healthz`：存活，返回服务名与构建标识。
- `GET /readyz`：就绪。要求数据库可连、迁移与代码一致、对象存储可列举；否则返回 503，并列出没通过的检查项与原因，不带连接串或凭据。

**日志**：每行一个 JSON 对象，带时间、级别、服务名（`api`、`worker`、`setup`）与构建标识；请求头里的凭据会被遮盖。

## 数据库迁移

- **写法**：迁移是 `service/migrations/NNNN_名称.sql`，版本号从 1 连续递增，只追加，不修改已执行的文件。
- **执行**：接口进程启动时，在咨询锁下按版本号逐个执行，每个迁移一个事务，并记下文件的 SHA-256。
- **检查**：worker 启动时只检查，等到迁移执行完再就绪。
- **拒绝启动**：已执行的迁移被改过，或数据库有代码不认识的版本时，两种进程都拒绝启动。

## 存储布局

依据 ADR-0018、ADR-0019：

- **对象**：内容按 SHA-256 存在租户前缀下，键是 `tenants/<租户>/blobs/sha256/<哈希>`。同一租户内相同字节只存一份，跨批次也是；不同租户各存一份。
- **提交**：先写对象，再在一个数据库事务里登记。没登记的对象不会被读到；v1.0 不回收它们。
- **工作区文档**：按原始字节存，数据库只记来源、哈希与字节数。读出时按登记的哈希核对。
- **资源仓库**：语义与 `renderweave-resources/1` 相同，由引擎的 `resourceBackend` 统一负责（M260）。
  - 同一租户的提交锁住一行依次进行，清单只追加；
  - 读取时引擎核对字节数与哈希。
- **出图记录**：
  - 一项的全部文件与完成清单在一个事务里登记，"批次加项序号"唯一，同一项不会登记两次；
  - 批次清单在全部项结束后登记；
  - 记录与批次的读取、重放用引擎的同一组函数。
- **租户隔离**：每张租户表都带 `tenant_id`，存储句柄只生成本租户的键与查询条件。行级安全与应用账号随租户与鉴权一起开启。

## 构建标识与镜像

- **算法**：渲染器构建标识按引擎文件、锁文件与实际安装的生产依赖计算（ADR-0013）。
- **镜像里的标识**：构建镜像时，把它写进 `/app/BUILD_ID`，启动脚本据此打标签。
- **与本机一致**：2026-10-19 实测，Windows 本机构建的引擎与镜像里的引擎得到同一个构建标识。所以服务交出的记录导出后，能用本机的 `renderweave replay` 重放（ADR-0019）。

## 测试

- **`npm test`**：不需要 Docker。共用的存储合同用例在 `test/support/storage-contract.ts`，本地与内存两种实现在 `test/storage-contract.test.ts` 里跑。
- **Docker 后端测试**：从空环境起全部服务，在 Compose 网络里的 tester 容器中跑 `service/test`，再核对服务日志每行都是合格的 JSON。默认前后都清空容器与数据卷，加 `--keep` 保留。

```bash
node service/scripts/test-docker.mjs
```

Docker 后端测试覆盖以下内容：
- PostgreSQL 加 S3 实现跑同一组合同用例；
- 对象键与去重、文档原文、事务提交点、并发提交与同一项只登记一次；
- 迁移的顺序、回滚与启动检查；
- 健康检查、未就绪时的响应与结构化日志；
- 配置只从环境变量读取。
