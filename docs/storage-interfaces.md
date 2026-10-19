# 存储接口

阶段 4 [票据 01](../.scratch/render-service-v1/issues/01-storage-interfaces.md)把引擎里绑死本地文件的三处存储抽成接口（ADR-0018）：

- 工作区文档的读取；
- 版本化资源仓库；
- 出图记录，包括交付、读取、批次读取与重放。

渲染入口 `render` 本来就只接收内存中的工作区，不受影响。

接口有两种实现：

- **本地文件**：命令行的后端，文件布局、退出码与行为都不变；
- **内存**：供测试与服务端的快速测试使用。

服务端还有第三种实现：PostgreSQL 加 S3，在 `service/` 里（票据 03，见[出图服务](service.md)）。三种实现跑同一组合同用例，用例在 `test/support/storage-contract.ts`：本地与内存在 `npm test` 里跑，PostgreSQL 加 S3 在 Docker 后端测试里跑。

接口都从 `dist/index.js` 导出，不依赖任何框架。

## 工作区文档

| 接口 | 语义 |
|---|---|
| `WorkspaceDocumentSource` | `location` 是位置说明；`list()` 按来源排序列出文档，每份文档有 `source` 与按需读取原始字节的 `read()` |
| `localWorkspaceDocuments(dir)` | 本地目录，目录下的每个 `.json` 文件是一份文档 |
| `memoryWorkspaceDocuments(documents, location?)` | 内存中的原始字节 |
| `readWorkspaceDocuments(source)` | 读出并归类全部文档：数据定义、编译产物、模板、数据集。精度检查（M112）与重复检查都在这里统一做；`loadWorkspace` 与 `loadWorkspaceDocuments` 就是它加本地来源 |

来源只负责给出原始字节，所以服务端按原始字节保存文档（ADR-0018），读出的结果与本地目录一致。

## 版本化资源仓库

| 接口 | 语义 |
|---|---|
| `ResourceVersionBackend.open()` | 打开清单快照，即 `VersionedResourceStore`。后续提交不影响已打开的快照，读取时一律核对字节数与 SHA-256 |
| `ResourceVersionBackend.commit(changes, { beforeCommit? })` | 按顺序整批提交，见下文 |
| `localResourceBackend(dir)` | 本地版本仓库，须先 `initializeResourceStore`；提交沿用写锁加重命名清单（ADR-0014） |
| `createMemoryResourceBackend({ contents? })` | 内存仓库，内容按 SHA-256 存放；可传入自己的内容表，以便检查或改动底层字节 |
| `resourceBackend(storage)` | 在一个持久层上实现仓库（M260）。持久层 `ResourceManifestStorage` 只管三件事：读清单快照、放内容（`place`）、原子提交新清单（`commit`）。核对变更、版本递增、问题码与提交前条件由引擎统一负责。内存仓库与服务端仓库都用它 |

`commit` 的语义：

- **两种变更**：
  - `create`：新建资源，内容版本为 1；
  - `append`：按 `expected`（预期的当前版本、SHA-256 与字节数）追加一个内容版本。
- **整批生效或整批不生效**：任一变更不满足条件，整批都不生效。
  - 新建已有的 ID 报 `input.duplicate`；
  - 预期版本过期或资源不存在报 `resource.replacementStale`。
- **beforeCommit**：在内容写好、发布之前调用，抛错就整批撤回。

`importResources`、`checkResourceReplacement` 与 `applyResourceReplacement` 仍是本地流程，行为不变。

## 出图记录

批量交付拆成两步，服务端可以把各项分给不同的 worker（ADR-0017）：

| 接口 | 语义 |
|---|---|
| `freezeBatch({ workspace, resources, request, renderOptions? })` | **固定**：校验外层，复制文档、渲染项与配置，固定资源版本映射，并核对固定版本的字节。返回 `BatchSnapshot` 和已核对的资源内容；外层非法等情况整批拒绝。无法展开的项与根模板，问题清单与单次渲染相同（M258） |
| `deliverBatchItem({ snapshot, index, contents, output })` | **交付单项**：按快照渲染第 `index` 项，经 `output` 写入成果；`writeFailed` 表示没能写入 |
| `runFrozenBatch({ snapshot, contents, output, onItem?, signal? })` | 在一个进程内按顺序交付全部项，写入失败后探测存储，项间取消，最后发布批次清单 |
| `summarizeBatch(snapshot, items, problems)` | 由逐项结果汇总批次清单（`batch.json` 的内容） |
| `readRecord(source)`、`replayRecord(source)` | 读取记录并核对完整性；重放并比对成果，返回重新生成的文件与 `replay.json` 的内容，由调用方决定写到哪里 |
| `readBatchFrom(source)` | 辨认批次：清单已发布即运行已结束，没有时按各项的完成清单辨认 |

- **`BatchSnapshot`** 的格式是 `renderweave-batch-snapshot/1`，可以序列化为 JSON。它不含资源字节：
  - 交付单项时，按固定版本经 `contents(info)` 取资源字节；
  - 在同一进程内交付时，用 `freezeBatch` 返回的已核对内容；
  - 在别处交付时，从版本仓库按版本读取，读取本身会核对完整性。
- **三个存储接口**：
  - `BatchOutput`：`location`、`write`、`available`、`finish`；
  - `RecordSource`：`read(file)`；
  - `BatchSource`：`manifest`、`items`、`completion`。
- **本地实现**：`createLocalBatchOutput(outDir)`（目录已存在即失败）、`localRecordSource(dir)`、`localBatchSource(dir)`。
- **内存实现**：`createMemoryBatch()`，同一份内容既是成果去处，也是批次与记录的读取来源。
- **写法一致**：完成清单与批次清单的字节由 `manifestBytes` 生成，项目录名由 `itemDirectory` 生成，各实现写法相同。

`deliverBatch`、`readOutputRecord`、`replayOutputRecord` 与 `readBatch` 就是这些接口加本地实现，行为与[出图记录说明](output-records.md)一致。
