# 21: 评估把上游瞬时错误与模型失败分开

**What to build:** `scripts/agent-eval/run.ts` 遇到上游 500/529/连接中断时按轮次重试；额度窗口的 429 停止派发剩下的单元并给出续跑命令；仍拿不到有效结果的单元记为 `invalid`，门槛结论是"未完成"，不算通过，也不算模型失败。

**Blocked by:** 无

**Status:** resolved

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

- [x] 分类函数覆盖上面三类，各有用例，含真实出现过的 500 原文。
- [x] 假 launcher 第一次 500、第二次成功：只留一个有效轮次目录，单元计为达线；366 式两轮单元的第二轮 500 时只重跑第二轮，第一轮目录与工作区不动。
- [x] 假 launcher 返回 429：该单元 `invalid`，队列中尚未开始的单元不再发起，输出续跑命令。
- [x] 1 次达线加 1 次 `invalid`：门槛 `incomplete`，退出码 3；2 次达线加 1 次 `invalid`：门槛通过。
- [x] 非瞬时错误不重试，仍算未达线。
- [x] `test/agent-eval.test.ts` 离线用例通过；不调用模型、不读 key。

**测试接缝：** `test/agent-eval.test.ts` 的假 launcher 与 `scoreScenario`/`gate`/`buildReport`；用临时目录写 `round.json` 模拟 `run.error`。

**不在本票：** `agent run` 自己的超时/预算（复核文档 P3）；评估的并行度与额度窗口的排期。

## Answer

2026-10-19 完成。只改了评估脚本、离线用例与文档，没有改产品代码；没有真跑评估。

**成果**

- `scripts/agent-eval/eval.ts`：
  - `classifyError` 按票据的字样分三类，大小写不敏感，数字按整词匹配（`1500`、`4290` 不误判）；两类字样都有时按额度算。成果合格的轮次不看 `run.error`。
  - 发起每一轮经 `launchRound`：瞬时错误只删掉这一个轮次目录再发起，最多 2 次，间隔 `RETRY_DELAYS_MS`（60、180 秒），`sleep` 可注入；重试用完或遇到额度错误时整个单元记 `invalid`；其他错误照旧。
  - 场景目录新增 `upstream-errors.json`：每次重试的轮次与原因，以及 `invalid` 的分类、轮次与原文。没有重试也没有 invalid 时不留这个文件。重新评分读回它。
  - `runUnits` 接管原来 `run.ts` 里的并行队列：遇到额度错误后不再发起剩下的单元，已在跑的单元跑完；已有有效结果的单元跳过。
  - 续跑 invalid 的单元时，已有有效轮次记录的轮次不再发起；366 第一轮已应用时不再模拟审核与应用。
  - `ScenarioResult` 加 `status`、`retries`、`invalid`；invalid 的单元 `failures` 为空。
  - `gate` 有三种结论 `pass`、`fail`、`incomplete`，各次结果是 `outcomes`（含 `not-run`），可传入评估清单的计划。
  - `resumeCommand` 拼续跑命令；报告格式升为 `renderweave-agent-eval/2`。
- `scripts/agent-eval/run.ts`：退出码 3 表示门槛未完成。同一个 `--label` 再跑时接着前一次，沿用开始时间、资料哈希与场景。有 invalid 或没跑的次数时，结束前打印续跑命令，带上本次的其他选项。
- 文档：[Agent 评估](../../../docs/agent-eval.md) 的选项、退出码、新的「上游错误与续跑」一节与报告格式；[开发环境与接续](../../../docs/dev-setup.md) 的期望测试数。

**验证**

- `test/agent-eval.test.ts` 从 8 项增加到 16 项，都用假执行器，不调用模型，key 是随机测试串：
  - 分类三类各有用例，含真实的 500 原文；
  - 第一次 500、第二次成功：单元达线，目录里只剩一个轮次目录与 `upstream-errors.json`；发起时的 `socket hang up` 同样重试；
  - 366 第二轮 500：只重跑第二轮，两次发起前第一轮目录（含 `applied.json`）与工作区逐个文件的哈希与修改时间都相同；
  - 重试用完记 invalid，间隔 60 000、180 000 毫秒；
  - 400 与执行器无法启动都不重试，算未达线；
  - 429：并行 2 时第 1 次 invalid、第 2 次在熔断之后才交回并跑完、第 3、4 次没有发起；续跑命令是 `--label quota --repetitions 1-4`；续跑时跳过第 2 次，其余达线，门槛通过；
  - `--rescore` 命令行：达线加 invalid 退出码 3、输出"门槛未完成"；再加一次达线，退出码 0；
  - 门槛的各种组合。
- Windows：`npm run typecheck` 退出码 0；`npm run build` 后 `npm test` 47 个文件、937 项全过（原 929 项加新增 8 项）。新 worktree 要先 `npm ci`、准备字体并 `npm run build`，否则已有的命令行用例因缺 `dist/bin.js` 失败。

**对票据的偏差与补充**

- **incomplete 的判定写成一般形式**：把 invalid 与没跑的次数都当作达线也凑不出连续 2 次的是 `fail`，凑得出来但还没凑出的是 `incomplete`。计划 2 次时与票据的"有效次数凑不齐、又没注定不过"一致。计划 3 次以上时，未达线、达线、invalid 判为 `incomplete`，不判 `fail`：补跑第 3 次达线就通过。
- **计划内没跑的次数与 invalid 同样处理**：包括额度熔断后没发起的单元，以及分段跑的前一段。所以 `--repetitions 1-1` 结束时门槛是"未完成"、退出码 3，以前是"未通过"、退出码 1。
- **续跑的入口**：同一个 `--label` 再跑即续跑，`--repetitions` 可以从 1 开始。以前从 1 开始会重置开始时间与资料哈希，再撞上已存在的轮次目录。
- **报告格式升为 `/2`**：`gate.scenarios[].passes`（布尔）换成 `outcomes`，旧报告不改。
- **"输出续跑命令"的验证**：拼接由 `resumeCommand` 离线验证；`run.ts` 打印这一行只在真跑时出现，没有实跑。
- 没有为本票新增 M 编号：决定记在本票与二次复核里。

## Comments

- 2026-10-19 二次复核：方向对，原写法有三处要改——重试粒度从单元改为轮次，429 从退避改为熔断，`invalid` 的门槛语义写清楚。维持 P2，但应在下一次评估之前落地：之后的每次评估（票据 22–24 都要跑）都会用到。
