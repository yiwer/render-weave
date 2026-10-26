# 固定候选的串行派发启动器

`candidate-dispatch.mjs` 是验收编排工具，调用候选包内原样公开评估命令。它不冻结候选、不改评分、不补封存，也不读凭据内容。候选 6 尚待最终源码验证和冻结，本文与离线进程演练不代表任何真实派发已获激活。

## 登记与命令

接收 `renderweave-trusted-feedback-registration/3` 或 `original38-real-model-registration/3`。原版本 2 登记保持原件，不直接用于新工具。沿用候选、绑定、执行器、输入保全、命令及端点授权字段，增加：

```json
{
  "coordinator": {
    "directory": "F:/GenCode/render-weave/out/harness-acceptance-20/candidate6-execution",
    "candidateId": "冻结后填写实际候选 ID",
    "manifestSha256": "冻结后填写实际 candidate.json SHA256"
  },
  "sharedStop": "F:/GenCode/render-weave/out/harness-acceptance-20/candidate6-execution/STOP.json"
}
```

两个计划引用相同协调目录及候选身份。启动器核对这些字段与候选/绑定一致；STOP 必须是该目录下的 `STOP.json`；协调目录与候选、绑定及本计划输出目录分开。登记全文件 SHA 又由激活记录固定，因此不能用换路径绕过共享 STOP。`ACTIVE.lock/owner.json` 只属于本启动器实例，不清理未知锁。

```powershell
# 无凭据、无模型的预检；候选 6 冻结、登记完成后才执行。
node docs/agent-eval/candidate-dispatch.mjs --registration <registration.json> --segment 1 --preflight
# 只有独立复核及根任务明确派发指令后，另存 activation，再使用：
node docs/agent-eval/candidate-dispatch.mjs --registration <registration.json> --segment 1 --activation <activation.json>
```

`activation` 固定登记/启动器 SHA、候选 ID、绑定 ID、获准分段及独立复核文件 SHA。原四在 21 之后运行，激活的 `prerequisites` 须列 21 两段 `completed.json` 的实际 SHA，并令 `requireCompleted:true`。启动前与独占锁取得后、spawn 前均检查共享 STOP。每段新建唯一目录，不能重用已消费的分段。

## 停止与继续

| 公开证据 | 本批行为 |
| --- | --- |
| 原生运行时错误事件明确硬额度；产品 `type:error` 的 `error.type`/`error.code` 或顶层 `code` 属于 `GoUsageLimitError`、`insufficient_quota`、`credit_balance_too_low` | 写共享 STOP，停止当前自己创建的存活评估 PID 树，禁止后段/另一计划 |
| 原生 `result` 错误 / `system.api_retry` 明确 429；原生合成 API 错误消息明确限流 | 沿本批已有保守停止政策；记录为验收运行时停止，不把普通 429 回写成产品 `hardQuota`（M295） |
| `attempts/*/round/round.json` 的 `run.stopped.reason=hardQuota`；`cleanup.json` 的停止回执同理；单元 `upstream-errors.json` 的 `invalid.kind=quota` | 同样写共享 STOP；即使评估根已退出也不能把退出 3 当作正常放行 |
| `invalid.kind=host`，或成果已提交后的清理告警 | 沿 M331，不重试该单元，继续其他单元；保留 invalid/告警，已提交成果照常评分 |
| 普通业务未达线 | 保留有效失败；可按原计划继续，不改阈值或覆盖旧失败 |
| 共享 STOP、操作者停止、监测读取错误 | 停止；不轮询额度，不换模型，不自动续跑 |

只扫描宿主登记的实际尝试路径与上游错误回执，不扫描助手普通正文、工具内容、兼容目录或模型工作目录。扫描周期 250 ms，退出时再扫一次公开回执。普通引用中的 `429`、`insufficient_quota` 不触发；运行中的 JSON 尚未写完整可等下一次扫描，退出后仍不可解析会按监测错误停止。

只对本次 spawn 持有且仍 live 的子进程执行 `taskkill /PID <pid> /T /F`，记录 PID、开始时间与返回值。STOP 写入失败仍进入定向停止；未知后代清理状态保留锁，不凭已失效 PID 杀其他进程。标准输出/错误保留到 close。旧工具的 15 秒外层 taskkill 截止保留；失败时不能保证所有子进程已退出，不能因此发布完整封存或 0 成本。

这是外层观察与中断，存在检测窗口；候选 `run.ts`/`cliLauncher` 没有统一 AbortSignal 队列接缝，不宣称每个内层单元都同步读取共享 STOP，也不承诺有界优雅保存。停止后先确认写者退出，再用公开 `--rescore` 另存报告；不调用私有恢复函数补造完成记录。

## 离线演练

```powershell
node docs/agent-eval/candidate-dispatch.mjs --self-test <新的持久目录>
node docs/agent-eval/candidate-dispatch.mjs --self-test <新的持久目录> --self-test-case structured-quota
```

该入口只启动本地自建 Node 子树，移除模型凭据，无网络/模型调用。覆盖原生 429、结构化硬额度、共享 STOP、STOP 写失败仍清树、已退出的三种公开额度回执、普通引用不误停、host 与已提交清理告警继续。它证明启动器机制，不替代实际候选 6 的冻结/绑定/四次公开预检，更不计真实模型或人工验收。

责任证据见 `out/harness-candidate6-dispatch-validation/`；候选 6 后续发布与预登记的待办保存在 `out/harness-candidate6-publication-preparation/`。源码基于 M331 主线，旧 `8d0fc7c` 的候选 5 登记与启动器未合入。
