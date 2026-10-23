# 订单、完整成本与人工投入

订单报告把同一批预登记业务订单中的计划、实际尝试、审核和正式出图串起来。入口是 `agent order-init`、`agent order-record`、`agent order-report`；报告只读取现有 Agent、评估与出图记录，不启动模型，不应用候选。M323。

## 开始前固定统计范围

先准备 `orders.json`；目录用绝对路径，`root` 是该计划所有轮次共同的专用父目录，失败、接续和恢复也写在其中。计划的任务类型沿用 `agent run --task` 四种值。不要只指向最后成功轮次。每个正式输出有自己的标识和完整单项请求；定义提取等不要求出图的计划可用空 `deliveries`，订单仍须每个计划至少有一次有效应用才算成功。

```json
{
  "format": "renderweave-order-scope/1",
  "id": "batch-20261023",
  "orders": [{
    "id": "order-a",
    "plans": [{"id": "design", "task": "template-design", "root": "F:/orders/a/rounds"}],
    "deliveries": [{
      "id": "image-a", "plan": "design",
      "request": {"template": "线路牌", "dataset": {"id": "ds-route"}, "mode": "final", "output": {"width": 300, "height": 200, "dpi": 120, "format": "png"}}
    }]
  }]
}
```

请求的实际字段和尺寸沿用[渲染请求](dsl/requests.md)，使用项目已验证的请求。草稿不能作为订单正式交付。同一任务的两个计划目录不能重叠。登记是一次性操作，已有目录拒绝覆盖；`scope.json` 固定范围、声明时间与摘要。

```powershell
node dist/bin.js agent order-init --scope orders.json --out F:/orders/register
node dist/bin.js agent run --task template-design --out F:/orders/a/rounds/round-1 ...
```

后续照常运行、接续、审核、应用、`deliver`。评估计划可以登记单元目录（含 `attempts`）：唯一原件和兼容阶段按执行身份去重，读取前验证尝试封存；旧评估已经丢失的重试不会补造。所有复核都使用现有公共记录，不依赖进程内对象。

## 记录人工工作与业务结论

每项工作使用稳定且唯一的事件 `id`。以下 JSON 存为 `event.json`，再运行 `agent order-record`；重复提交相同 `id` 和相同内容返回原事件，不再累计，改变内容会拒绝。

```json
{"id":"review-1","kind":"labor","order":"order-a","plan":"design","round":"F:/orders/a/rounds/round-1","category":"review","minutes":3}
```

`category` 分别为 `review`（审核）、`correction`（人工修正）、`rework`（返工）；必须明确填非负分钟，实际为零也需明确记录。一个计划某类没有事件时，其已知小计是 0，`unknownPlans` 是 1，不把未记录当作没花时间。

```json
{"id":"quality-original","kind":"assessment","order":"order-a","plan":"design","round":"F:/orders/a/rounds/round-1","phase":"original","result":"fail"}
```

`phase` 为 `original` 或 `corrected`，`result` 为 `pass` 或 `fail`。这是人工业务判断，技术 `qualified` 不替代它。原始结论绑定不变的轮次及成果；修正后结论另绑定审核有效内容身份。后来再次修改成果时，旧结论仍在审计记录中，但不能给当前成果作通过证明。相同成果的互相矛盾结论显示 `conflicting`，不自动选择较好的结论。人工修正不会把原始失败变成 Agent 首次成功；订单首次成功要求每个计划的首次尝试都有原始通过结论，且历史完整。

```powershell
node dist/bin.js agent order-record --order F:/orders/register --event event.json
```

人工事件使用原子写入并保留内容摘要。摘要用于发现文件变化，不是签名，也不声称抵抗能同时改写内容及摘要的本机操作者。

## 登记正式交付

审核通过并应用后，运行 `deliver`；把批次 `batch.json` 中成功项的记录目录登记到预先声明的输出。

```json
{"id":"delivery-1","kind":"delivery","order":"order-a","plan":"design","round":"F:/orders/a/rounds/round-1","delivery":"image-a","record":"F:/orders/a/output/items/000001"}
```

登记会复核应用凭据、正式出图记录的完整性、请求、有效候选、可达模板/数据/定义及已使用资源。应在应用后、工作区下一次修改前立即登记：当前工作区若已改变，不能事后补认该成品属于旧应用。登记完成后，之后工作区修改不影响已固定的成品归属；报告仍核对原应用凭据和正式出图记录。重复登记同一输出或重复查询不增加成功次数，全部计划应用成功且全部声明输出完成才算订单交付成功。

## 阅读成本报告与分享摘要

```powershell
node dist/bin.js agent order-report --order F:/orders/register > local-report.json
node dist/bin.js agent order-report --order F:/orders/register --share > share.json
```

- `counts` 分开列订单、计划、尝试、成功订单数量。`model` 的有效、invalid、未知尝试是模型观察口径；invalid 仍计入订单成本与交付记录。
- 各订单以及整体的 `totals.usage` 分别列原始用量的 `known` 小计和 `unknownAttempts`。包括成功、失败、中断、重试和建立轮次前的派发失败。thinking 是 output 的子集，单独显示，不另加进总输出或金额。
- `timing.knownExecutionWallMs` 是已知执行区间的并集，不重复累计并行区间；`executionWallMs` 在区间不完整时为 null。`attemptsElapsedMs` 是各尝试耗时之和，另有未知耗时数量。`actualWallMs` 只有整批交付完成且有明确结束事件时才给出登记到最后交付的持续时间；未完订单、人工作业间隙和未知结束不会凭空补齐。
- `history` 列出旧记录、范围外前序轮次、登记前已开始的尝试和未知开始时间。历史不完整时保留已知成本，但不声称完整估算或 Agent 首次成功。
- `costPerSuccessfulOrder` 的分子是登记范围内**所有订单**的尝试与已知人工时间，包括没有成功的订单；分母仅为已完成所需正式出图的成功应用订单。成功数为 0 时为 null；完整性字段区分已知小计与完整成本。单笔订单成本在 `orders` 中独立列出。

本地报告保留来源目录、原始检查身份、恢复检查点、审核和应用关联。分享摘要使用白名单，只输出枚举、数值和必要内容身份/摘要；不复制提示词、原图、业务备注、错误原文、本机路径或凭据。`reproductionBundle:false` 表示它不能代替完整复现包；原件应留在访问受控的本地目录中。

## 可选金额估算

缺省 `amount.value:null`、`reason:pricing-unavailable`。不把订阅费猜成 token 单价，也不猜远端进程何时停止收费。

如果确有提供方计价版本，可在登记前的 scope 中加入 `pricing`，同时提供 `version`、`provider`、三位币种 `currency`、准确的 `endpoint` 与服务返回的 `model`、`basis:"separate-input-output-cache"`，以及 `perMillion` 的四个非负费率：`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheCreationTokens`。操作者负责核准提供方版本和这四类互不重复的计价口径；本工具只按固定费率算术估算，不是账单核验。

仅当全部已记录尝试的历史、四类用量、提供方端点与实际服务模型都可核对时才给金额。任一未知、模型或提供方不匹配即返回未知，仍显示原始用量。返回 `pricingIdentity` 固定所用版本和费率，thinking 不重复乘单价。多提供方或无法归入该四类的复杂计费目前不估算，可使用原始用量另行核账。

## 兼容与边界

新增的 scope/register/event/report/share 为各自的 `/1` 格式，不改变旧轮次、尝试、应用或出图记录的合同。旧轮次缺失的用量、开始时间、历史尝试和人工分钟保持未知。未封存的活动轮次只反映当前可读的完整事实，继续运行后应重新查询。文件完整性错误会阻止出具汇总，不静默跳过记录。它提供后续留出、人工审核和真人走查的记录能力，本票的受控执行器回归不计真实模型质量证据。