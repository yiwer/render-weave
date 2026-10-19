# 阶段 4 票据：出图服务第一版（v1.0）

本页只维护索引：标题、直接阻塞与验收映射。状态以各票据的 `**Status:**` 行为准，验收记录写在各票据的 `## Answer`。

父规格：[阶段 4 PRD：出图服务第一版（v1.0）](spec.md)。

| 票据 | 完整行为 | 直接阻塞 | 规格验收 |
|---|---|---|---|
| 01 | [引擎经接口访问工作区文档、资源仓库与出图记录，命令行行为不变](issues/01-storage-interfaces.md) | 无 | A01、A02 |
| 02 | [批量项与单次渲染对同一问题给出同一问题码](issues/02-batch-problem-codes.md) | 无 | A01、A06 |
| 03 | [一条 Docker Compose 命令从空环境起出图服务，PostgreSQL 加 S3 的存储通过合同测试](issues/03-service-skeleton.md) | 01 | A02、A12 |
| 04 | [平台管理员开通租户与成员，成员登录并管理 API 密钥，租户之间互相看不到](issues/04-tenants-and-auth.md) | 03 | A03、A04 |
| 05 | [代建工程师用一条命令把本地工作区与资源推送到客户的租户](issues/05-authoring-push.md) | 04 | A05 |
| 06 | [经渲染 worker 进程同步出草稿预览，超时与内存超限的渲染被结束，worker 自动恢复](issues/06-draft-preview-and-workers.md) | 05 | A06、A07 |
| 07 | [经开放 API 异步批量正式交付，逐项提交出图记录，可查进度、可取消](issues/07-batch-delivery.md) | 02、06 | A06、A08 |
| 08 | [查询与导出出图记录，导出包能离线重放；服务端重放按构建标识找确切构建](issues/08-records-export-replay.md) | 07 | A08 |
| 09 | [按月额度计量正式交付张数与代建 token，额度不够整批拒绝](issues/09-metering-and-quotas.md) | 07 | A09 |
| 10 | [经开放 API 管理数据集与图片、字体资源，替换资源前先看影响](issues/10-datasets-and-resources-api.md) | 05 | A06 |
| 11 | [开放 API 有可快照的 OpenAPI 合同，批次结束时发带签名的 webhook](issues/11-api-contract-and-webhooks.md) | 08、09、10 | A06、A10 |
| 12 | [客户在出图控制台用表单填数据、调参数、看预览，然后批量交付并下载](issues/12-console-form-preview-delivery.md) | 08、10 | A11 |
| 13 | [客户从 Excel 导入一批数据，逐行看到问题，确认后再交付](issues/13-console-excel-import.md) | 12 | A11 |
| 14 | [客户在控制台查询与导出出图记录、查看用量，管理员管理成员、密钥、资源与 webhook](issues/14-console-records-usage-admin.md) | 11、12 | A11 |
| 15 | [容量基线与阶段 4 验收](issues/15-capacity-and-acceptance.md) | 13、14 | A01–A12 |

已检查：48 条用户故事全部覆盖；A01–A12 全部覆盖；依赖编号有效、无环、无冗余的传递边。

- 01、02 没有前置阻塞，可以并行开始。02 只改引擎，与 01 改的存储部分基本不重叠。
- 05 之后，06 与 10 可以并行；07 之后，08 与 09 可以并行。
- 存储接口（01）是全部服务票据的地基，本地行为不变是硬约束：现有测试一行不改、全部通过。
- 按阻塞关系领取票据：直接阻塞的票据全部 `resolved` 后才能开始。
