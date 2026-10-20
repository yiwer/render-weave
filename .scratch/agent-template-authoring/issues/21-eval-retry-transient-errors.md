# 21: 评估把上游瞬时错误与模型失败分开

**What to build:** `scripts/agent-eval/run.ts` 遇到上游 500/529/连接中断时按轮次重试；额度窗口的 429 停止派发剩下的单元并给出续跑命令；仍拿不到有效结果的单元记为 `invalid`，门槛结论是"未完成"，不算通过，也不算模型失败。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** M230（评估门槛）；2026-10-19 [外围工具复核](../../../docs/agent-tooling-review.md) P2-6，[二次复核](../../../docs/agent-tooling-evaluation.md#票据-21) 改写重试粒度与门槛语义；[Agent 评估](../../../docs/agent-eval.md)「历次评估」。

背景：

- `agent run` 遇到模型服务报错仍返回一轮 unqualified + exit 1（`src/cli.ts:390-391`），错误写在 `round.json.run.error`（`src/agent/run.ts:572-573`）。
- `scripts/agent-eval/eval.ts:58` 只把退出码 0/1 当正常，`scripts/agent-eval/eval.ts:147` 把 `round.error` 计入 failures，于是 429/500 轮被当成模型没做出来。
- 实际出现过的两种：
  - 500：`API Error: 500 status code (no body). This is a server-side issue, usually temporary`（`out/agent-eval/2026-10-18-check-outcome-366.interrupted-500.log`）。这是 Claude Code 自己重试之后才报出来的，所以外层只需少量重试。
  - 429：OpenCode Go 的 5 小时额度窗口，各模型共用一个池（M231）。几分钟的退避等不到窗口恢复，原写法的 30s/90s/180s 只会再撞 3 次。
- 366 场景一个单元有两轮（数据定义提取 → 模拟审核并应用 → 数据集提取，`scripts/agent-eval/eval.ts:119-122`）。清掉整个单元目录重试会丢掉已经做完、已经应用的第一轮。
- 门槛按"连续两次达线"算（`scripts/agent-eval/eval.ts:219-224`）。只说"invalid 不计入"时，一个场景 1 次达线加 1 次 invalid 的结论没有定义。

**决定**：

- **分类**：读 `round.json.run.error` 与发起失败的错误文字，大小写不敏感：
  - 瞬时：`500`、`502`、`503`、`529`、`overloaded`、`ECONNRESET`、`ETIMEDOUT`、`socket hang up`；
  - 额度：`429`、`rate_limit`、`quota`、`usage limit`；
  - 其他（400 参数错误、缺 key、执行器无法启动）照旧算失败。
- **瞬时错误按轮次重试**：只删掉出错的那一个轮次目录（`agent run` 要求目录为空）再发起这一轮，单元里已完成的轮次与已应用的工作区保留；最多 2 次，间隔 60s、180s，间隔可注入，离线测试不真的等。
- **额度错误熔断**：该单元记 `invalid`，不再派发队列里剩下的单元；已在跑的单元跑完；结束时打印用同一个 `--label` 续跑的 `--repetitions` 命令。
- **门槛语义**：`invalid` 不是一次观测，算连续达线时跳过它，不打断也不延长连续。
  - 某个场景的有效次数凑不齐 `consecutivePasses`、又没有因未达线而注定不过时，`gate` 结论为 `incomplete`；
  - `incomplete` 时退出码为 3，与通过（0）、未通过（1）、用法错误（2）区分。
- **报告**：每个单元记 `status: pass | fail | invalid` 与重试次数；`invalid` 单列原因，不进通过率。
- 只改评估脚本与报告结构，不改产品代码。

- [ ] 分类函数覆盖上面三类，各有用例，含真实出现过的 500 原文。
- [ ] 假 launcher 第一次 500、第二次成功：只留一个有效轮次目录，单元计为达线；366 式两轮单元的第二轮 500 时只重跑第二轮，第一轮目录与工作区不动。
- [ ] 假 launcher 返回 429：该单元 `invalid`，队列中尚未开始的单元不再发起，输出续跑命令。
- [ ] 1 次达线加 1 次 `invalid`：门槛 `incomplete`，退出码 3；2 次达线加 1 次 `invalid`：门槛通过。
- [ ] 非瞬时错误不重试，仍算未达线。
- [ ] `test/agent-eval.test.ts` 离线用例通过；不调用模型、不读 key。

**测试接缝：** `test/agent-eval.test.ts` 的假 launcher 与 `scoreScenario`/`gate`/`buildReport`；用临时目录写 `round.json` 模拟 `run.error`。

**不在本票：** `agent run` 自己的超时/预算（复核文档 P3）；评估的并行度与额度窗口的排期。

## Comments

- 2026-10-19 二次复核：方向对，原写法有三处要改——重试粒度从单元改为轮次，429 从退避改为熔断，`invalid` 的门槛语义写清楚。维持 P2，但应在下一次评估之前落地：之后的每次评估（票据 22–24 都要跑）都会用到。
