# 16: `agent run` 精确校验任务需要的参数

**What to build:** `renderweave agent run` 按 `task.requires` 拒绝不属于该任务的 `--definition`/`--dataset`；数据集提取缺 `--definition`、模板辅助设计缺 `--dataset` 时直接报用法错误，不再创建轮次或抛 TypeError。

**Blocked by:** 无

**Status:** resolved

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

- [x] `--task 数据集提取 --dataset ds-x` 报用法错误（退出码 2），不创建轮次目录。
- [x] `--task 数据集提取 --dataset ds-x --request r.json` 报用法错误，不再抛 TypeError。
- [x] `--task 数据定义提取 --definition x`、`--task 数据定义提取 --dataset ds-x` 都报用法错误。
- [x] `--task 数据集提取 --definition x` 仍正常创建轮次（合法输入不被误拒）。
- [x] `--task 模板辅助设计` 仍要求 `--dataset`；`--task 模板辅助修改` 仍接受可选 `--dataset`。
- [x] 回归用例覆盖以上五条，加在 `test/agent-rounds.test.ts`；全量 `npm test` 通过。

**测试接缝：** `runAgentTask` 的用法校验；用 `test/support/fake-claude.mjs` 起假 Claude Code，不调用模型、不读 key。

**不在本票：** 参数值的语义校验（如数据集不存在）已由 `resolveBasis` 覆盖，不改。

## Answer

2026-10-19 完成。

- **校验**（`src/agent/run.ts` 的 `checkTaskOrder`）：按 `task.requires` 分开判断，都在创建轮次目录之前，都抛 `AgentUsageError`（命令行退出码 2）。
  - `none`（数据定义提取）：给了 `--definition` 或 `--dataset` 就报"数据定义提取不用 --definition、--dataset：…"，列出给了哪几个。
  - `definition`（数据集提取）：先拒绝 `--dataset`（"数据集提取不用 --dataset：…用 --definition 指定数据定义"），再要求 `--definition`（缺时沿用原来"先做数据定义提取并发布（M43）"的提示）。复核里的 `--dataset does-not-exist` 不报错随之消失。
  - `dataset`（模板辅助设计）：只要求 `--dataset`；`--definition` 可省略，给了仍由 `resolveBasis` 核对与数据集选定的数据定义一致。
  - `template`（模板辅助修改）：不变。
- **断言**：`resolveBasis('definition')` 返回前检查确有数据定义，否则抛普通 `Error`。这是内部不变量，校验漏了才会走到，不算用法错误。
- **回归用例**：`test/agent-rounds.test.ts`「agent run 按任务校验 --definition 与 --dataset（票据 16）」，用 `test/support/fake-claude.mjs`，不调用模型、不读 key。
  - 拒绝：数据集提取带 `--dataset`（单独给、加 `--request`、与 `--definition` 同给）；数据定义提取带 `--definition`、`--dataset`、两者同给；模板辅助设计没有 `--dataset`（什么都不给、只给 `--definition`）。断言抛 `AgentUsageError` 且轮次目录不存在；其中四条另经 `runCli` 断言退出码 2、轮次目录不存在。
  - 照常发起：数据集提取给 `--definition 问候` 与 `--request`，轮次记录、`logs/outcome-context.json` 与提示词里都是 问候 v1；模板辅助设计 `--definition` 省略、给 `问候`、给 `问候@1` 三种都发起；模板辅助修改给与不给 `--dataset` 都发起。
  - 把已有用例里的命令行辅助函数提到文件顶层，两处共用。
- **跑过的命令**：
  - 修复前 `npx tsx out/probe-dataset-arg.ts` 照常建轮次、上下文只有 `{"task":"dataset-extraction"}`；`npx tsx out/probe-dataset-request.ts` 抛 `TypeError`（`run.ts:503`）。修复后两者都报"数据集提取不用 --dataset：…"，不建轮次、不再抛 `TypeError`。
  - 还原 `run.ts`、只留新用例时，拒绝用例失败（promise resolved instead of rejecting），合法输入用例通过；恢复修复后两者都过。
  - `npx vitest run test/agent-rounds.test.ts` 15 项全过；`npm test` 47 个文件、931 项全过；`npm run typecheck` 通过。[换设备接续](../../../docs/dev-setup.md) 的期望测试数量随之改为 931 项（引擎 890 项）。
- **偏差**：模板辅助设计什么都不给时，原来提示"只给了示例图…先做数据定义提取"，现在提示"要基于已保存的数据集：先做数据集提取并应用（M43）"，即按 `requires` 报缺的那一个参数。`--help`、`docs/agent-tasks.md`、`agent/` 资料与 MCP 合同都没改，按 `docs/agent-eval.md`「什么时候必须跑」不需要跑评估。

## Comments

- 2026-10-19 二次复核（[实测记录](../../../docs/agent-tooling-evaluation.md#票据-16)）：两个探针都复现了（`npx tsx out/probe-dataset-arg.ts` 照常建轮次、上下文只有 `task`；`npx tsx out/probe-dataset-request.ts` 抛 `TypeError`）。另见 `--dataset does-not-exist` 也不报错，因为 `resolveBasis('definition')` 在看数据集之前就返回了。维持 P1、`ready-for-agent`。只改命令行校验，不动资料与工具合同，按 `docs/agent-eval.md`「什么时候必须跑」不需要跑评估。
