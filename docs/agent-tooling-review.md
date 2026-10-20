# Agent 外围工具复核（2026-10-19）

结论：工具数量不是瓶颈——11 个只读工具在评估里 0 次错误；瓶颈在输入校验、交回前自检的判据和视觉输入的成本/上限。先修 2 个 P1，再排 4 个 P2；P3 是复现性与协议层的小账。

这次复核只读，不改代码。完整证据在下面的 `路径:行号`、命令与评估目录；可执行项落成票据 16–21。

> **二次复核（同日，含实测）改了排序与两张票的方案，以[二次复核](agent-tooling-evaluation.md)与各票据为准**：
> - 17 降为 P2；18 的判据会误伤被调模板，已改写并降为 P3；19 的拼图方案被实测推翻，改为降低缺省放大倍数；20 降为 P3；21 改写重试粒度与门槛语义。
> - 新开 22（MCP 输出超过 50,000 字符时 Agent 拿不到）、23（思考预算）、24（模板辅助修改评估场景）。
> - 下文"基线"第 3 条与 P2-4 的依据已更正，见各处的"二次复核"注。

**口径**：P1 = 会产生错误成果、崩溃或假合格，建议先修；P2 = 明显浪费成本或降低成功率，值得排期；P3 = 小成本改进或可复现性补强。

## 基线（已验证）

- 两次 366 评估共 8 轮，`view_image` 132 次，平均 16.5 次/轮，单轮最高 34 次。
- M402 模板两轮共 `render_draft` 16 次、`inspect_layout` 1 次；run-1 的 `outputTokens` 88,514、`cacheReadTokens` 1,791,965。
- 评估目录下所有 `tools.jsonl` 的 `isError` 都是 false。（二次复核：这两个目录成立；2026-10-19 的评估 run-1 有 1 次 `render_draft` 报错，因为照抄的 `request.json` 带 `"mode": "final"`；另有 2 次 `dsl_reference` 结果超长被 Claude Code 转存，`isError` 照样是 false。）

这些数字说明模型会用工具；问题是工具给它的输入和自检信息不够。

## P1

### 1. `--dataset` 用在数据集提取上：静默空转，带 `--request` 直接 TypeError

`--definition` 是数据集提取的必需输入，`--dataset` 只属于模板辅助设计/修改（`docs/agent-tasks.md:29-31`、`src/cli.ts:103-104`）。但 `checkTaskOrder` 只检查“`--definition` 或 `--dataset` 至少给一个”：

```ts
// src/agent/run.ts:392-398
if (task.requires === 'definition' || task.requires === 'dataset') {
  if (options.definition === undefined && options.dataset === undefined) { ... }
  if (task.requires === 'dataset' && options.dataset === undefined) { ... }
}
```

于是 `resolveBasis('definition')` 在没给 `--definition` 时仍返回 `definition!`（`src/agent/run.ts:454`），`{definition}` 被替换成空串（`src/agent/run.ts:274`）。轮次照常创建，`logs/outcome-context.json` 只有：

```json
{ "task": "dataset-extraction" }
```

复现（`out/probe-dataset-arg.ts`，临时探针，不进版本库）：

```text
$ npx tsx out/probe-dataset-arg.ts
created C:\Users\ADMINI~1\AppData\Local\Temp\rw-probe-...\round
context {
  "task": "dataset-extraction"
}
```

如果同时给 `--request`，会在 `readRequest` 里解引用 `basis.definition!`，直接抛 TypeError：

```text
$ npx tsx out/probe-dataset-request.ts
ERROR TypeError: Cannot read properties of undefined (reading 'name')
    at sameStaticSchema (src/workspace.ts:64:23)
    at readRequest (src/agent/run.ts:503:63)
```

同一处还有一类：`requires: 'none'` 的任务完全不校验 `--definition`/`--dataset`，数据定义提取会静默忽略两者。

**动作**：按 `task.requires` 精确校验——definition 任务必须有 `--definition` 且拒绝 `--dataset`；dataset 任务必须有 `--dataset`；`requires: 'none'` 两者都拒绝。`resolveBasis` 返回前断言 `definition !== undefined`。回归用例放 `test/agent-rounds.test.ts`（已有同类用法错误用例，`test/agent-rounds.test.ts:208-219`）。票据 16。

**代价**：一次错误参数可能浪费一整轮，量级参考 M402 模板 run-1 的 88,514 output tokens；而且后续成果校验拿不到 definition，无法校验“数据集必须选定本轮定义”。

### 2. `check_outcome` 丢掉 `revision`，模板修改的范围自检是瞎的

`src/mcp/tools.ts:372` 明确把 `revision` 剥掉：

```ts
candidates: check.candidates.map(({ sha256: _sha256, revision: _revision, problems, deferred, ...candidate }) => ({ ... }))
```

但 `checkAgentOutcome` 已经算好了结构化差异（`src/agent/outcome.ts:250-256`，`src/agent/diff.ts:128-133`），审核视图也把同一份差异和修改要求并排展示给审核人（`src/agent/review.ts:871`、`src/agent/review.ts:882`）。

也就是说：审核人能看到“改了哪些元素、哪些属性”，并按修改要求判断有没有改多；Agent 在交回前看不到，只能自己 `read_document` 对比，而 prompt 没要求它这么做。`check_outcome` 的 description（`src/mcp/tools.ts:361-363`）也没有提这件事。

**动作**：`check_outcome` 返回 `revision: { status, changes: [{ path, target, change, properties: [key] }] }`，默认不带 `before`/`after`，避免长内容；需要值时再加 `details: true`。同步改 description 和 `docs/mcp.md` 的合同版本（按 `docs/mcp.md:109`，改变输出结构要升 0.6.0）。如果希望改一次就看一次，`check_templates` 可以加可选 `revision: true`。票据 17。

**验证**：`test/mcp.test.ts` 已有 revision diff 的底层用例，补一条“`check_outcome` 返回 changes 且不含 before/after”。

## P2

### 3. 模板设计的 `base` 没有和本轮数据集比对

`src/agent/candidates.ts:145-150` 只检查模板的 `base`“存在且可编译”，不检查它是否等于本轮数据集的 `staticSchema`；`OutcomeContext` 也没有 dataset 字段（`src/agent/candidates.ts:25-27`，`src/agent/run.ts:310-314` 只给 dataset-extraction 传 definition）。

实际出图时 `preflight.ts:35-39` 会报 `datasetStaticSchemaMismatch` 并 blocked，所以 `render_draft` 会先挡住；但最后一道 `check_outcome` 会说 qualified，判据和真实可交付性不一致。这是代码上确定、实际影响为推断的缺口。

**动作**：模板设计任务也把 `basis.definition`（即数据集选定的 staticSchema）放进 `OutcomeContext`（`src/agent/run.ts:311` 的条件加上 `template-design`），在 `checkTemplates`（`src/agent/candidates.ts:116`）里对新建模板比较 `parsed.model.base`；不一致就报 severe。模板修改任务不要比，交给 revisionDiff。票据 18。

### 4. 视觉输入：16.5 次 `view_image`/轮，最高 34 次

366 的 definition 轮把示例图切成 9 条竖带逐条读站名，再切 9 条细带核对（`out/agent-eval/2026-10-18-check-outcome/run-1/366-transcription/definition/logs/stream.jsonl` 的 arguments）。`view_image` 的 inputSchema 只有单个 `region`（`src/mcp/tools.ts:302-306`），call 里只裁一块、返回一张 PNG（`src/mcp/tools.ts:314-341`）。

这不只是 token 成本：`docs/agent-eval.md:132` 记录“三个场景都在会话累计 61–63 张图片时报上游 400（`input_invalid`），推断是单次请求的图片张数上限”。34 张/轮已经用掉一半，更复杂的图会撞上。

（二次复核：那条记录是已停测的 Step 5 Preview，不适用于 Haiku 5.5 与 Gemini 4 Argon。实测同样像素拼成一张时站名正确数从 59 掉到 52–56，下面的拼图方案不做；改为降低缺省放大倍数，见[票据 19](../.scratch/agent-template-authoring/issues/19-view-image-multiple-regions.md)。）

**动作**：`view_image` 接受 `regions: [...]`（上限 8–12），服务端把每块按原分辨率裁切后拼成一张带格位说明的 contact sheet；用现有 CanvasKit 就能画（`src/mcp/tools.ts:308-334` 已经在用 `MakeSurface`/`drawImageRectOptions`）。`list_resources` 现在只有 ID 与 kind（`src/mcp/tools.ts:125-131`，`docs/mcp.md:120` 已承认），可以再加一个资源缩略图 contact sheet，减少逐个查看。票据 19。

**验证**：同一 366 场景复跑，比较 `view_image` 次数、`cacheReadTokens` 和是否仍达线；不要只看 token。

### 5. `agent/reference/template.md:129` 在模板任务里指向自己

原文：“数据定义与数据集见 dsl-reference.md（数据定义参考）中的‘胸牌 v1’”。

模板任务的 `docs/dsl-reference.md` 是 `template.md` 自己（`src/agent/run.ts:244` 把非 outcome 参考统一写成 `dsl-reference.md`，`src/agent/tasks.ts:42` 只复制 template 与 outcome），里面没有“胸牌 v1”；真正的示例在 `agent/reference/data-definition.md:60-100`。

**动作（一行）**：改成“数据定义示例用 `dsl_reference` 取 `reference/data-definition`（会议胸牌）”。或者给模板任务额外复制 `data-definition.md`，但要先改 `src/agent/run.ts:244` 的固定文件名映射，否则两份参考会互相覆盖。票据 20。

### 6. 评估把 429/500 当模型失败

`agent run` 遇到模型服务报错仍返回一轮 unqualified + exit 1（`src/cli.ts:390-391`），`scripts/agent-eval/eval.ts:58` 只把 0/1 当正常，`scripts/agent-eval/eval.ts:147` 把 `round.error` 计入 failures。

报告里已经出现“第 1 次的模板单元被额度窗口（429）打断，删掉后重跑”和“被上游 500 打断，那次删掉了”（`docs/agent-eval.md:131`、`docs/agent-eval.md:134`）。

**动作**：`runScenario` 读 `round.json` 的 `run.error`，匹配 `429|500|overloaded|rate_limit|ECONNRESET` 时按指数退避重试（3 次，30s/90s/180s）；仍失败就把该 unit 标成 `invalid` 并从门槛中排除，报告单列，不要算模型失败。这个改动只动评估脚本，不影响产品合同。票据 21。

## P3

未开票；P1/P2 落地后再看。

- **`agent run` 没有墙钟超时**：`execute` 只等 `close`（`src/agent/run.ts:539-551`），`API_TIMEOUT_MS` 是单请求 600 秒（`src/agent/run.ts:331`），`--max-turns` 80 轮最坏情况很长。加 `--timeout` + SIGTERM/kill，`round.json` 记 `endedBy: 'timeout'`。
- **`round.json` 不存 prompt/资料哈希/MCP 合同**：`src/agent/run.ts:380-385` 只记了 sample/brief/workspace 的哈希。建议记 `promptSha256`、每个 `agent/docs/*` 的 sha256、`mcpContract: MCP_CONTRACT_VERSION`（`src/mcp/tools.ts:32`），否则复现依赖 `stream.jsonl` 和当时的仓库状态。
- **`check_dataset` 只返回 problems**（`src/mcp/tools.ts:187-190`）：对 366 这种逐项转录，返回每个列表字段的长度、重复值、空值计数，能让 Agent 在交回前发现漏项/重项；单字错误仍要靠看图，不要指望它。推断，未跑用例复现。
- **`tools/list` 不带 annotations**（`src/mcp/server.ts:58`）：11 个工具都是只读，加 `annotations: { readOnlyHint: true, openWorldHint: false }`。如果严格按 `docs/mcp.md:109`，这也算 `tools/list` 输出变化，可以和 0.6.0 一起发。
- **`dsl_reference` 只能整份取**（`src/mcp/tools.ts:349-356`）：参考文件大时支持 `section` 或返回目录，避免重复读整份；优先级最低，每轮通常只调 1 次。
- **模板 prompt 的 `inspect_layout` 没有触发条件**：两轮只用了 1 次，`render_draft` 16 次。不是缺陷，但“元素位置、字号与压缩比用 inspect_layout 查”太笼统；改成“预览里文字溢出或字号/压缩比可疑时再用”，或者删掉，减少无效指令。

## 开票与状态

二次复核后的优先级与内容（状态以票据文件的 `**Status:**` 行为准）：

| 票据 | 内容 | 优先级 |
|---|---|---|
| [16](../.scratch/agent-template-authoring/issues/16-agent-run-task-options.md) | `agent run` 按任务精确校验 `--definition`/`--dataset`，修静默空转与 TypeError | P1 |
| [17](../.scratch/agent-template-authoring/issues/17-check-outcome-revision.md) | `check_outcome` 返回模板修改的 `revision` 摘要，排在 24 之后 | P2（原 P1） |
| [18](../.scratch/agent-template-authoring/issues/18-template-base-matches-dataset.md) | 只比较主模板的 `base` 与数据集选定的 `staticSchema`，上下文只在一处构造 | P3（原 P2） |
| [19](../.scratch/agent-template-authoring/issues/19-view-image-multiple-regions.md) | `view_image` 缺省最多放大 2 倍，加可选 `scale`；不做拼图 | P2（方案改写） |
| [20](../.scratch/agent-template-authoring/issues/20-template-reference-data-definition-pointer.md) | 修 `agent/reference/template.md:129` 的数据定义示例指向 | P3（原 P2） |
| [21](../.scratch/agent-template-authoring/issues/21-eval-retry-transient-errors.md) | 评估按轮次重试瞬时错误、429 熔断，`invalid` 时门槛记 `incomplete` | P2，先做 |
| [22](../.scratch/agent-template-authoring/issues/22-mcp-output-within-client-limits.md) | MCP 文字结果不超过 Claude Code 的 50,000 字符落盘阈值 | P2（新） |
| [23](../.scratch/agent-template-authoring/issues/23-agent-thinking-budget.md) | 思考预算可设置、有记录，用对照评估定缺省 | P2（新） |
| [24](../.scratch/agent-template-authoring/issues/24-eval-template-revision-scenario.md) | 评估加 `m402-revision` 场景 | P2（新） |

落地顺序见[二次复核](agent-tooling-evaluation.md#落地顺序)：16、21 → 24 → 22、17、18、19、20 合成一批发 0.6.0、跑一次评估 → 23。

## 未决

- **模板辅助修改没有自动评估场景**：`scripts/agent-eval/config.json` 只有 definition/template/transcription 三个场景，`scripts/agent-eval/scenarios.ts:20-35` 也没有 revision kind。现成的修改要求还在（`scripts/agent-eval/scenarios/price-tag/requirement-revision.md`、`scripts/agent-eval/scenarios/366/requirement-revision.md`）。这次改 `check_outcome` 的 revision 输出，建议同时补一个 revision 场景，否则回归只能靠手工验收。（二次复核：已开[票据 24](../.scratch/agent-template-authoring/issues/24-eval-template-revision-scenario.md)，用库里已校准的 `fixtures/agent-eval/templates/first-test/` 与 M215 修改要求，票据 17 排在它之后。）
- **M 编号未预占**：P1/P2 落地、决定达成后按 `AGENTS.md` 从 M270 起记；本文件不替 `docs/discovery/requirements.md` 做决定。

## 证据位置

- 评估轮次：`out/agent-eval/2026-10-18-check-outcome/`、`out/agent-eval/2026-10-18-check-outcome-366/`（不进版本库）。
- 报告：[2026-10-18-check-outcome](agent-eval/reports/2026-10-18-check-outcome.json)、[2026-10-18-check-outcome-366](agent-eval/reports/2026-10-18-check-outcome-366.json)。
- 临时探针：`out/probe-dataset-arg.ts`、`out/probe-dataset-request.ts`（`out/` 已被 `.gitignore` 忽略；持久回归见票据 16）。
- 复核命令：`git check-ignore -v out/probe-dataset-arg.ts`、`npx tsx out/probe-dataset-arg.ts`、`npx tsx out/probe-dataset-request.ts`。
