# 01: 引擎经接口访问工作区文档、资源仓库与出图记录，命令行行为不变

**What to build:** 把引擎里绑死本地文件的三处存储抽成接口，批量交付拆成"固定"与"交付单项"两步；本地文件实现保持现有行为，另加内存实现。

**Blocked by:** 无

**Status:** resolved

**Trace:** [阶段 4 PRD](../spec.md)「存储接口」；用户故事 32；验收 A01、A02；ADR-0018、ADR-0019。

背景：渲染入口只接收内存中的工作区，不碰存储。还直接读写本地文件的是三处（ADR-0018「引擎经接口访问存储」）：

- 工作区文档的读取；
- 版本化资源仓库；
- 批量交付、记录读取、批次读取与重放。

- [x] 三处存储各有一个不依赖框架的接口，从引擎的公开入口导出。本地文件实现与内存实现都实现这些接口。
- [x] 批量交付拆成两步，从公开入口导出：
  - **固定**：校验外层，固定文档与资源版本，得到可以序列化的批次快照；
  - **交付单项**：按批次快照渲染一项，产出记录内容，经接口提交。
  
  命令行的 `deliver` 按顺序调用这两步。
- [x] M153 的批次语义不变：外层非法整批拒绝；单项失败不影响其他项；运行中的修改不混入本批；取消在项与项之间生效。
- [x] 存储接口合同测试：同一组用例跑本地与内存两种实现，覆盖：
  - 资源版本的提交与预期版本冲突；
  - 批次快照往返；
  - 记录的提交与读取；
  - 完整性核对失败。
- [x] 现有测试一行不改、全部通过（A01），以下都不变：
  - 命令行的文件布局、退出码、同批硬链接去重与重放结果；
  - M402 共享样例、golden 与布局快照。
- [x] 全量测试、类型检查、构建在 Windows 与 Linux 上通过；决定记 M 编号。

**测试接缝：** 引擎的公开入口。合同测试按实现参数化，票据 03 再把 PostgreSQL 加 S3 的实现接进同一组用例。

## Answer

2026-10-19 完成。决定见 M250，说明见[存储接口](../../../docs/storage-interfaces.md)。

**成果**

- **工作区文档**：
  - 新增 `WorkspaceDocumentSource` 接口，以及 `localWorkspaceDocuments`、`memoryWorkspaceDocuments` 两种来源；
  - `readWorkspaceDocuments` 统一负责归类、精度检查与重复检查；
  - `loadWorkspaceDocuments` 改为调用它加本地来源。
- **版本化资源仓库**：
  - 新增 `ResourceVersionBackend` 接口（`open`、`commit`），以及本地实现 `localResourceBackend` 与内存实现 `createMemoryResourceBackend`；
  - 只读快照改为按各实现自己的方式取内容，读取时仍一律核对字节数与哈希；
  - 导入、替换检查与应用替换保持原实现。
- **出图记录**：
  - 新增 `freezeBatch`、`deliverBatchItem`、`runFrozenBatch`、`summarizeBatch`、`readRecord`、`replayRecord` 与 `readBatchFrom`；
  - 新增三个接口 `BatchOutput`、`RecordSource`、`BatchSource`，本地与内存实现放在新模块 `src/record-stores.ts`；
  - `deliverBatch`、`readOutputRecord`、`replayOutputRecord`、`readBatch` 改为调用这些接口加本地实现。
- **文档**：
  - 新增[存储接口](../../../docs/storage-interfaces.md)，从出图记录说明与资源版本说明链接过去；
  - 需求记录 M250、`CONTEXT.md`，以及[开发环境与接续](../../../docs/dev-setup.md)里的期望测试数。

**验证**

- **先写失败的测试**：`test/storage-contract.test.ts` 按实现参数化，本地与内存各 7 项。实现前全部失败（接口不存在），实现后全部通过。覆盖：
  - 工作区文档与从本地目录加载的一致；
  - 资源整批提交、按预期版本追加；重复新建、版本过期、资源不存在、提交前条件失败时，整批不生效，已打开的快照不变；
  - 资源内容被改动时，读取报完整性问题；
  - 批次快照 JSON 往返后交付单项，结果与原快照相同；
  - 整批交付后读批次、读记录、重放，单项失败不影响其他项；
  - 记录文件被改动时，读取与重放都报完整性问题；
  - 批次清单发布前，按完成清单辨认已交付的项。
- **兼容**：现有测试文件一行未改，全部通过；golden、布局快照与 M402 共享样例都没有更新。
- **Windows**：`npm run typecheck`、`npm run build` 退出码 0；`npm test` 40 个文件、803 项通过（原 789 项加新增 14 项）。
- **Linux**（`node:22-alpine`，从 tar 在空目录安装）：799 项通过，4 项 Windows 专用用例跳过。
- **验收脚本**（基于构建产物，输出在 `out/t01/`）：以下 7 个全部退出码 0。
  - `accept-batch`、`accept-batch-cancel`；
  - `accept-output-record`、`accept-record-closure`；
  - `accept-versioned-resources`、`accept-resource-replacement`；
  - `accept-long-batch`。
- **千项长批次**：1,375.5 秒；RSS 中位数 427.2 → 428.5 MiB（+1.3），峰值 490.8 MiB；磁盘实际占用 612 MiB，与第二阶段相同，硬链接去重照常。
- **RSS 绝对值偏高的原因**：比第二阶段高，是因为这次与 Linux 容器测试同时运行。在同一台机器上，用改动前与改动后的构建各跑 100 项做对照，改动没有带来差别：

  | 构建 | RSS 中位数 | 峰值 | 耗时 |
  |---|---|---|---|
  | 改动前 | 321.5 → 323.0 MiB | 343.8 MiB | 102.4 秒 |
  | 改动后 | 322.0 → 324.7 MiB | 343.8 MiB | 102.5 秒 |
