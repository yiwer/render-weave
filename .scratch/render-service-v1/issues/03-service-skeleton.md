# 03: 一条 Docker Compose 命令从空环境起出图服务，PostgreSQL 加 S3 的存储通过合同测试

**What to build:** 服务目录、Docker Compose 编排（接口进程、worker、PostgreSQL、S3 兼容存储）、数据库迁移、健康检查，以及 PostgreSQL 加 S3 的存储接口实现。

**Blocked by:** 01

**Status:** ready-for-agent

**Trace:** [阶段 4 PRD](../spec.md)「服务结构」「部署与运维」；用户故事 43、44；验收 A02、A12；ADR-0017、ADR-0018、M240。

- [ ] 服务代码放在仓库内单独的服务目录，不进引擎源码目录，只经引擎的公开入口调用。
- [ ] `docker compose up` 能从空环境起接口进程、一个 worker、PostgreSQL 和一个 S3 兼容存储。数据库迁移按版本号顺序执行，启动时检查。
- [ ] 凭据只经环境变量传入，不写进镜像和仓库。
- [ ] 接口进程与 worker 都有健康检查，日志是结构化的。
- [ ] PostgreSQL 加 S3 的存储实现接进票据 01 的合同测试，全部通过：
  - 提交点是数据库事务，对象先写、再登记；
  - 文档按原始字节存；
  - 内容按 SHA-256 寻址，键放在租户前缀下。
- [ ] 服务只用 S3 的基础对象操作：读、写、取头信息、列举。
- [ ] Docker 后端测试的运行方式写进[开发环境与接续](../../../docs/dev-setup.md)，与 Linux 全量测试并列。`npm test` 不需要 Docker。
- [ ] 镜像用构建标识打标签。
- [ ] HTTP 框架等选型决定记 M 编号。

**测试接缝：** 存储接口合同测试（Docker 后端）与健康检查端点。
