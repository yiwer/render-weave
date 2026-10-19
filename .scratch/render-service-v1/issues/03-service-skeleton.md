# 03: 一条 Docker Compose 命令从空环境起出图服务，PostgreSQL 加 S3 的存储通过合同测试

**What to build:** 服务目录、Docker Compose 编排（接口进程、worker、PostgreSQL、S3 兼容存储）、数据库迁移、健康检查，以及 PostgreSQL 加 S3 的存储接口实现。

**Blocked by:** 01

**Status:** resolved

**Trace:** [阶段 4 PRD](../spec.md)「服务结构」「部署与运维」；用户故事 43、44；验收 A02、A12；ADR-0017、ADR-0018、M240。

- [x] 服务代码放在仓库内单独的服务目录，不进引擎源码目录，只经引擎的公开入口调用。
- [x] `docker compose up` 能从空环境起接口进程、一个 worker、PostgreSQL 和一个 S3 兼容存储。数据库迁移按版本号顺序执行，启动时检查。
- [x] 凭据只经环境变量传入，不写进镜像和仓库。
- [x] 接口进程与 worker 都有健康检查，日志是结构化的。
- [x] PostgreSQL 加 S3 的存储实现接进票据 01 的合同测试，全部通过：
  - 提交点是数据库事务，对象先写、再登记；
  - 文档按原始字节存；
  - 内容按 SHA-256 寻址，键放在租户前缀下。
- [x] 服务只用 S3 的基础对象操作：读、写、取头信息、列举。
- [x] Docker 后端测试的运行方式写进[开发环境与接续](../../../docs/dev-setup.md)，与 Linux 全量测试并列。`npm test` 不需要 Docker。
- [x] 镜像用构建标识打标签。
- [x] HTTP 框架等选型决定记 M 编号。

**测试接缝：** 存储接口合同测试（Docker 后端）与健康检查端点。

## Answer

2026-10-19 完成。决定见 M259（选型）与 M260（资源仓库的持久层构件），说明见[出图服务](../../../docs/service.md)。

**成果**

- **服务目录**：`service/` 自成一个 npm 包，有自己的锁文件。
  - 只经 `service/src/engine.ts` 引用引擎构建出的 `dist/index.js`，服务依赖不进引擎的 `npm ci`，也不进构建标识。
  - 选型：Fastify 5、node-postgres、AWS SDK v3（S3）与 pino。
- **编排**：仓库根的 `compose.yaml` 起五个服务：
  - PostgreSQL 17；
  - RustFS 1.0.3（MinIO 社区版镜像已从 Docker Hub 下架）；
  - 建桶步骤 `setup`；
  - 接口进程 `api` 与一个 `worker`。

  `node service/scripts/up.mjs` 一条命令完成：生成随机凭据到不进版本库的 `.env`，构建，等全部就绪，再以构建标识打镜像标签。
- **迁移**：`service/migrations/0001_storage.sql` 建租户、工作区文档、资源仓库、批次与记录各表，都带 `tenant_id`。执行器的规则：
  - 接口进程启动时在咨询锁下按版本号执行，每个迁移一个事务，记下文件哈希；
  - worker 只检查；
  - 改过的迁移，或数据库里代码不认识的版本，都拒绝启动。
- **健康检查与日志**：两种进程都有 `/healthz`（存活）与 `/readyz`（数据库、迁移、对象存储）。未就绪返回 503，列出检查项与原因，不带凭据。日志每行一个 JSON，带服务名与构建标识。
- **PostgreSQL 加 S3 的存储实现**（`service/src/storage.ts`）：
  - 对象键是 `tenants/<租户>/blobs/sha256/<哈希>`；
  - 先写对象、再在事务里登记；
  - 文档按原始字节存，读出时核对哈希；
  - 一项的成果在一个事务里登记，"批次加项序号"唯一。
- **引擎侧**：
  - 新增 `resourceBackend(storage)`：核对、版本递增与问题码由引擎统一负责，持久层只管放内容与原子提交；内存实现改用它（M260）；
  - 导出 `manifestBytes`、`itemDirectory`、`rendererBuildId`；
  - 合同用例移到 `test/support/storage-contract.ts`，三种实现共用。
- **文档**：新增[出图服务](../../../docs/service.md)；[开发环境与接续](../../../docs/dev-setup.md)加了 Docker 后端测试，与 Linux 全量测试并列；[存储接口](../../../docs/storage-interfaces.md)、需求记录 M259–M260、`CONTEXT.md`。

**范围之外，留给后续票据**：
- 行级安全与应用账号，随票据 04 开启；
- 任务队列、渲染子进程与超时，随票据 06。

**验证**

- **Docker 后端测试**：`node service/scripts/test-docker.mjs`。从清空容器与数据卷的空环境构建并起服务，tester 容器中 4 个文件、23 项通过；之后核对服务日志，6 行都是合格的 JSON。覆盖：
  - PostgreSQL 加 S3 跑共用的 7 项合同用例；
  - 键在租户前缀下且同一租户按哈希去重、文档原文与哈希核对、提交前条件失败时对象已写但清单不变、同一租户的 3 个并发追加只成功 1 个、同一项不能登记两次；
  - 迁移：仓库迁移连续编号并全部执行、再次启动不重复执行、按顺序执行、编号不连续拒绝加载、失败的迁移整体回滚、改过的迁移与未知版本拒绝启动、worker 等待迁移完成；
  - 健康检查：两种进程的存活与就绪、构建标识一致；对象存储或数据库不可用时 503，响应里没有凭据；日志格式；
  - 配置缺少变量时只报变量名。
- **一条命令启动**：`node service/scripts/up.mjs` 输出接口进程与 worker 的地址、构建标识与镜像标签。从宿主机访问两边的 `/readyz`，都是 ready，数据库版本 1。停掉对象存储后接口进程转为 503（"对象存储不可用"），恢复后回到 200。
- **构建标识**：镜像标签是 `renderweave-service:sha256-3d689b75…`，与 Windows 本机构建的引擎算出的标识相同。所以服务交出的记录导出后，能用本机命令行重放。
- **没有凭据泄露**：
  - 镜像的环境变量只有 `PATH`、`NODE_VERSION`、`YARN_VERSION`、`NODE_ENV`；
  - `.env` 被忽略，也不在 Linux 打包清单里；
  - `scan-keys` 扫描 355 个文件，命中 0；
  - 本机生成的 3 项凭据在全部 536 个待提交文件中命中 0。
- **引擎**：
  - Windows：`npm run typecheck`、`npm run build` 通过，`npm test` 41 个文件、824 项通过，项数不变（合同用例搬家后仍是 14 项）；
  - 服务：用引擎同一版本的 TypeScript 做类型检查，包括测试，通过。
  - Linux（`node:22-alpine`，从 tar 在空目录安装）：构建、类型检查通过，820 项通过，4 项 Windows 专用用例跳过。Docker 后端那组本身就在 Linux 容器里跑。

