# 资料策略候选与配对准备

`agent run --context-policy full|on-demand` 显式选择资料策略，缺省仍为 `full`，不改变 effort、模型、轮数或整轮预算。评估入口 `scripts/agent-eval/run.ts` 接受同一参数。当前只验证候选机制，没有真实模型配对观测，不宣称节约 token、人工时间或提高质量；默认是否改变归票据18。

## 入口与资料身份

`full` 保留原任务的 `docs/dsl-reference.md` 全量路径。`on-demand` 先读 `docs/constraints.md`、`guide.md`、`outcome.md`、项目说明以及已提供的领域、修改要求和反馈。命名、单位、作用域、成果交回、能力限制与素材信任边界仍在入口可见。

约束从现有 DSL 参考逐字选取，`agent/context-catalog.json` 只提供阶段、工具名称和章节定位：数据、布局、循环/子模板、文字适配、变量、状态与 Schema。目录不定义新语法。`heading` 是返回原文里的章节提示；普通参考仍整份返回，Schema 可按现有 JSON Pointer 续取。目录缺项或章节失效应报错，不能猜测规则。

宿主一次固定七份公开参考和 Schema 到私有 `logs/reference-materials.json`，本轮入口摘录与 `dsl_reference` 读取同一组字节。`round.json.inputs.contextPolicy` 保存策略名、身份、入口文件摘要和全部可用公开资料摘要；实际提示词与材料摘要继续进入原有 provenance。MCP 启动后参考内容固定，即使文件随后变化也不替换本会话。缺少固定资料时拒绝启动。

实验身份额外保存策略范围及所有实际源文件摘要。身份只证明资料版本，不是质量或成本证据。`--from` 的新轮次依新运行参数选择策略；不传时仍为 full。

## 完整问题的分页

两种策略都能用只读 `outcome_feedback`。先调用 `check_outcome`，取 `feedback.reportId`，再按 `groupBy: code|target`、`offset` 与 `limit` 读取；保持同一分组方式，使用返回的 `nextOffset` 直到 null。`groups` 保留代码、目标、位置、实例、源模板及原始差异上下文。`unknownTotal` 单独计数，`coverageStatus`、`visualStatus`、渲染状态和能力受阻不会因压缩消失。

首次结果遇到合法长名称、大量候选或布局仍超过总预算时，返回 `detailsTruncated: true` 的固定大小状态与计数摘要，保留内容身份及分页入口。候选名称/路径、异常与未知细节仍可逐页取得；不能用首响应的空明细数组判定没有问题。非保存检查点的超长原因显式标记 `reasonTruncated`，不冒充完整诊断。

每页绑定原 `contentIdentity`，`currentBytesChecked: false` 明确表示这是原检查的续页。读页不重新检查、不发布检查点、不创造修复机会。修改候选后须重新 `check_outcome`；同一会话下次检查会使旧 `reportId` 失效，错误ID或越界offset返回工具错误。

单项超过5000字符时，完整条目作为 JSON 字符片段返回，`detail` 中有 `itemId/index/total/encoding/fragment`。按同一 itemId 的 index 拼接后 JSON.parse，必须取得全部分片。代码或目标过长时仅分组键缩短，原值保留在可还原条目里。每页约22000字符条目预算，最多100个条目/片段；`truncated` 与 `nextOffset` 明示后续页。`total` 是分页条目/片段数，`issueTotal` 是原条目数，未知数按原条目计。不能只读第一页就假定已取得所有必修问题或未知范围。

## 离线核对与校准

先构建，再运行公开工具指针检查：

```powershell
npm run build
node --import tsx scripts/agent-eval/context.ts --check out/context-check.json
```

检查实际 MCP `tools/list` 与 `dsl_reference`，核对目录章节、JSON Pointer 和 `docs/examples/m402-dsl` 共享样例及对应 Schema。报告逐项列出 `passed` 与 `unresolved`；候选可用时 `candidateReady: true`，但原资料错误仍标 `known-unresolved`。模板参考将数据定义指回 `docs/dsl-reference.md` 的旧错误继续归原 `agent-template-authoring/20`，不在本票修复，也不记为通过。候选正确使用 `reference/data-definition`。新增断链使 candidateReady 为 false、退出码1；已有报告不能覆盖。

票14的合成校准输入可准备两份同条件计划：

```powershell
node --import tsx scripts/agent-eval/prepare-feedback.ts --out out/context-calibration --resources fixtures/resources
node --import tsx scripts/agent-eval/context.ts --prepare-pair out/context-pair --config out/context-calibration/config.json --jobs 1 --repeat 2 --model claude-haiku-5-5
```

该步骤只探测执行器版本、核对资料与冻结身份，不派发模型。只接受票14预登记的合成校准来源，未读留出结果。缺少场景材料时保存 `ready: false`、空 arms 和缺项，退出码3，不补造身份。目录已存在时拒绝覆盖。

`pair.json` 的两个 arms 保存完整 identity、identityHash 和对应 `run.ts` arguments：同一模型、执行器、effort、预算、样本、两次重复、配对调度条件；仅 contextPolicy 不同。可显式给 `--small-model`、`--endpoint`、`--effort`、`--max-turns`、`--timeout-ms`、`--claude`、`--claude-args`，它们同样冻结。后续运行使用某 arm 的完整 arguments，加 `--context-pair <pair.json>`、独立 `--out/--reports/--label` 与 `--key-env`；条件漂移在派发前拒绝，不能覆盖原实验。分段可用原有 `--repetitions`，不改变计划次数。

本票公开验收使用受控假执行器和真实 MCP，在中文/英文四类任务读取目录、取得完整反馈并纠偏。受控执行器证明流程可执行，不能计作真实模型改善。票18须另登记收益判据并完成两策略真实配对，失败或资料不足如实保留；原始业务质量、未知、关键错误、越界与全尝试成本均不能被节约指标掩盖。
