# 16: `agent run` 精确校验任务需要的参数

**What to build:** `renderweave agent run` 按 `task.requires` 拒绝不属于该任务的 `--definition`/`--dataset`；数据集提取缺 `--definition`、模板辅助设计缺 `--dataset` 时直接报用法错误，不再创建轮次或抛 TypeError。

**Blocked by:** 无

**Status:** ready-for-agent

**Trace:** 第三阶段 PRD M43、M226；2026-10-19 [外围工具复核](../../../docs/agent-tooling-review.md) P1-1；验收 A05、A06。

背景（2026-10-19 实测，探针在 `out/probe-dataset-arg.ts`、`out/probe-dataset-request.ts`，不进版本库）：

- `--task 数据集提取 --dataset ds-x` 不报错，轮次照常创建，`logs/outcome-context.json` 只有 `{"task":"dataset-extraction"}`，prompt 的 `{definition}` 是空串（`src/agent/run.ts:274`）。
- 同时给 `--request` 时，`readRequest` 解引用未定义的 `basis.definition!`（`src/agent/run.ts:503`），在 `sameStaticSchema` 抛 `TypeError: Cannot read properties of undefined (reading 'name')`。
- 根因：`checkTaskOrder` 只检查“`--definition` 或 `--dataset` 至少一个”（`src/agent/run.ts:392-398`），`resolveBasis('definition')` 无条件返回 `definition!`（`src/agent/run.ts:454`）。
- 同一处还漏了 `requires: 'none'`：数据定义提取给 `--definition`/`--dataset` 会被静默忽略。

**决定**：

- definition 任务必须有 `--definition`，并拒绝 `--dataset`。
- dataset 任务必须有 `--dataset`；`--definition` 可省略，给了就按现有规则校验一致性。
- `requires: 'none'` 拒绝两者。
- `resolveBasis` 返回前断言 `definition !== undefined`，把“不该发生”变成明确错误。
- 不改 `--help` 与 `docs/agent-tasks.md`，它们已经写明了各任务的参数。

- [ ] `--task 数据集提取 --dataset ds-x` 报用法错误（退出码 2），不创建轮次目录。
- [ ] `--task 数据集提取 --dataset ds-x --request r.json` 报用法错误，不再抛 TypeError。
- [ ] `--task 数据定义提取 --definition x`、`--task 数据定义提取 --dataset ds-x` 都报用法错误。
- [ ] `--task 数据集提取 --definition x` 仍正常创建轮次（合法输入不被误拒）。
- [ ] `--task 模板辅助设计` 仍要求 `--dataset`；`--task 模板辅助修改` 仍接受可选 `--dataset`。
- [ ] 回归用例覆盖以上五条，加在 `test/agent-rounds.test.ts`；全量 `npm test` 通过。

**测试接缝：** `runAgentTask` 的用法校验；用 `test/support/fake-claude.mjs` 起假 Claude Code，不调用模型、不读 key。

**不在本票：** 参数值的语义校验（如数据集不存在）已由 `resolveBasis` 覆盖，不改。

## Comments

- 2026-10-19 二次复核（[实测记录](../../../docs/agent-tooling-evaluation.md#票据-16)）：两个探针都复现了（`npx tsx out/probe-dataset-arg.ts` 照常建轮次、上下文只有 `task`；`npx tsx out/probe-dataset-request.ts` 抛 `TypeError`）。另见 `--dataset does-not-exist` 也不报错，因为 `resolveBasis('definition')` 在看数据集之前就返回了。维持 P1、`ready-for-agent`。只改命令行校验，不动资料与工具合同，按 `docs/agent-eval.md`「什么时候必须跑」不需要跑评估。
