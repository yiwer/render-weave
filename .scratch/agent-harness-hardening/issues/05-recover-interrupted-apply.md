# 05: 应用中断后恢复完整工作区，重试不重复发布

**What to build:** 为本地应用保存可恢复的提交依据，让提交中强退后得到完整旧状态或新状态，并对成功提交提供幂等重试。

**Blocked by:** 04

**Status:** resolved

**Trace:** [父规格](../spec.md)；D03、D09；US16、US13（中断后的读取一致性）、US63（本票应用记录兼容）；A05（提交中断、恢复前读取、完整恢复、重复应用及外部新改动子项）；A20（本票合同、资料及兼容子项）。遵守 ADR-0023。

本票处理应用提交，轮次执行和候选检查点的恢复归 08、09；不以 Agent 运行状态推断应用成功，不新增服务端事务实现。

- [x] 应用提交前保存足以辨认提交意图、旧/新内容身份和最终结果的可恢复依据；涉及数据定义发布、数据集/模板写入及应用结果时，恢复覆盖整次应用，不能只恢复其中的模板文件。
- [x] 在提交尚未开始时强退，工作区保持原样；在多文件提交过程中强退，恢复后是完整旧状态或完整新状态，并明确显示未提交或已提交，不能留下部分成功。
- [x] 强退后尚未完成恢复时，公开渲染、审核与应用必须先恢复、等待或明确返回需要恢复；它们不能取得混合输入，也不能把“存在部分新文件”解释为成功。
- [x] 对同一已经成功的提交标识重复应用或在成功回应前中断后重试，返回可核对的已有结果；不重复发布数据定义版本、不重复保存候选、不产生第二次业务提交。
- [x] 恢复发现工作区已有不属于本次提交的外部新修改时，停止并列出冲突；保留新内容和诊断，不用旧备份覆盖，未经冲突处理不宣称恢复完成。
- [x] 同一未完成提交遭遇两个恢复者或恢复与重试并发时，操作协调同一提交边界，最终结果唯一；反复恢复能够收敛，正常合法提交与恢复后的公开读取仍能完成。
- [x] 提交记录和审核依据保持可追溯，恢复不补造历史批准；未批准候选及宿主恢复草稿仍不能直接应用。新记录明确辨认未完成提交，旧成功记录按已有可证事实读取，不误识别为待重做提交。
- [x] 中断验收覆盖宿主强退和可控提交中断，并记录恢复前后工作区与正式出图结果；不将逐文件替换或进程内异常撤回宣称为已覆盖强退，也不声称可保证任意存储断电持久性。
- [x] 更新应用/恢复结果合同、操作资料和新旧记录兼容说明；相关既有应用回归及 04 的并发行为通过，涉及行为变化时按既有约定升版。

**测试接缝：** 从公开 Agent 应用 CLI 启动提交并终止受测宿主，随后经公开渲染、审核、应用入口观察阻断与恢复；核对工作区内容、数据定义发布版本、正式图片、退出码和结果记录。中断接缝只放在整个提交/资源边界，不检查私有写入调用顺序。真实模型最终证据归统一验收活动，本票以确定性故障验收关闭。必要预重构先保持现有测试通过，不另建通用工作流或数据库框架。

## Answer

完成日期：2026-10-23。

已完成整次本地应用的持久提交、强退恢复和幂等结果，遵循 ADR-0023；新增平台取舍记为 M318。尚未准备提交时保持完整旧状态；已准备且没有外部冲突的提交恢复为完整新状态。未恢复完成的读取不会取得混合输入。

- `src/local-commit.ts` 保存 `renderweave-apply-intent/1`：整次应用全部文件的旧/新字节与哈希、工作区基线、轮次/成果/批准守卫和最终应用结果。先发布参与目录指针，再写业务文件，最后原子发布完成凭据。恢复核对全部参与者后前滚；发现第三种内容、额外/缺失文档或批准依据变化时返回冲突并保留内容，不用旧备份覆盖。
- `src/local-access.ts` 在 04 的共同短时边界外增加 OS 互斥：Windows 命名管道、Linux abstract Unix socket，宿主与恢复者强退后自动释放。磁盘拥有者与租约保留诊断，仅在同宿主、租约过期且确认进程死亡后整体移走旧锁；未知拥有者及旧版空锁保守阻断。取得约束前后均发现恢复参与目录，取得全部约束后才恢复和开放读取。模型与耗时渲染继续在边界外执行。
- `src/agent/review.ts` 的新成功记录为 `renderweave-applied/2`，带 `commitId`；同一轮同目标重试返回原结果和 `reused: true`，不增加版本。新凭据绑定实际轮次及当前批准/成果，复制其他轮次的凭据不能冒充成功；历史 `/1` 记录仍按已有成功事实读取，不补造新凭据。CLI 返回可核对的 `status: committed`、提交标识与原应用时间。
- 公开工作区、资源、审核与应用入口在需要时先恢复；外部冲突返回 `apply.recoveryRequired`，占用返回 `local.storeBusy`。相关代码包括 `src/cli.ts`、`src/problems.ts`、`src/versioned-resources.ts`。`src/agent/provenance.ts` 在进入目录前排除临时锁/释放/回收元数据，`scripts/agent-eval/identity.ts` 在共同读取边界内固定资源身份，避免协调活动成为虚假的实验输入变化。
- 操作资料和兼容边界更新到 `docs/agent-tasks.md`、`docs/resources-versioning.md`、`docs/mcp.md`、`docs/adr/0023-authoring-check-and-commit-identity.md`；MCP 合同升至 **0.12.1**，保留已集成的 0.12.0 变更说明。07 的评估报告 `/4` 保持不变。

`test/agent-apply-recovery.test.ts` 的 12 个公开验收用例覆盖：

| 中断与对照 | 恢复前后可观察结果 |
| --- | --- |
| 整个资源提交边界被占用时终止应用宿主 | 尚未提交；工作区字节保持原样，解除占用后合法应用成功 |
| 实际 CLI 发布 20 份定义时强退 | 终止时确有部分新文档；公开读取恢复全部 40 份定义/Schema 文件，20 个版本均为 v1，原正式出图不变 |
| 实际 CLI 保存 20 份数据集时强退 | 公开读取恢复全部数据集；正式出图使用恢复后的完整数据 |
| 实际 CLI 替换 16 份关联模板时强退 | 恢复全部替换；正式图片不同于修改前，并与强退前独立渲染的核准候选图片一致 |
| 成功完成但调用方尚未收到回应时终止宿主 | 重试返回相同提交标识与原结果，文件字节和版本不增加 |
| 外部修改一个已涉及文件 | 公开读取、审核、应用均报告需要恢复并保留外部内容；处理冲突后恢复收敛 |
| 恢复者再次强退、两个实际 CLI 恢复者及恢复/重试并发 | 最终完整结果唯一；两个 CLI 成功结果具有相同提交标识 |
| 新凭据缺失/冒用、旧成功记录、旧版未知空锁 | 新凭据拒绝，历史事实可读，未知锁阻断；不补造批准或把残留候选当作成功 |

验证记录：

- 红绿循环先观察到重复应用被旧行为拒绝、强退残留不能恢复，再实现持久意图；复核补出的“复制 A 的凭据到 B”反例先失败，绑定当前轮次与三份依据后通过。回收和释放均改为在 OS 互斥中整体移走锁目录，消除回收者强退留下活动空锁的窗口。
- Windows Node **v24.12.0**：`npx vitest run --maxWorkers=2`，**66 个文件通过、1 个跳过；1152 项通过、13 项跳过**。此轮包括 05 新增 12 项及全部既有回归。此前全量发现的临时锁误入资料身份已修复，独立 `test/agent-eval-identity.test.ts` 15 项通过后完成上述全量；已有 Windows 故障模拟限定在资源清单边界，避免误伤新锁初始化。
- Linux Docker Node **v22.23.3**：`vitest run test/agent-apply-recovery.test.ts test/agent-concurrency.test.ts test/agent-review.test.ts test/agent-rounds.test.ts test/resource-replacement.test.ts --maxWorkers=1`，**5 个文件、77 项通过、2 项平台条件跳过**；随后 `vitest run test/agent-eval-identity.test.ts test/mcp.test.ts --maxWorkers=1`，**2 个文件、47 项通过**。使用 `renderweave-service-test:local` 内 Linux 依赖实际执行，未复用 Windows 原生模块。
- Windows 原生 `node:net` 同名命名管道双持有者探针，第二次监听返回 **EADDRINUSE**；Linux Node 22 的并发及强退验收通过，验证 M318 使用的两种平台互斥。
- 合入包含 07 的集成 `0a4fb70`（合并提交 `adce6a7`）后，`npx vitest run test/agent-apply-recovery.test.ts test/agent-concurrency.test.ts test/agent-eval.test.ts test/agent-eval-identity.test.ts test/agent-eval-attempts.test.ts test/agent-eval-attempts-cli.test.ts --maxWorkers=2`：**6 个文件、69 项全部通过**。
- `npm run typecheck`、`npm run build`、`git diff --check`：通过。只读集成复核提出的锁回收窗口与跨轮次凭据两项均已修复并复核通过。

验收偏差：无。保证限定同宿主 Windows/Linux 上遵守共同边界的产品入口；不宣称介质断电、网络文件系统、混跑旧版本或任意直接改盘的事务保证。08/09 的执行与检查点恢复不归本票，未调用真实模型。`CONTEXT.md` 由集成方统一更新。

集成复核（2026-10-23）：分支最终提交 `444e306` 已以 `7b4c813` 保留历史合入集成分支。补齐与 07 的联动：`scripts/agent-eval/attempts.ts` 在进入目录前，按 `materialHashes` 相同规则排除 `.write-lock*`、`.write-released*`、`.write-abandoned*` 协调目录；只排除目录，普通同前缀文件继续封存，链接继续拒绝。公开评估反例先因协调残留报“尝试原件已改变”，修复后残留拥有者/租约变化不改变尝试与成本，普通业务文件变更仍拒绝。

- `npx vitest run test/agent-eval-attempts.test.ts -t '应用锁初始化释放' --maxWorkers=1`：新增反例红绿通过。
- `npx vitest run test/agent-apply-recovery.test.ts test/agent-concurrency.test.ts test/agent-eval-attempts.test.ts test/agent-eval-attempts-cli.test.ts test/agent-eval-identity.test.ts --maxWorkers=1`：主工作树 5 个文件、48 项全部通过（147.68 秒）。
- `npm run build`、`npm run typecheck`、`git diff --check` 通过；两份既有未跟踪评估报告保持不变。
