# 30: 数据定义提取与数据集提取缺省用 low 推理力度，模板类任务保持 medium

**What to build:** 先用评估确认两类提取任务在 `--effort low` 下成绩不降、输出 token 明显下降；成立时让 `renderweave agent run` 不给 `--effort` 时按任务取缺省（提取类 low，模板类不设、即 Claude Code 的 medium），`round.json` 记实际用的力度。

**Blocked by:** 23

**Status:** resolved

**Trace:** M291（推理力度缺省不改）、M232（模型与成本）、ADR-0015；[票据 23](23-agent-thinking-budget.md) 的 Answer；验收 A10。

背景：

- 票据 23 的对照评估 [2026-10-20-effort-low](../../../docs/agent-eval/reports/2026-10-20-effort-low.json) 只跑了 M402 模板与 366 两个场景。366（数据定义提取 + 数据集提取）输出降 35%，站名、地标、设施不降；M402 模板降 28%，相似度 0.870 低于近三份报告的最低值 0.898，所以缺省没改。
- "只对提取类任务用 low"可能成立，但 M402 数据定义场景从没在 low 下跑过，它的余量本来就只有 1 分（资料相同的 16 次里 14 次达线，见 `docs/agent-eval.md`「历次评估」）。

**做法**：

- 跑 `npx tsx scripts/agent-eval/run.ts --label 2026-10-20-effort-low-extraction --scenarios m402-definition,366-transcription --effort low`，两个场景各 2 次。资料与合同与 [2026-10-20-contract-060](../../../docs/agent-eval/reports/2026-10-20-contract-060.json) 相同（报告的 `materials` 逐文件对照），对照就用这份的 medium 成绩。
- **切换条件**（照票据 23）：三条都满足才改缺省。
  1. 两个场景门槛通过（各连续 2 次达线）。
  2. 各项成绩不低于近三份报告的最低值。近三份取票据 23 用的同三份：2026-10-20-contract-060、2026-10-20-ticket21、2026-10-19-gemini-4-argon。即 M402 数据定义专家字段 ≥ 14、约定 6；366 站名 ≥ 58、地标 ≥ 15、设施 ≥ 17。366 的数据定义专家字段只作参考，不计。
  3. 两个场景的输出 token 合计比 contract-060 的 217,996（M402 数据定义 72,825 + 366 145,171）降 30% 以上，即不超过 152,597。
- **满足时**：
  - `src/agent/tasks.ts` 给任务加缺省力度：数据定义提取、数据集提取为 `low`，模板辅助设计与修改不设。
  - `agent run` 不给 `--effort` 时用任务缺省，给了就以命令行为准；带反馈的下一轮按它自己的任务取缺省。`round.json` 的 `runtime.effort` 记实际传给 Claude Code 的值（不传为 `null`）。
  - 评估不传 `--effort` 时，各轮按任务缺省；报告的 `runtime.effort` 仍是评估命令给的值，各轮实际值看轮次的 `round.json`。
  - 记 M 编号（修订 M291），改 `docs/agent-tasks.md`；改了缺省行为，按 `docs/agent-eval.md` 再跑一次三场景门槛。
- **不满足时**：缺省不改，只在本票与 `docs/agent-eval.md`「历次评估」记结果。

- [x] 跑 low 下的两个提取场景，报告存档，按三条切换条件逐条对照，结论写进本票 `## Answer`。
- [x] 满足时：任务缺省力度、`agent run` 取缺省与 `round.json` 记实际值；离线用例覆盖"提取类不给时传 low、模板类不给时不传、命令行给了以命令行为准"。——条件不满足，不做（见 Answer）。
- [x] 满足时：`docs/agent-tasks.md` 与 M 编号；三场景门槛复跑通过，写进 `docs/agent-eval.md`「历次评估」。——条件不满足，不做；结果写进了「历次评估」。
- [x] 评估的轮次目录与报告经 `scripts/scan-keys.mjs` 扫描，key 命中 0。
- [x] 全量 `npm test` 与 `npm run typecheck` 通过。

**测试接缝：** `runAgentTask` 传给假执行器（`test/support/fake-claude.mjs`）的参数与 `round.json`；CLI 用 `test/agent-rounds.test.ts` 的现有写法。

**不在本票：** 模板类任务的力度；Gemini（走转换代理，力度对它的效果另测）；`MAX_THINKING_TOKENS`（对 Haiku 5.5 不生效，票据 23）。

## Answer

2026-10-20 完成。**切换条件不满足，缺省不改**：门槛通过、成绩不低于近三份最低值，但两个提取场景的输出只降 24.8%，没到 30%。结果记在 M291 的后续与 `docs/agent-eval.md`「历次评估」，代码不动。

**评估**：`npx tsx scripts/agent-eval/run.ts --label 2026-10-20-effort-low-extraction --scenarios m402-definition,366-transcription --effort low`，退出码 0，报告 [2026-10-20-effort-low-extraction](../../../docs/agent-eval/reports/2026-10-20-effort-low-extraction.json)。提交 6b65b35 加本票文件（未提交），`agent/` 资料哈希与 contract-060 逐文件相同，合同 0.6.0，Claude Code 2.1.296，服务端模型 `claude-haiku-5-5`，没有上游错误与重试。

**逐条对照**：

| 条件 | 要求 | low | 结论 |
|---|---|---|---|
| 1. 门槛 | 两个场景各连续 2 次达线 | 达线、达线；达线、达线 | 满足 |
| 2. M402 数据定义 | 专家字段 ≥ 14，约定 6 | 14、14（两次都缺班车类型），6、6 | 满足 |
| 2. 366 | 站名 ≥ 58，地标 ≥ 15，设施 ≥ 17 | 59、58（第 2 次"宝安北路南"写成"宝安北路"）；15、15；18、18 | 满足 |
| 3. 输出 token | 合计 ≤ 152,597（比 217,996 降 30%） | 163,908（降 24.8%） | **不满足** |

**明细**（medium 取 contract-060，同资料同合同）：

| | medium | low | 变化 |
|---|---|---|---|
| M402 数据定义输出 | 40,857 + 31,968 = 72,825 | 16,475 + 20,667 = 37,142 | −49% |
| 366 数据定义提取输出 | 32,216 + 35,573 = 67,789 | 17,485 + 31,925 = 49,410 | −27% |
| 366 数据集提取输出 | 37,689 + 39,693 = 77,382 | 41,203 + 36,153 = 77,356 | 0% |
| 合计输出 | 217,996 | 163,908 | −24.8% |
| 思考 | 170,048 | 123,492 | −27% |
| 用时（各轮之和） | 49.0 分钟 | 24.4 分钟 | −50% |

- 366 的数据定义专家字段 12、12，第 1 次建了终点站字段（约定 5/6），都只作参考，不计入通过线。
- **没过的原因在数据集提取**：low 下它的输出与 medium 持平，思考仍有 3.0–3.3 万 token，推断是逐站转录与核对本身要想这么多，力度压不下来。数据定义提取稳定下降：low 的 6 轮（本次 4 轮加 effort-low 的 2 轮）平均 19,692，medium 4 轮平均 35,154，降 44%。
- **波动**：366 在 effort-low 里降 35%（数据定义提取 −53%、数据集提取 −18%），这次只降 13%。只看一次对照的降幅，靠不住。

**判断**：不再追"只给数据定义提取用 low"。一单代建的输出里，数据定义提取约 3.5 万，数据集约 3.9 万，模板约 8 万，这一项全降也只省总量的一成左右；M402 数据定义的余量本来就只有 1 分，low 下两次都正好在线上，为一成的节省去冒这个险不值。切换条件：额度窗口成为代建的瓶颈，或者数据定义提取的轮次明显变多时，再为"只数据定义提取用 low"另定条件评估，至少 4 次 M402 数据定义不低于 14。

**对票据的偏差**：

- 改了 M291 的"后续"一句（原文说"要先补 M402 数据定义在 low 下的评估再定"，现在评估补上了），没有新增 M 编号。
- 评估跑的时候预写过任务缺省力度的代码、用例与文档（只改源码，没有重新构建 `dist`，不影响正在跑的评估）（`tasks.ts` 加 `effort`、`agent run` 不给时取任务缺省、报告按任务记力度），条件不满足后全部撤回，工作区只剩本票、报告与文档里的记录。

**验证**：`node scripts/scan-keys.mjs out/agent-eval/2026-10-20-effort-low-extraction docs/agent-eval/reports/2026-10-20-effort-low-extraction.json docs src scripts test .scratch` 扫描 594 个文件，命中 0；全量 `npm test` 47 个文件、951 项通过；`npm run typecheck` 通过。

## Comments

- 2026-10-20 开票，来自票据 23 Answer 的观察与 M291 的后续。
