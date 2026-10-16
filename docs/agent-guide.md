# 代建指南：用 Agent 把一张示例图做成可出图的模板

照本页用一张示例图走完代建：

1. 提取数据定义，审核后发布；
2. 提取一份数据集，审核后保存；
3. 设计模板，审核后保存，然后正式出图；
4. 按客户意见修改模板。

全程只用 `renderweave` 命令与本机的审核页，不需要读代码，也不手工复制或改写工作区里的文件。各轮的用时见文末「用时与用量参考」。命令细节见 [业务 Agent 任务](agent-tasks.md)，交给 Agent 的资料见 [agent/README.md](../agent/README.md)。

## 准备

**软件**：Node.js 22 或以上，以及 Claude Code（`claude --version` 能运行即可，它只作为 Agent 的运行环境）。在仓库根目录执行一次：

```powershell
npm ci
npm run fetch-fonts
npm run build
```

约定：

- 本页命令都在仓库根目录、PowerShell 中执行；`node dist/bin.js` 就是 renderweave 命令行。Linux shell 写法相同，只是续行符把行尾的反引号换成 `\`。
- 成果放在 `out/build/`（不进版本库）。每轮的轮次目录必须是新目录，已存在就换个名字。
- 用 `$LASTEXITCODE` 看退出码。`agent run`：0 成果合格，1 不合格（问题清单在 `check.json`），2 用法错误。

**key**：模型的 key 只放在环境变量里，renderweave 不会把它写进任何文件，也不会打印。缺省读 `QWEN_TOKEN_PLAN_API_KEY`（千问 token plan）。在 Windows 的"编辑账户的环境变量"里新建它，然后重开终端。不要把 key 写进命令行或脚本。

换模型或端点时，用 `--model`、`--small-model`、`--endpoint` 与 `--key-env <变量名>` 指定。换之前要跑一次评估门槛并达线，见 [Agent 评估](agent-eval.md)。已达线的另一组是 OpenCode Go 套餐上的 Claude Haiku 5.5，第三阶段验收的端到端代建用的就是它。key 放在环境变量 `OPEN_CODE_API_KEY`，每条 `agent run` 命令末尾加上：

```powershell
--model claude-haiku-5-5 --small-model claude-haiku-5-5 --endpoint https://opencode.ai/inference/go/anthropic --key-env OPEN_CODE_API_KEY
```

示例图、项目说明与工作区快照会发给所选的模型服务，客户资料能否外发要先确认。OpenCode Go 按 5 小时、每周、每月三个窗口计额度，窗口用完时报 429，见第 2 步的"模型服务报错"。实测几个模型的 5 小时窗口在同一时刻用完，按共用一个池对待，不要同时跑太多轮。

**资源仓库与工作区**：

- 资源仓库存放模板要用的字体与图片。正式出图要求版本仓库，建法见[使用指南](guide.md)第 2 步。下面的例子直接用仓库里的 `fixtures/resources`（发起任务与审核预览可以用），出图时换成版本仓库。
- 工作区是一个目录，放已发布的数据定义、数据集与模板。新项目从空目录开始：

```powershell
New-Item -ItemType Directory -Force out/build/workspace | Out-Null
```

## 1. 写项目说明

项目说明只写这一单的事实：业务、示例图的实际尺寸、目标范围、命名、客户说明。不写做法，做法在通用指南与领域约定里。复制模板 [agent/briefs/_template.md](../agent/briefs/_template.md) 后填写；填好的例子见 `scripts/agent-eval/scenarios/m402/`。

```powershell
New-Item -ItemType Directory -Force out/build/briefs | Out-Null
Copy-Item agent/briefs/_template.md out/build/briefs/brief-definition.md
notepad out/build/briefs/brief-definition.md
```

各步可以共用一份项目说明，也可以各写一份。数据集提取要写数据集 id；模板辅助设计要写主模板名与对外参数。

**领域约定**：已有的领域（`agent/domains/` 下的文件，目前有公交线路牌 `route-sign` 与超市商品价签 `price-tag`）用 `--domain` 选上。没有约定包的新领域也能做：Agent 会按通用做法判断，把领域知识的缺口列为待确认项。同一领域会反复做的，按 [agent/domains/_template.md](../agent/domains/_template.md) 写一份约定包，写法与归属规则见 [agent/README.md](../agent/README.md)。

## 2. 数据定义提取

```powershell
node dist/bin.js agent run --task 数据定义提取 --sample <示例图> --brief out/build/briefs/brief-definition.md `
  --domain route-sign --resources fixtures/resources --out out/build/r1-definition
```

- 没有领域约定包时去掉 `--domain`。
- 标准输出是一段摘要：轮次目录、结论（`qualified` 合格）、候选文件、待确认项数与用量。
- 不合格时，标准错误流与 `check.json` 列出问题。不会自动重试；可以带着问题清单发起下一轮（见第 7 步），也可以重新发起。
- 标准错误流里出现"模型服务报错"，例如 429 额度用完，说明问题出在模型服务，与成果无关，等额度恢复或换端点后再发起。

## 3. 审核

```powershell
node dist/bin.js agent review out/build/r1-definition
```

浏览器会打开本机的审核页。审核结果随时存进轮次目录的 `review.json`，关掉页面后再执行同一命令就能接着审。按 Ctrl+C 结束服务。

1. **对照示例图**：字段清单中有"定位"的，点一下就在示例图上框出它对应的部分。图可以放大，单击放大、Shift+单击缩小。
2. **逐项处理待确认项**：每项有原因（看不清、推测、来源冲突、必填未提供）、Agent 的说明与候选值。三种处理：
   - **采纳候选**；
   - **改值**：在文本框里写新值，数据定义中是整个字段的 JSON；
   - **标为空**：删去这个字段，或这个值、这个元素。
3. **整体确认**：待确认项以外的内容核对无误后，勾选"已整体核对"。
4. **给出结论**：
   - 没问题就点"审核通过"；
   - 有问题点"审核不通过"，理由写清楚，例如"运营方要建成字段"，然后按第 7 步带着反馈重做。

"还不能通过的原因"一栏列出未处理的待确认项与严重问题，清空之后才能通过。

## 4. 应用

```powershell
node dist/bin.js agent apply out/build/r1-definition --workspace out/build/workspace
```

- 数据定义发布为静态数据定义，文件名如 `schema-<名称>-v1.json` 与编译产物；数据集与模板保存为新文件。
- 工作区自发起之后被改过时拒绝应用，并列出差异。确认后加 `--overwrite` 按当前工作区写入，或按第 7 步基于最新内容重做。
- 应用失败时工作区保持原状；同一轮不能应用两次。

## 5. 数据集提取

数据集提取要基于已发布的数据定义。用 `--definition` 写定义的名称，只写名称时取最新版本，也可以写成 `名称@版本`。

```powershell
node dist/bin.js agent run --task 数据集提取 --definition <数据定义名称> --workspace out/build/workspace `
  --sample <示例图> --brief out/build/briefs/brief-dataset.md --domain route-sign --resources fixtures/resources --out out/build/r2-dataset
```

- **审核**：审核页列出每一个值。看不清、推测的值是待确认项，**全部处理完才能通过**，所以推测值不会被当成真实数据写入。
- **应用**：审核与应用同第 3、4 步，应用后工作区多一个 `dataset-<名称>.json`。
- **空白版式**：示例图上没有具体值时（例如空白价签），在项目说明里写出要录入的样例数据，Agent 按它填写。
- **预览**：工作区已有模板时，加 `--request <出图请求>`，审核页会用这份数据集渲染预览。

## 6. 模板辅助设计

先写示例图对应的出图请求：主模板名、对外参数与实际尺寸。主模板名要与项目说明一致；`dataset` 可以省略，由 `--dataset` 填入。

```json
{
  "template": "线路牌主模板",
  "parameters": { "currentIndex": 5 },
  "output": { "width": 740, "height": 165, "dpi": 50, "format": "png" },
  "mode": "final"
}
```

```powershell
node dist/bin.js agent run --task 模板辅助设计 --dataset <数据集id> --request out/build/request.json --workspace out/build/workspace `
  --sample <示例图> --brief out/build/briefs/brief-template.md --domain route-sign --resources fixtures/resources --out out/build/r3-template
node dist/bin.js agent review out/build/r3-template
```

审核页把示例图与 RenderWeave 重新渲染的预览上下对照，两图联动缩放。预览不用 Agent 自己画的图。

- 用"适应""200%"与单击放大，逐段对照版面：字号、对齐、颜色、可选元素的位置。
- 元素清单列出每个元素与它在示例图上的位置；待确认项多是 Agent 估计的颜色、字体与尺寸。
- 预览有严重问题时不能通过。

审核通过后应用，工作区多出 `template-<名称>.json`。

## 7. 正式出图

把一个或多个出图项写进批次请求。数据集可以引用工作区中的 id，也可以直接写在批次里，适合样例数据。下面出两张：

```json
{
  "template": "线路牌主模板",
  "mode": "final",
  "items": [
    { "id": "current-5", "dataset": { "id": "<数据集id>" }, "parameters": { "currentIndex": 5 }, "output": { "width": 740, "height": 165, "dpi": 120, "format": "png" } },
    { "id": "no-current", "dataset": { "id": "<数据集id>" }, "parameters": { "currentIndex": 0 }, "output": { "width": 740, "height": 165, "dpi": 120, "format": "png" } }
  ]
}
```

正式出图只接受资源版本仓库，前面各步用的 `fixtures/resources` 不行。第一次出图前建一个，把同样的资源导入进去：

```powershell
node dist/bin.js resources-init --resources out/build/resources
node dist/bin.js resources-import --source fixtures/resources --resources out/build/resources
node dist/bin.js deliver --workspace out/build/workspace --resources out/build/resources --request out/build/batch.json --out out/build/batch
```

每项一个目录，内有图片、问题清单与出图记录。失败项的定位、记录读取与重放见[使用指南](guide.md)。

## 8. 修改与返工

**审核不通过，或成果不合格**：带着反馈发起下一轮。

```powershell
node dist/bin.js agent run --from out/build/r3-template --feedback out/build/feedback.md --out out/build/r3-template-2
```

- 反馈是一份 Markdown，写清哪里不对、要怎样。
- 下一轮沿用上一轮的任务、示例图、项目说明、基准与出图请求，命令行不能再给；工作区会重新取快照。
- Agent 拿到上一轮的成果（含你在审核时的修改）、原样记录与反馈，在上一轮的基础上改。
- 审核页的"轮次"一栏列出整条轮次链。

**已保存的模板要改**：用模板辅助修改。修改要求写成 Markdown，可以用反引号写元素路径，从模板名开始，例如 `` `商品价签/会员价标签` ``，路径必须存在。最好先正式出几张图，看着成品写要求，例子见 `scripts/agent-eval/scenarios/price-tag/requirement-revision.md`。

```powershell
node dist/bin.js agent run --task 模板辅助修改 --dataset <数据集id> --request out/build/request.json --requirement out/build/requirement.md `
  --workspace out/build/workspace --sample <示例图> --brief out/build/briefs/brief-template.md --domain route-sign `
  --resources fixtures/resources --out out/build/r4-revision
node dist/bin.js agent review out/build/r4-revision
node dist/bin.js agent apply out/build/r4-revision
```

- **可以改的范围**：出图请求的主模板及它调用的模板。它们先复制为工作副本，Agent 在副本上改。
- **数据集**：预览用已保存的数据集。第 6 步的出图请求没写数据集，所以要加 `--dataset`；请求里已写 `"dataset": {"id": …}` 时可以不加。
- **审核页**：多一张"修改前"的预览，模板卡片上有逐项的改动表（位置、属性、修改前、修改后）。不在修改要求里的改动也在表里，看清楚再决定是否接受。
- **应用**：工作副本替换已保存的模板，没改的不写。
- **冲突**：如果这段时间里别人保存过同一个模板，应用会被拒绝，并列出别人的改动。由你选择：
  - 加 `--overwrite` 覆盖，别人的改动会丢失；
  - 用 `--from` 重做，候选从最新保存的内容开始。

## 用时与用量参考

以下是 qwen3.8-max 在 M402、366 上的实测，每轮从发起到交回成果。审核与写说明的人工时间另计，第三阶段验收文档有逐步记录。

| 轮次 | 用时 | 输出 tokens |
|---|---|---|
| 数据定义提取 | 11–19 分钟 | 3.5–5.5 万 |
| 数据集提取 | 14–24 分钟 | 4.3–5.4 万 |
| 模板辅助设计 | 30–50 分钟 | 8.6–11.6 万 |
| 模板辅助修改 | 18–23 分钟 | 4–6.6 万 |

每轮的用时、轮数、token 与实际服务的模型记在轮次目录的 `round.json`，审核页底部也会显示。
