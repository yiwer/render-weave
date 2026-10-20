# Agent 外围工具二次复核与实测（2026-10-19）

结论：[首轮复核](agent-tooling-review.md)方向对，但排序和两张票的方案要改。

- **票据 16** 维持 P1，可直接领。
- **票据 17** 降为 P2，排在新开的修改场景（24）之后。
- **票据 18** 的原判据会把所有带被调模板的模板设计判成不合格，已改写，降为 P3。
- **票据 19** 的拼图方案被实测推翻：同样的像素拼成一张，站名从 59/59 掉到 52–56/59。改为降低缺省放大倍数。单这一项，366 分段读图的图片 token 就能降 42%（2 倍）到 80% 以上（1 倍），站名正确数不变。
- **票据 20** 降为 P3。
- **票据 21** 要改写重试粒度与门槛语义，并在下一次评估之前落地。

另有三项首轮没看到，开了票据 22–24：

1. MCP 文字结果超过 50,000 字符时被 Claude Code 转存，业务 Agent 要按路径另读（Haiku 用 Glob 找，没读到；Gemini 用 Read 读到了，2026-10-20 更正）。`dsl_reference` 的 `schema/template` 已经在 2/4 个模板评估轮里中招。
2. 思考 token 占输出 token 的 74–87%，是最大的成本与用时来源，现在既不能设置也没有记录。
3. 模板辅助修改与带反馈的下一轮没有自动评估。

落地顺序见[最后一节](#落地顺序)：先做 16、21，再做 24，然后 22、17、18、19、20 合成一批发合同 0.6.0、只跑一次评估，最后用对照评估做 23。

本轮只读代码、不改实现。实测分三类：

- 读已有的 14 个评估轮次的 `stream.jsonl`；
- 经 JSON-RPC 直接调 `renderweave mcp`；
- 经产品同一路径（无头 Claude Code 2.1.296、`--restricted`、只连一个临时 MCP 服务、OpenCode Go 上的 Haiku 5.5）跑 15 个小会话。共约 22 万缓存写入、12 万输出 token，约 10 分钟。

脚本在 `out/probe-tooling-2/`（不进版本库），命令见[复现](#复现)。

口径同首轮：P1 = 会产生错误成果、崩溃或假合格；P2 = 明显浪费成本或降低成功率；P3 = 小成本改进。"已验证"指跑过；"推断"指由代码或数据推出、没有直接复现。

## 实测

### 实测 1：看图的倍数与拼图

**做法**：取 366 评估中 Agent 实际用的 8 条竖带（`x` 为 0、440…3040，`y` 180，460×520 像素，见 `out/agent-eval/2026-10-18-check-outcome/run-1/366-transcription/dataset/logs/tools.jsonl`），按不同倍数做成图片。由临时 MCP 工具 `show` 返回给模型，让它按从左到右的顺序列出站名，与 `scripts/agent-eval/scenarios/366/truth.json` 的 59 个站名逐字比对。每组 2 次，现行倍数另有 1 次试跑。

| 方式 | 每张输出 | 8 段的图片 tokens | 站名正确（/59） |
|---|---|---|---|
| 原分辨率，8 张 | 460×520 | 约 3.5k | 59、59 |
| 放大 2 倍，8 张 | 920×1040 | 约 10.9k | 59、59 |
| 现行（最长边 1400，2.69 倍），8 张 | 1238×1400 | 约 18.9k | 59、59（试跑 58） |
| 原分辨率拼成 4×2 一张 | 1876×1052 | 约 2.7k | 53、54 |
| 1.5 倍拼成 4×2 一张 | 2796×1572 | 约 3.1k | 52、56 |

图片 tokens 取图片进入上下文前后两次请求的差，含前一次的输出，所以略偏高。

已验证：

- **计费约等于像素数 / 750**：1238×1400（1.7 MP）的单张不降采样，现行 8 张合计 13.85 MP，约 18.9k tokens。4.4 MP 的拼图只按约 2.3 MP 计费，说明服务端把大图压小了：拼图越大，每块的实际分辨率越低。
- **放大不提高站名准确率**：1 倍、2 倍、2.69 倍都是 59/59。
- **拼图明显更差**：四次都低于 366 的通过线 57。错法和评估里见过的一样，是长站名多字、漏字：
  - "坪山区委区政府"写成"坪山区委政府"；
  - "宝安北路南"写成"宝安北路"；
  - "锦龙地铁站"写成"锦龙地铁"。

局限：

- 只测了站名，设施图标与地标这类小标记没有单独测；
- 是单独的转录会话，不是完整的数据定义或数据集轮次；
- 每组只有 2 次。

所以票据 19 的缺省只降到 2 倍，并用同批评估确认。

### 实测 2：Claude Code 对工具结果的上限

临时 MCP 工具 `blob` 返回指定长度的文字，末行是标记，让模型回报看到的最后一行：

| 返回 | 模型拿到 | 结果 |
|---|---|---|
| 45,000 字符 ASCII | 全部，约 25k tokens | 回报了末行 |
| 55,000 字符 ASCII | 2,493 字符的预览，原文转存到 `CLAUDE_CONFIG_DIR` 下 | 模型回答"只能看到前 2KB 预览，看不到最后一行" |
| 30,000 字符中文 | 全部，约 30k tokens | 回报了末行 |
| 45,000 字符中文 | 全部，约 46k tokens | 回报了末行 |

- **已验证**：转存按字符数算，阈值在 45,000 与 55,000 之间。Claude Code 2.1.296 二进制里的常量是 `p0=50000`（工具结果落盘阈值的上限），两者一致。`MAX_MCP_OUTPUT_TOKENS` 的缺省 25,000 没有截断 46k tokens 的中文结果。
- **已验证**：转存的文件在轮次的 `logs/` 下（`CLAUDE_CONFIG_DIR`，`src/agent/run.ts:328`），业务 Agent 用 Glob 搜不到：评估里 Agent 用 Glob 去找，得到 "is outside … --restricted confines the file tools to the working directory"（`out/agent-eval/2026-10-18-check-outcome/run-1/m402-template/template/logs/stream.jsonl`）。
- **更正（2026-10-20 实测）**：按转存提示里的完整路径用 Read 读得到。阿拉伯文站牌试跑的两轮 Gemini 模板设计都这样读了 `schema/template`：第一次被 Read 的 25,000 tokens 上限拒绝，加 `allow_large` 后读回 103,823 字符；`check_templates` 的 121,601 字符问题清单也被整份读回（143,440 字符，`out/arabic-board/r5-template/logs/stream.jsonl`）。原先"读不到"的结论只对 Glob 成立。所以转存的代价是多绕 1–2 轮、再把整份结果读进上下文，读不读、怎么读取决于模型。

### 实测 3：工具输出的大小

用 2026-10-19 评估 run-1 的 M402 模板轮（`out/agent-eval/2026-10-19-dsl-graphic-capabilities/run-1/m402-template/template`）的快照与候选，经 JSON-RPC 直接调：

| 调用 | 文字字符数 | 图片 |
|---|---|---|
| `tools/list`（11 个工具） | 6,121 | — |
| `dsl_reference` `reference/template` | 17,006 | — |
| `dsl_reference` `reference/data-definition` | 4,128 | — |
| `dsl_reference` `schema/template` | **79,116**（超过 50,000，必然转存） | — |
| `dsl_reference` `schema/data-definition` | 8,964 | — |
| `read_document` 编译产物 / 数据集 | 1,796 / 1,845 | — |
| `check_templates`（5 个候选） | 342 | — |
| `render_draft`（省略 dpi） | 395 | 1981×442 |
| `render_draft`（照抄 `docs/request.json`） | 工具错误："只能草稿预览：request.mode 只能是 draft 或省略" | — |
| `inspect_layout` depth 1 / 3 / 20 | 2,966 / 30,193 / **49,070** | — |
| `view_image` 整图 / 450×450 区域 | 138 / 140 | 1400×312 / 1400×1400 |
| `check_outcome` | 440 | — |

`inspect_layout` 的 300 个元素上限（`src/mcp/tools.ts:46`）只限元素数、不限字符数，depth 20 已经贴着 50,000。站数更多、站名更长的模板会越线。

### 实测 4：14 个评估轮次的流日志

范围：`out/agent-eval/` 下 2026-10-18 与 2026-10-19 的全部轮次，Haiku 5.5，MCP 合同 0.4.0–0.5.0。

| 任务 | 轮次 | 模型请求 / `num_turns` | 输出 tokens | 其中思考 | 最后一次请求的上下文 |
|---|---|---|---|---|---|
| 数据定义提取（M402、366） | 6 | 13–18 / 27–51 | 32–59k | 78–87% | 58–121k |
| 数据集提取（366） | 4 | 10–14 / 27–36 | 37–50k | 81–84% | 71–90k |
| 模板辅助设计（M402） | 4 | 21–27 / 35–51 | 78–90k | 74–75% | 118–137k |

- **Agent 已经在并行调工具**：模型请求数只有 `num_turns` 的一半左右。366 数据定义 run-1 有 34 次 `view_image`，18 次请求里 12 次带多个工具调用。所以"一次看多块"省不了几次往返。
- **思考是输出的大头**（已验证，`output_tokens_details.thinking_tokens`）。按 Haiku 4.5 的公开单价推算比例（OpenCode Go 是额度制，只看比例）：输出占每轮费用的 52–63%。图片在 366 数据定义 run-1 里约 42k tokens，是最后上下文的三分之一，其他轮次更少。
- **推断思考留在工具循环的上下文里**：366 数据定义 run-1 的最后上下文 121k，能对上的系统提示、图片与文字约 76k，差额约 45k，与这一轮 46k 的思考 token 相当。文字按 1.5 字符/token 估。
- **工具错误不是 0**：首轮说"所有 `tools.jsonl` 的 `isError` 都是 false"，在它看的两个评估目录里成立。2026-10-19 评估 run-1 有 1 次：Agent 按提示词"request 用 request.json 的内容"照抄，带上了 `"mode": "final"`（`scripts/agent-eval/scenarios/m402/request-template.json` 本身就写着 final），`render_draft` 报错（`src/mcp/tools.ts:447`）。
- **转存 2 次**：都是 `schema/template`，见实测 2、3。
- 每轮都先 Read 全部 `docs/`（5–6 次），366 数据定义 run-1 又用 `dsl_reference` 取了同一份数据定义参考（4,128 字符）。重复不多，不开票。
- `inspect_layout` 用得准：4 个模板轮里用了 0–1 次，用的时候是 `depth: 0` 加 8 个元素路径。首轮 P3 建议改它的提示词，没有必要。

## 逐票意见

| 票据 | 首轮 | 复核后 | 处理 |
|---|---|---|---|
| [16](../.scratch/agent-template-authoring/issues/16-agent-run-task-options.md) | P1 | P1 | 已复现，规格不变；不需要评估 |
| [17](../.scratch/agent-template-authoring/issues/17-check-outcome-revision.md) | P1 | P2 | 排在 24 之后；`changes` 设上限，与 22 同批 |
| [18](../.scratch/agent-template-authoring/issues/18-template-base-matches-dataset.md) | P2 | P3 | 改写为只比主模板，上下文只在一处构造 |
| [19](../.scratch/agent-template-authoring/issues/19-view-image-multiple-regions.md) | P2 | P2 | 拼图被推翻，改为缺省最多放大 2 倍，加可选 `scale` |
| [20](../.scratch/agent-template-authoring/issues/20-template-reference-data-definition-pointer.md) | P2 | P3 | 一行改动，随 22 那批资料改动一起评估 |
| [21](../.scratch/agent-template-authoring/issues/21-eval-retry-transient-errors.md) | P2 | P2，先做 | 改为按轮次重试、429 熔断、`invalid` 的门槛记 `incomplete` |

### 票据 16

已验证：

- `npx tsx out/probe-dataset-arg.ts`：数据集提取只给 `--dataset does-not-exist` 也照常建轮次，`logs/outcome-context.json` 只有 `{"task": "dataset-extraction"}`。数据集 id 根本没被查，因为 `resolveBasis('definition')` 在看数据集之前就返回了（`src/agent/run.ts:454`）。
- `npx tsx out/probe-dataset-request.ts`：抛 `TypeError: Cannot read properties of undefined (reading 'name')`（`src/agent/run.ts:503`）。

规格完整，验收条目能覆盖。只改命令行校验，不动资料与工具合同，不需要跑评估。

### 票据 17

不是"假合格"：修改范围本来就不进结论（M48），审核页的改动表照常列出全部差异。工作副本没改时，`check_outcome` 已经会给提示（`src/agent/outcome.ts:253-255`）。

有记录的 3 次模板辅助修改：

- M215 那次多改了一处道路段宽度上限，是 Agent 有意改的，说明里写明了，审核时接受（`docs/agent-validation.md:479`）；
- 价签那次改动只在要求涉及的三个元素上（`docs/stage3-acceptance.md:84`）；
- 366 那次只改了站点列的三处（`docs/stage3-acceptance.md:118`、`docs/stage3-acceptance.md:142-147`）。

没有见到"无意中改多"。本票的价值是防无意改动，只有修改场景的范围评分才量得出来，现有三个评估场景都不经过模板辅助修改。所以降为 P2，`Blocked by: 24`。另加两条：

- `changes` 最多 100 条；
- 与 22 同批发 0.6.0。

### 票据 18

**原判据有错**：模板辅助设计的候选全是新建模板，"对新建模板比较 base"会把被调模板也拿去比。被调模板以数据定义引用的那份定义为基准，本来就和主模板不同。

- M402 专家模板：主模板"线路牌 v1"，被调模板"停靠站点 v1""单值·时刻 v1""单值·文本 v1"（`docs/examples/m402-dsl/template-*.json` 第 4 行）；
- 提示词也只要求主模板的基准是 `{definition}`（`agent/tasks/template-design.md:14`）。

照原规格实现，4 次模板评估全部会变成不合格。

**原方案还漏了一处**：上下文在 `run.ts:310-314` 与 `review.ts:659-660` 分别构造，只改前者，审核视图与应用前的复查（`src/agent/review.ts:528`、`src/agent/review.ts:809-810`）就和 `check_outcome` 判据不同。

缺口本身是真的，但 4 次模板轮都用出图请求的数据集出过草稿，`datasetStaticSchemaMismatch` 会先挡住，没有实际发生过，所以降为 P3。更彻底的做法是让 `check_outcome` 对模板任务按出图请求出一次草稿、把 blocked 计入结论，但这改变 M48 的口径，写在票据的"不在本票"里，要先拍板。

### 票据 19

原方案的两条依据都不成立：

- **图片张数上限**："61–63 张图片报 400"是 Step 5 Preview 经代理时的现象（`docs/stage3-acceptance.md:244`），该模型已停测，OpenAI 格式也不再支持（M232）。Haiku 5.5 单轮最多 34 张图没有报错。
- **往返次数**：Agent 本来就并行调 `view_image`，见实测 4。

真正的浪费在放大：460×520 的竖带被放大到 1238×1400，tokens 是原分辨率的 5 倍多，准确率不变；拼图反而降低准确率（实测 1）。

新方案：缺省最多放大 2 倍，加可选 `scale`（1–4）；不做拼图。只降到 2 倍、不直接到 1 倍，是因为小标记没单独测；同批评估里设施或地标掉了，就退回 3 倍。

### 票据 20

指向错误属实（`agent/reference/template.md:129`），全目录只有这一处失效的交叉引用。但 4 个模板评估轮没有一次去找"胸牌 v1"，实际影响为零。一行改动不值得单独花一次评估，随 22 那批资料改动一起跑。

### 票据 21

方向对，原写法有三处要改：

- **重试粒度**：366 单元有两轮，中间还模拟审核并应用（`scripts/agent-eval/eval.ts:119-122`）。清掉整个单元重试会丢掉已完成的第一轮，要按轮次重试。
- **429**：OpenCode Go 的 429 是 5 小时额度窗口，各模型共用一个池（M231），30s/90s/180s 的退避只会再撞三次。改为熔断：停止派发剩下的单元，打印续跑命令。
- **门槛语义**：门槛按连续达线算（`scripts/agent-eval/eval.ts:219-224`），只写"`invalid` 不计入"时，1 次达线加 1 次 `invalid` 的结论没有定义。规定为 `incomplete`，退出码 3。

500 的原文是 Claude Code 自己重试之后才报出来的（`out/agent-eval/2026-10-18-check-outcome-366.interrupted-500.log`），外层 2 次就够。之后每次评估都要用到它，所以排在最前。

## 新发现

### 新发现 1：MCP 输出超过 50,000 字符时 Agent 拿不到

见实测 2、3。`schema/template` 已经在 2/4 个模板评估轮中被转存，两次 Agent 都没拿到 Schema。`inspect_layout` depth 20 已到 49,070 字符。

> 2026-10-20 更正：标题的"拿不到"只对 Glob 成立。Gemini 按转存提示的路径用 Read（加 `allow_large`）读回了整份结果，见实测 2 的更正。票据 22 的理由改为：转存让 Agent 多绕 1–2 轮、把整份结果读进上下文，而且读不读取决于模型（Haiku 用 Glob 找，没读到；Gemini 用 Read，读到了）。

`tools.jsonl` 不记输出大小，评估报告也不查转存，这类问题只有翻 `stream.jsonl` 才看得到。

开 [票据 22](../.scratch/agent-template-authoring/issues/22-mcp-output-within-client-limits.md)，P2：

- 工具文字结果统一不超过 40,000 字符；
- `dsl_reference` 支持 JSON Pointer，不带时返回目录；
- `inspect_layout` 按字符预算截断；
- 问题清单设上限；
- `tools.jsonl` 记 `chars`，评估报告统计转存与截断。

同批放进两件小事：

- `render_draft`、`inspect_layout` 收到 `mode: "final"` 时按草稿出图并注明，不再报错；
- 首轮 P3 的 `annotations`。

### 新发现 2：思考 token 是最大的成本与耗时来源

见实测 4。`agent run` 的子进程环境没有设 `MAX_THINKING_TOKENS`（`src/agent/run.ts:323-332`），`readUsage` 也不记思考 token（`src/agent/run.ts:565-567`）。

开 [票据 23](../.scratch/agent-template-authoring/issues/23-agent-thinking-budget.md)，P2：加参数、记录用量。先用一轮确认这个变量对 OpenCode Go 上的 Haiku 5.5 生效，再在 `m402-template` 与 `366-transcription` 上做 16k、8k 两档对照。

切换条件写在票据里：门槛通过、成绩不低于近三份报告的最低值，且输出 token 降 30% 以上。

### 新发现 3：模板辅助修改与下一轮没有自动评估

首轮列在"未决"里。素材其实都已入库并校准过：

- 修改前模板 `fixtures/agent-eval/templates/first-test/`：压测 6/10，版面 0/2；
- 修改要求 `scripts/agent-eval/scenarios/m402/requirement-m215.md`：正好针对那两项版面问题；
- 修改后参照 `fixtures/agent-eval/templates/t07-round2/`：压测 10/10，版面 2/2；
- 评分断言在 `test/agent-eval.test.ts:79-88`。

开 [票据 24](../.scratch/agent-template-authoring/issues/24-eval-template-revision-scenario.md)，P2：`m402-revision` 场景按版面检查、压测与修改范围（用 `revisionDiff`）评分，是票据 17 的对照基线。带反馈的下一轮评分口径要另定，先不做。

### 首轮 P3 的看法

- **`agent run` 墙钟超时**：同意 P3。评估中最长一轮 18.2 分钟，没有卡死的记录。
- **`round.json` 记 prompt 与资料哈希、合同版本**：同意 P3。评估报告已经记了资料哈希与合同版本，只有单独代建的轮次缺。
- **`check_dataset` 返回统计**：价值低。366 的错都是长站名里错一个字，项数统计发现不了；不做。
- **`annotations`**：并入票据 22。
- **`dsl_reference` 分段**：不再是 P3，并入票据 22（`schema/template` 实际已经用不了）。
- **`inspect_layout` 的提示词**：不改，见实测 4。

## 落地顺序

1. **16**：命令行校验，不需要评估。**21**：只改评估脚本，之后的评估都靠它区分上游故障。两张可以并行。
2. **24**：新场景先跑 2 次，拿到 Haiku 5.5 在现合同上的修改基线。
3. **0.6.0 一批**：22（含 `mode` 与 `annotations`）、19、17、18，加上资料改动 20。四个场景各跑 2 次，只算一次"改了之后跑"。合格标准：
   - 门槛通过；
   - 报告的转存计数为 0；
   - 366 三项不低于近三份报告的最低值；
   - 记下图片 token 的变化。
4. **23**：思考预算对照评估，按切换条件定缺省。

阶段 4 的票据顺序不变。上面 1 是插队修复；2–4 都要跑评估，各约半小时到一小时，可以排在阶段 4 票据的间隙。

## 复现

都在仓库根目录执行。需要 `npm run build` 之后的 `dist/`；会调用模型的脚本只从环境变量 `OPEN_CODE_API_KEY` 读 key，不写文件、不打印。

```bash
node out/probe-tooling-2/analyze-streams.mjs out/agent-eval
```

```bash
node out/probe-tooling-2/compose.mjs out/agent-eval/2026-10-18-check-outcome/run-1/m402-template/template/logs/stream.jsonl
```

```bash
node out/probe-tooling-2/mcp-probe.mjs . out/agent-eval/2026-10-19-dsl-graphic-capabilities/run-1/m402-template/template out/probe-tooling-2/calls-template.json
```

```bash
CLAUDE_EXE=<claude.exe 的路径> node out/probe-tooling-2/vision-bench-cc.mjs . out/probe-tooling-2/vb 2
```

```bash
CLAUDE_EXE=<claude.exe 的路径> node out/probe-tooling-2/blob-test.mjs out/probe-tooling-2/blob 45000:ascii,55000:ascii,30000:cjk,45000:cjk
```

- 前三条不调用模型。
- 后两条各起若干个无头 Claude Code 会话，参数与 `agent run` 相同（`--restricted`、`--strict-mcp-config`、只放行一个 MCP 服务）。OpenCode Go 不接受不带会话头的直接 API 调用，所以只经 Claude Code 调用。
- 本机的 `claude` 是 npm 装的 `.cmd` 包装，`spawn` 不经 shell 时要直接给 `claude.exe`。
- 首轮复核的两个探针仍在 `out/probe-dataset-arg.ts`、`out/probe-dataset-request.ts`。
