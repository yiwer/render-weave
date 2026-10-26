# 候选6：中英文可信反馈16单元实际结果

2026-10-25（原始时间戳为 UTC 2026-10-26）：固定候选6的中文、英文四类任务各两次，共16个新观测全部通过，0有效失败、0无效、0未运行。这里验收的是票21规定的可信反馈纠偏；没有替代原38的四场景回归、独立样式/状态人工审核或留出任务，也没有填入人工结论。

原始[最终报告](results/segment-2/report.json) SHA256 为 `3e12be8957425fc613099f4153796b9df2e9043bfebe87303f8b1740ae855771`。独立[来源审计](results/source-audit.json)完成5063项核查、0发现，确认16个唯一原生尝试、1216份封存文件。原报告的 `realModelObservations:0` 保持原样；16次真实来源由该独立审计证明，不回写报告字段。全部入库原件及外部大档位置、字节数、SHA见[来源索引](source-index.json)。

## 固定身份与派发范围

| 项目 | 固定值 |
| --- | --- |
| 共同候选 | `sha256:9b8a0ada4a0ac2837a0b231eb44e6da4c405910c9ace50064e4972b2afa356b1` |
| 计划绑定 | `sha256:528117b478d6b44833ae57217ee94861b1dc4c65c22ee552fa5377ebd9b25643` |
| 实验 | `sha256:e094c67782b03026354fde7da533b07e104b00e8897053104f5c9bdb092e7c97` |
| 模型 / smallModel | `claude-haiku-5-5` / `claude-haiku-5-5` |
| 端点 | `https://opencode.ai/inference/go/anthropic` |
| 原生 CLI | Claude Code `2.1.296` |
| CLI 二进制 SHA256 | `76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a` |
| 合同 / 资料 / effort | MCP `0.17.0` / `full` / `null`（缺省未改） |
| 预算 | 定义、数据集40轮；模板设计、修改80轮；每轮3600000ms；停滞阈值2；jobs1；重复2次 |
| 提供方修订号 | 未知，`providerRevision:null` |

[预登记](results/registration.json)、[端点授权](results/endpoint-authorization.json)及[激活记录](results/activation.json)在派发前固定。450份受控种子文件、40份固定材料与22资源沿原计划使用；种子是预置缺陷，并非模型首次生成成果。16个真实观测都是本候选实际执行的带反馈修正轮次，不用旧候选的通过结果补槽，不修改可信答案或通过阈值。

根维护者是唯一派发者，使用已审启动器顺序执行：

```powershell
node docs/agent-eval/candidate-dispatch.mjs --registration F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-6/registration.json --activation F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-6/activation.json --segment 1
node docs/agent-eval/candidate-dispatch.mjs --registration F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-6/registration.json --activation F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-6/activation.json --segment 2
```

启动器 SHA256 为 `ba5ddd036794323b8a178acdcdca6834d1e12b223e1a37e0c84803e85cfa8357`，调用冻结候选自身的公开评估入口。第一段包装时间为 `04:38:48.103Z–04:50:50.770Z`，722667ms，退出3；[报告](results/segment-1/report.json)是8pass/8not-run，表示计划尚未完成。第二段为 `04:51:21.906Z–05:03:47.946Z`，746040ms，退出0；其报告累计包含全部16个单元。两份 `completed.json` 均为 `stopped:false`，无监测、记录或子进程错误。累计用量只取最终报告，不把首段再加一遍。

## 逐场景结果及可信反馈证据

| 场景 | 第1次 | 第2次 | 本候选有效观测 |
| --- | --- | --- | --- |
| 中文数据定义提取 | pass | pass | 2 |
| 中文数据集提取 | pass | pass | 2 |
| 中文模板辅助设计 | pass | pass | 2 |
| 中文模板辅助修改 | pass | pass | 2 |
| 英文数据定义提取 | pass | pass | 2 |
| 英文数据集提取 | pass | pass | 2 |
| 英文模板辅助设计 | pass | pass | 2 |
| 英文模板辅助修改 | pass | pass | 2 |

16个单元的目标修正、非目标保留、未知范围保留、末检身份和分页守卫均为 true，`unchecked` 为空。来源审计另核对封存原件、原生输入输出、工具日志和最终检查，不只采信汇总布尔值。提取类载入可信内容事实；模板类载入24区域可信参考，后续页包含必须修正的缺陷。未知内容在最终检查中仍为未知/待确认，没有因为本票通过而被当作已核准业务事实。

8个模板单元均在修改前读取了包含第22区域缺陷的后续页，修正后检查清除该核准问题，末次有效 `check_outcome` 与宿主终检的 `contentIdentity` 相同：

| 单元 | 唯一尝试 |
| --- | --- |
| 中文设计1 | `14fc347a-2453-4b98-b9ee-f87d536cb979` |
| 中文设计2 | `7b702ff9-f406-4fb8-981a-b6a5cef9b782` |
| 中文修改1 | `0d91c98e-8910-483f-811d-9e27d7eafdd0` |
| 中文修改2 | `f1de13e4-2204-4ffb-a518-a561de8e2379` |
| 英文设计1 | `934696f3-3078-4956-9245-01bfa29aa65c` |
| 英文设计2 | `9a2a7381-5c04-4472-bb47-8c5591213265` |
| 英文修改1 | `9701aa1f-1e36-4fcd-8c6b-1afa19de99ca` |
| 英文修改2 | `5ebde059-4f1c-4d64-8310-b7633dad2232` |

各次原始成果、可信反馈、修正成果、检查及封存 SHA 位于来源审计的 `observations`、`attemptSnapshots` 和所列不可变尝试目录。16轮另以候选6公开 `readReview(round,{persistArtifacts:false})`读取，前后完整文件/目录集合与 SHA 不变。没有对候选6另跑重评分，没有改写报告、封存成果或旧失败。

## 来源、原生重试与用量

原生 init 记录的 CLI 版本、assistant 响应模型和最终 result 均与登记一致。16个实验尝试没有外层重试或覆盖。原生流中保留3条502 `system/api_retry`：第二次中文定义2条、第二次英文修改1条；[原行、行号和 SHA](results/native-retry-evidence.json)单独留存。它们是原生 CLI 内部 API 重试，未新增实验尝试，也没有把未知额外费用补零。本批没有额度停止；未出现429不能证明额度取消时延。

| 计量项 | 最终累计值 |
| --- | ---: |
| input tokens | 306 |
| output tokens | 127806 |
| thinking tokens（output 内部子集，不相加） | 60031 |
| cache read tokens | 6035908 |
| cache creation tokens | 937675 |
| 工具调用 / 转存结果 | 127 / 0 |
| 原报告未知用量尝试 | 0 |
| 原生 result API 时间累计 | 1250756ms |
| 原生 result 运行时间累计 | 1278043ms |
| 轮次墙钟累计 | 1299829ms |
| 尝试 elapsed 累计 | 1328269ms |
| 两个评估会话实际墙钟累计 | 1455308ms |

四类原生 token 与最终报告逐项相等，`usageComplete:true`、各已报告指标未知数为0。API 时间、轮次时间、尝试时间、评估会话时间及外层启动器时间分别保留，不混称纯模型推理耗时。没有把两段之间的空档加到会话时间。实际提供方账单金额未知；CLI 的 `total_cost_usd` 或 `costBasis:list` 仅是本地估算，不能当实际收费。人工审核、修正、返工分钟和人工业务结论均未知，未填0。

## 归档与完整恢复

在模型全部结束后，使用候选6公开 `scripts/agent-eval/archive-context-trial.ts` 的 `--pack` / `--restore` 入口，把反馈根与候选根打包、恢复到两个新目录；准确 argv、开始/结束、退出码及原始输出见 [pack](results/archive/pack.json)、[restore](results/archive/restore.json)，均退出0。

| 根 | 文件数 | 目录数（不含标签根） |
| --- | ---: | ---: |
| `out/harness21-trusted-feedback-candidate-6` | 3046 | 1029 |
| `out/harness-acceptance-20/candidate-6` | 3323 | 360 |
| 合计 | 6369 | 1389 |

归档：`F:/GenCode/render-weave/out/harness21-candidate6-evidence-archive`；恢复：同路径后缀 `-restored`。清单 SHA256 `879a6cead7825776d4da008a3f6247e0f0137296d48dc564c66056c3c97b03ec`。恢复根另有 `feedback`、`candidate` 两个标签目录。

[恢复验证](results/archive/verification.json)66项核查、0发现：逐项比较文件和目录的完整集合及文件 SHA；16个恢复轮次使用公开不持久化审核入口读取，均已提交、执行完成、成果 qualified。读取前后恢复件、原始两根及归档均不变，没有只核清单内旧文件而漏查新增缓存。可用已知凭据1份，6369文件扫描0命中；扫描只输出数量，不输出凭据值。

恢复保留记录内的原绝对路径，复验时原 F 盘目录仍存在；此证据证明完整归档恢复与不写入读取，不证明可在任意路径离线续跑。大档、全部尝试和完整路径清单留在 `out`，入库索引可以定位和核对它们。后续整理只写归档源以外的新目录。

最初归档 `evidence-index.json` 在进程最后一次控制台输出前记录了 `run.log`。进程结束后该日志由 SHA `1e2f30e781b2e9179980d01281a499abdfa51642a5f6e227cac9935b56797d84` 变为 `4d49712da854db31f26c7fda99eeb5a920f3749616e9091f88131b957d8763fe`，仅追加正常输出。其他原索引文件均未变。旧索引保留，[最终索引](results/archive/evidence-index-final.json)另存最终日志 SHA；该索引收尾差异不涉及归档源、manifest 或验证结果。

## 历史及关闭边界

候选2的10pass/6fail、候选3的7pass/1fail/8not-run、候选4的12pass/1quota-invalid/3not-run均保持原结论与原字节。责任14的独立评分诊断、17的通用修改和边界资料、10的Windows收尾修复经各自验证、发布新候选后，本次全16槽重新登记、一次派发；没有在旧失败上覆盖重跑或临时改答案。

与原38条件共享的4个英文模板纠偏槽由票21唯一派发。原38如逐项核对案例、重复序号、预算和身份匹配，可引用同一不可变观测，不计作额外4次、不替代其四场景回归或独立人审。纯英文 TfL161 的既有实际成果和用户总体接受属于另一输入与候选，不并入本16槽。

本次仅关闭票21的16单元可信反馈验收。原38及22–26的状态、人工业务审核和完整项目验收不在此更改。来源审计、归档恢复与记录整理新增模型调用均为0。
