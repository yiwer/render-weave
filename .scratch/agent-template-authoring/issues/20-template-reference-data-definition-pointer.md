# 20: 修正模板参考里的数据定义示例指向

**What to build:** 模板辅助设计与模板辅助修改的 Agent 按 `agent/reference/template.md` 的提示，能找到“会议胸牌”的数据定义示例，不再被指到 `docs/dsl-reference.md`（在模板任务里这份文件就是模板参考自己）。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** M43；2026-10-19 [外围工具复核](../../../docs/agent-tooling-review.md) P2-5；验收 A09、A11。

背景：

- `agent/reference/template.md:129` 写“数据定义与数据集见 dsl-reference.md（数据定义参考）中的‘胸牌 v1’”。
- 模板任务的 `docs/dsl-reference.md` 是 `template.md` 自己：`src/agent/run.ts:244` 把所有非 outcome 参考统一写成 `dsl-reference.md`，`src/agent/tasks.ts:42` 只复制 `template` 与 `outcome`。
- 真正的示例在 `agent/reference/data-definition.md:60-100`；模板任务的工具清单里有 `dsl_reference`（`src/agent/tasks.ts:43`、`src/agent/tasks.ts:50`）。

**决定**：

- 只改一行：把 `template.md:129` 改成“数据定义示例用 `dsl_reference` 取 `reference/data-definition`（会议胸牌）”。
- 不在本票给模板任务额外复制 `data-definition.md`：`src/agent/run.ts:244` 的固定文件名会让两份参考互相覆盖，要改映射才能加；那是另一个改动。
- 资料改动按 `docs/agent-eval.md:7-12` 复跑评估；不单独跑，随票据 22 那一批资料与合同改动一起跑一次。

- [ ] `agent/reference/template.md` 不再让模板任务去 `dsl-reference.md` 找数据定义示例。
- [ ] 模板设计与模板辅助修改的 prompt/tool 清单仍能取到 `reference/data-definition`。
- [ ] 现有 `docs/dsl-reference.md` 复制测试仍通过（`test/agent-dataset-template.test.ts:193`、`test/agent-rounds.test.ts:285`）。
- [ ] 与票据 22 同批复跑评估，`m402-template` 两次达线。

**测试接缝：** `test/agent-dataset-template.test.ts` 已断言模板轮次的 `docs/dsl-reference.md` 等于 `agent/reference/template.md`；补一条断言，确认模板提示词提到 `reference/data-definition`，或确认 `dsl_reference` 的工具清单包含该名称。

**不在本票：** 把 `data-definition.md` 复制进模板轮次的 `docs/`；需要先改 `src/agent/run.ts:244` 的参考文件名映射。

## Comments

- 2026-10-19 二次复核（[实测记录](../../../docs/agent-tooling-evaluation.md#票据-20)）：指向错误属实，但 4 次模板评估轮没有一次去找"胸牌 v1"（`dsl_reference` 只取过 `schema/template`），实际影响为零。由 P2 降为 P3，`ready-for-agent`，不为它单独花一次评估。
