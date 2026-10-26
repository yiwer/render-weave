# Agent 整轮预算、取消与停止保存

`agent run` 在固定输入准备完成后、执行器启动前显示本轮生效时间和轮数。墙钟缺省 **3600000 毫秒（60 分钟）**；数据定义和数据集提取保留 40 轮，模板设计和修改保留 80 轮。`--timeout-ms` 接受有限正数，`--max-turns` 接受正整数。非法配置在启动执行器之前拒绝。

```powershell
node dist/bin.js agent run --task template-design --sample sample.png --brief brief.md --resources resources --workspace workspace --dataset ds-sign --request request.json --out out/round-1 --timeout-ms 120000 --max-turns 20
```

公开 API 的对应选项为 `roundTimeoutMs`、`maxTurns` 和 `signal: AbortSignal`；`onBudget(runtime)` 在固定输入准备完成后通知生效值。CLI 的 Ctrl+C、SIGTERM 进入同一取消路径。时间覆盖模型等待、工具等待、执行器退出后的终检和本地收尾；输入校验和快照准备不计入墙钟。生效值写入 `round-start.json.runtime` 与 `round.json.runtime`。历史启动记录没有 runtime 时继续按旧身份读取，不补造历史预算。

## 可执行的停止边界

轻量监督进程只管理时限、信号、所属进程树和停止保存宽限。业务宿主仍负责固定资料、代理、受管 MCP、检查点、比较和终检，不另写模型工具循环。同步渲染阻塞业务宿主的事件循环时，监督器仍可停止它。Windows 按本轮仍存活宿主的 PID 调用系统 `taskkill /T /F`；Linux 为每轮创建独立进程组并定向结束该组。不会按进程名结束所有 Node 或 Claude 进程，也不会结束另一合法轮次。

墙钟到达、用户取消或明确硬额度后，先停止所属运行子树，停止新请求，再最多给予 **30000 毫秒**的本地保存宽限。保存也处于单独可终止进程中；它只读取已提交检查点、保留诊断字节与记录，不重新渲染。达到宽限即终止保存，留出操作系统结束进程的调度余量。时间断言不承诺精确到毫秒。远端已经接收的请求可能继续执行或计费，本地结束不承诺上游即时停止计费。

确认进程树已结束也有期限：`taskkill` 返回与宿主退出各最多等 **30000 毫秒**（Windows 空闲时 `taskkill /T` 就要 3.5–4 秒，负载高时更久）。确认不了时监督器写 `cleanup.json`、断开与宿主的 IPC，宿主断开后自行回收它的子树，命令不再等待。成功轮次此时已提交最终记录，成果照常交回并带告警；停止时则不能证明原宿主不再写入，不运行保存进程，命令报"本轮进程树清理未确认"并以 1 退出，已提交检查点仍可接续。

该有界停止保证以监督器仍存活为前提。监督器或业务宿主遭外部强退时，继续使用持久执行状态核对可写性。Linux 可回收已知进程组；Windows 已死亡的树根不能可靠证明所有后代均结束，因此保守显示 `pendingRecovery` 或 `interrupted`，不能仅因 PID 或时间猜测已经清理。保证不扩展到另起脱离受管树的外部进程、远端服务或不受支持的执行器行为。

## 停止记录与检查点

| 记录/字段 | 含义 |
|---|---|
| `run.stopped.reason` | `timeout`、`cancelled`、`hardQuota` 或 `stagnation`；超时另存生效 `roundTimeoutMs`，硬额度保留结构化 type/limit，停滞保留阈值及完整周期证据，见[停滞控制](agent-stagnation.md) |
| `stop.json` | `renderweave-stop/1`；在进一步保存前独占发布原拥有者、停止原因和已知用量。它不是完整成果或批准凭据 |
| CLI / API `save` | `complete` 表示本地停止记录已提交；`incomplete` 表示宽限或保存故障，不能当作成果完成 |
| `readReview().execution.stop` | 同一原因、已知用量和 `save`；完整性由启动/最终记录身份核对，不能由文件存在推断 |
| `draft.json` | 来源仍为 `hostRecovery`，只供查看；有检查点时来自已检查字节，无检查点时只是可解析的诊断 JSON |
| `cleanup.json` | `renderweave-cleanup/1`；进程树清理未确认时由监督器写出，`events` 逐次记 `after`（`result`、`error`、`stop`、`save`）、时间与原因，停止时另记停止原因。`readReview().execution.diagnostics` 列为告警，不改变 `committed`；CLI / API 的 `cleanup` 对应成功交回时的同一告警 |

正式成果发布途中停止时，已有零散复制不会被当成 Agent 正式完成。完整检查点保持其不可变字节及唯一发布指针；半写候选、未完成保存和恢复草稿不会覆盖它。停止保存失败时，公开返回仍保留监督器已经获得的原因和用量；如文件系统连 `stop.json` 都无法写入，磁盘仅显示此前可证明的状态和诊断，不伪造持久完成。

停止后可用 `--from <旧轮次> --feedback <反馈>` 从最后完整检查点新开轮次；旧停止原因、原成果和事件历史不变。没有可核对检查点时只可查看诊断，不能把零散候选当成完整集合续跑。恢复草稿和检查点均不能直接批准、应用；正常结束与已有轮数用尽的正式成果仍遵循原有审核流程。

## 用量、错误和兼容

当前适配器无法执行实时硬 token/费用上限，因此 `--max-tokens` / `--max-cost-usd`（API `maxTokens` / `maxCostUsd`）在启动前明确拒绝。供应商结束汇总与已收到消息的用量用于报告，不冒充实时限额。

结果汇总逐字段优先；缺失字段沿用已收到消息的数值，空结果对象不会清除已知用量。同一消息 ID 的稀疏更新只合并已知字段，再累计不同消息，`usageSource: messages` 表示使用了消息证据，可能不完整。`usageSource: result` 表示数值全部来自供应商结果汇总。未收到的字段不填零，失败、取消和超时不清空已知用量。`wallMs` 包含执行后的终检。全实验成本继续使用独立尝试原件和既有汇总，不另建账本。

明确硬额度沿用原分类；普通 429、5xx 和含糊限流不触发硬额度停止。执行器非零退出/服务错误保留失败诊断，宿主强退显示持久状态，检查点来源标为 `hostRecovery`，均不替换成成功或批准。

评估 CLI 同样接受 `--timeout-ms`；冻结实验身份保存生效 `budgets.roundTimeoutMs`，每轮校验它与 runtime 一致。旧实验缺少可执行时间预算（null）仍能重新评分，但不能在新默认预算下静默续跑同一实验；需新建实验。MCP/Agent 合同为 **0.14.0**，工具读权限和检查点发布者不变；`round/1`、`execution/1`、`round-start/1` 使用可选加法字段保持旧记录读取。

验证见 `test/agent-budgets.test.ts`、原 Agent/执行状态/检查点回归与实验身份测试。全部使用真实产品入口和可控执行器/外部渲染或文件系统故障，不调用真实模型。
