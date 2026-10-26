# 按需资料配对结果（2026-10-23）

保留`full`默认，`on-demand`继续作为试验候选。32次真实观测全部完成，输入与缓存token合计下降9.07%，未达预登记20%；候选原始达线11/16，逐配对质量不退步与全部达线守卫均未通过。输出与实际墙钟虽下降，也不足以改变这一决定。模型、effort、预算与默认资料均未调整；本结果不替代票20之后的固定候选验收。

## 冻结与实际来源

预登记在2026-10-23T15:04:00.798Z冻结，首次实际派发15:06:47.190Z，最后一块结束15:50:23.864Z。只用票14独立合成的中文/英文四任务共8例，两策略各重复2次：16对、32观测、32次尝试。ABBA顺序为full第1次、on-demand第1次、on-demand第2次、full第2次；各块同例顺序、jobs=1。无重试、人工替换、额外补跑或计划缺失。

- 冻结来源提交：`d5775910d0fe70f874b142aca8dbc459235543b0`；共同构建提交：`06d051eb13ca87cdeb225d55c32424f6e92b25eb`，包含12/15/16/17最终实现。之后只修归档工具，不改这32次执行的代码/资料/判据。
- [冻结政策](policy.json)与[配对身份](frozen-pair.json)：配对文件SHA-256为`751f4106b6e1a9d78ed46716677c7cc0a912070edd1b01f1610ec86e422a72da`；排除资料策略后的共同身份为`4e33dfebb6efd778f87d5f1358d300676c389cb7a4514fd2dfb72a568c2702f6`。两组分别保存完整实验与尝试身份。
- 原生执行器为`D:/nodejs/node_global/node_modules/@anthropic-ai/claude-code/bin/claude.exe`，Claude Code `2.1.296`，文件SHA-256为`76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a`；与实际实验身份中的执行器摘要相等。
- 模型与smallModel均为`claude-haiku-5-5`，endpoint为`https://opencode.ai/inference/go/anthropic`，effort缺省；提取40轮、模板80轮，整轮60分钟、stagnationThreshold=2、MCP合同0.17.0。
- [来源登记](results/source-registry.json)逐次核对原生派发、实验身份、完成封存及2,488个封存文件；32次均exitCode=0、唯一result事件、usageSource=result。初始化`system.init.model`与实际`assistant.message.model`分开记录，32次均报告上述Haiku标识。提供方修订未知，这不是远端签名认证或可固定的模型版本证明。

[派发前核查](results/preflight.json)、四块started/completed记录及四份当时报告均逐字保留在`results/`。块3/4为策略内累计16次，不能再与块1/2相加计算观测或成本。原机制报告的`realModelObservations=0`保持原样；离线比较器也不自动核准真实来源。这里32次实际原生观测的结论来自独立来源登记与原件核验，不通过改旧报告计数获得。

## 原始质量

| 案例 | full第1/2次 | on-demand第1/2次 |
|---|---|---|
| 中文数据定义提取 | 通过 / 通过 | 通过 / 通过 |
| 中文数据集提取 | 通过 / 通过 | 通过 / 通过 |
| 中文模板设计 | 失败 / 失败 | 通过 / 失败 |
| 中文模板修改 | 通过 / 失败 | 失败 / 通过 |
| 英文数据定义提取 | 通过 / 通过 | 通过 / 通过 |
| 英文数据集提取 | 通过 / 通过 | 通过 / 通过 |
| 英文模板设计 | 失败 / 失败 | 失败 / 失败 |
| 英文模板修改 | 通过 / 通过 | 通过 / 失败 |
| 合计 | 11/16 | 11/16 |

全部32次的目标修正、非目标保留、未知范围保留、末次工具检查与宿主终检一致四项均通过。全部最终结构均qualified；无已测范围的越界修改，未测可见性/样式范围继续保持未知。没有超时、停滞、硬额度或其他执行停止，32次均正常完成；中间工具错误仍保留在原始流和日志中，不因最终合格而删掉。

10个失败均为独立的分页取证守卫。守卫要求“缺陷仍在时，从后续页取得该待修问题”，不是仅在修正后见到含region-22的目录。反馈在运行前明确要求先沿nextRegionOffset取后续页、再点查目标、修正后重查。region-22已经预告，因此这个校准不测试盲发现能力。

具体时序分为两类，不能统称“没有看可信反馈”或“目标未修好”：

- **模板修改3例及模板设计2例**：full第1次中/英设计、full第2次中文修改、on-demand第1次中文修改和第2次英文修改，均先成功点查到region-22的待修偏差，修正后才取得offset=20的干净后续页。已取到反馈并修正，但缺少改前后续页取证，不能把不同报告身份拼成通过。
- **其余模板设计5例**：full第2次中文设计的改前compare请求报工具错误，后续成功分页时已修好；full第2次英文设计、on-demand第1次英文设计及第2次英文设计，成功compare及后续页均出现在修正后；on-demand第2次中文设计没有offset=20调用，改后直接点查region-21至24不能代替目录续页。这些例子也全部通过最终四项成果守卫。

逐失败的工具行号、报告ID、分页offset和issues见[观察摘要](results/observed-summary.json)；两例独立逐流复核见[分页判据复核](results/audit/harness-18-pagination-criterion-review.md)。不重评分、不改门槛，也不追加重跑。候选虽与full总通过数相同，但在中文修改第1次、英文修改第2次从基线通过退步为失败，不能据总数相同宣称逐配对质量不退步。

## 全部尝试资源与成本

| 指标 | full（16次） | on-demand（16次） | 候选相对变化 |
|---|---:|---:|---:|
| 输入token | 314 | 302 | — |
| 缓存读token | 5,870,727 | 5,314,568 | — |
| 缓存写token | 830,929 | 779,158 | — |
| 主指标：以上三项合计 | 6,701,970 | 6,094,028 | 下降9.0711%，未达20% |
| 输出token | 119,858 | 113,347 | 下降5.4323% |
| thinking token（输出子集，不叠加） | 55,998 | 46,265 | — |
| 尝试耗时合计 | 1,110,050ms | 1,028,846ms | — |
| 完成评估分段的实际墙钟 | 1,202,305ms | 1,121,309ms | 下降6.7367% |
| 四类提供方计量未知次数 | 0 | 0 | 计量完整 |
| 消息回退/部分用量次数 | 0 | 0 | 均来自result |
| thinking明细未知次数 | 0 | 0 | 本次均有数值 |
| 人工审核、修正、返工分钟 | 未知 | 未知 | 不推断为0 |
| 金额、订单总成本改善 | 未知 | 未知 | 不作改善声明 |

所有失败也计入以上总量。独立审计从每次原生stream的唯一result重新相加，逐项与最终报告一致；见[full用量/来源核验](results/audit/harness18-block4-aggregate-cost-source-inspection.json)、[候选核验](results/audit/harness18-block3-aggregate-cost-source-inspection.json)。实际墙钟按本策略两段完成区间相加，排除ABBA中间另一策略和人工等待；独立核查排除full中间1,410,092ms空档，见[时间核验](results/audit/harness18-final-timing-inspection.json)。

该主机没有隔离全部背景开发负载，其他独立工作树存在少量本地测试和文件检查。因此墙钟是本次固定jobs=1/ABBA调度的现场观察，不能宣传为隔离基准或SLA。提供方也可能存在未返回的修订或缓存差异。本试验的保守工程线不等于业务成本校准。

## 决定及证据保存

[冻结比较](results/comparison.json)返回`complete=true`、`decision=retain-full`：主收益未达20%，`qualityNoRegression=false`、`candidateAllPass=false`；`candidateNoCriticalErrors`、输出不升高、墙钟不升高三项为true。无须改变产品默认、模型或effort。全部合成案例保持校准/回归用途，没有读取或调优用户留出图，也不宣称独立泛化收益。

完整原件根为`F:/GenCode/render-weave/out/harness18-context-trial`，包含校准种子、32次不可变尝试、成功/失败/中间错误流、所有报告与冻结运行材料；没有只挑最终成功。内容寻址归档为`F:/GenCode/render-weave/out/harness18-evidence-archive-v2`，恢复到新目录`F:/GenCode/render-weave/out/harness18-restored-v2`。[清单](results/archive-manifest.json)自身SHA-256为`25faa300298a7dc136a2fc30e3d3ff03b7e1ccc4c8efa4c17a9cf117941ffa8c`，也[单独保存](results/archive-manifest.sha256)。6,205文件、1,982目录，逻辑字节2,912,341,258，经内容去重为1,589个blob、356,471,347字节。

首次恢复发现旧归档脚本不记录空snapshot目录，虽然文件摘要都一致，公开审核仍报ENOENT；该次不算成功。公开CLI空目录红例复现后修复目录保存/恢复，再生成上述v2。旧包与失败恢复目录保留，冻结runtime快照未覆盖。随后实际恢复全部文件与目录，再从**恢复后的**轮次调用公开`readReview`：两策略×四任务共8例均view存在、problems=0、committed=true；审核之后再次核对6,205文件SHA和1,982目录，全部一致。见[恢复核验](results/restore-verification.json)。

原始F盘绝对来源路径继续保留，记录内部绝对路径没有重写；该验证证明原件字节可恢复和这8例可审核，不保证任意迁移后直接接续。归档不包含凭据或个人配置。脚本、依赖锁、原生执行器字节保存在包内，node_modules不在包内。

## 验证入口

离线比较命令（输出必须是新文件）：

```powershell
node --import tsx scripts/agent-eval/context-trial-report.ts --policy docs/agent-eval/context-policy-trial/policy.json --pair docs/agent-eval/context-policy-trial/frozen-pair.json --full docs/agent-eval/context-policy-trial/results/block-4.report.json --on-demand docs/agent-eval/context-policy-trial/results/block-3.report.json --out <新的比较报告.json>
```

来源核验与实际派发辅助脚本保存在归档的`trial/post-trial-tools/`；独立审计脚本保存在`trial/audit/`。这些只负责本次试验取证，不构成新的通用运行协议。

Windows与Linux Node22分别执行`vitest run test/agent-context-trial.test.ts test/agent-context-archive.test.ts --maxWorkers=1`，各12项通过；Linux构建通过。比较器覆盖未知/部分用量、历史失败、输出/墙钟反弹、身份及政策绑定、缺计划；归档覆盖成功失败原件、去重和空目录。真实32次不通过这些夹具冒充，原始评估失败结论完整保留。
