# Agent 保留候选与逐项比较

宿主每次完整检查后更新最后完整候选。只有对同一依据下的已有完整候选证明改善，才另存有证据较好的候选；第一次保存只作为比较起点。`agent review` 同时展示两份完整内容、内容身份、检查结果和逐项 JSON 差异。正式交回仍使用作者最终提交的字节，不被保留候选替换。决定见 M320、ADR-0024。

## 可比较关系

`comparisonBasis` 绑定任务、固定工作区文件和所选数据定义/数据集、完整固定资源清单、请求、核准参考及参考图字节、说明/修改要求/反馈/授权模板范围、构建与判据。任一不同或历史身份缺失，结果为 `incomparable`，并列出不同依据。候选自身哈希不在比较依据内，候选改变并不证明质量改变。

使用完整检查结果，不能从经过截断的工具摘要或 Agent 自述评分。现有核准维度为：

| 维度 | 比较方式 |
|---|---|
| 内容覆盖 | 逐项缺失与异常，保留事实 ID、路径、异常种类；同数量但换成新错误也算退步 |
| 文字、颜色、图片、可见性等既有样式异常 | 按核准区域、实例路径及异常种类逐项核对，不以异常总数抵消 |
| 核准字号、框尺寸、位置 | 逐实例及轴的实际偏差；仍在异常范围内但偏差减小可构成改善，已在核准容差内的数值变化不制造改善 |
| 未知与待确认 | 核准测量的未知和清单待确认位置逐项保留；新增未知阻止晋升，错误转为未知不计收益 |

新候选结构与候选技术校验须有效，实际渲染不得受阻；既有候选校验负责授权修改范围。满足这些条件、没有已核查维度退步或新增未知、至少一个核准指标改善，才为 `improved` 并更新较好候选。只有退步为 `regressed`，有得有失/无可信事实/依据不同为 `incomparable`，没有可证改善为 `unchanged`，首份为 `uncompared`。没有核准事实的任务不会仅凭合法 JSON 获选。

“较好”是保守的相对关系，不表示业务全部合格。保留检查中仍有的缺项、样式异常与未核查范围；不增加新的视觉能力或自动批准。它也不是候选集合的全局最优搜索。

## 持久合同与公开读取

`checkpoint.json` 升为 `renderweave-checkpoint-ref/2`：顶层 `id`/`sha256` 指向最后完整集合；`history` 只列已原子发布的完整集合；`selection` 是 `renderweave-candidate-selection/1`，包含起点 `baseline`、可选 `better` 及其改善证据 `betterProof`、最后完整候选相对保留候选（尚无则相对起点）的 `comparison`。这些字段在同一个原子指针中发布，不会出现最新集合已变而选择证据仍旧的半提交。检查点记录 `/1` 增加可选的比较依据与核准参考，原始清单、依赖、候选与内容身份继续逐字核对。

公开 `readReview(roundDir)` 返回 `candidateSelection.latest`、可选 `better`、`comparison`、`differences`。两份候选均含已验证的完整文档与检查结果；差异给出文件、JSON Pointer、`added|removed|changed` 及前后值，区分空值与删除。读取时重新计算比较和较好证明；候选损坏或证据无法核对时明确诊断，不借用残留工作副本。

需要核对另一个已发布集合时使用 `readReview(roundDir, { compareWith: { roundDir: otherRound, id } })`。返回 `candidateComparison` 的两份完整内容、关系与差异；不同依据只展示不可排序，不借助分数排序。MCP 原有保存信号仍是 `saved + id + contentIdentity`，工具仍只读；本票不改动 MCP 输出合同。

旧 `renderweave-checkpoint-ref/1` 和没有选择记录的旧轮次仍可读，不补造 `better`。旧完整轮次不指定选择时维持原接续策略；只有可核对、已发布的集合允许显式选择。

## 从所选集合开新轮次

```powershell
node dist/bin.js agent review out/round-1 --no-open
node dist/bin.js agent run --from out/round-1 --checkpoint better --feedback feedback.md --out out/round-2
```

`--checkpoint` 只和 `--from` 一起使用，可取 `latest`、`better` 或已发布 ID。`better` 不存在时明确不可用，可由操作者改选 `latest`；不会把首次保存冒称更好。所选集合的全部候选、依赖及固定资料一起接续，新轮次记录原 ID、内容身份和 `hostRecovery` 来源。旧事实及正式稿不变；活动或未知拥有者仍拒绝接管，恢复并发沿用检查点短锁。集合只能查看或接续，不能直接批准或应用。

验证从实际 CLI、真实 MCP、公开审核和接续入口进入。`test/agent-candidate-selection.test.ts` 覆盖四任务的真实改善/否定对照、正式稿退步、显式选择和兼容；完整集合保存、恢复互斥及批准/应用边界由 `test/agent-checkpoint.test.ts` 交叉验证。真实模型效用由统一验收活动另行留证。
