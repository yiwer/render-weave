# 固定候选2可信反馈实跑结果（2026-10-23）

本次16个有效观测完整完成，10通过、6失败，门槛未通过；票21保持needs-triage。失败原件完整保留，不重跑覆盖，不调整分页守卫。后续先修通用接续资料，再冻结新候选、另登记受影响重验；本批不是缺观测或额度阻塞。

## 固定来源与执行

共同候选为`sha256:72a5e74973ce5f60e501e27060f6bc4a52f51f7b4bd45bbbac39502e0a5b949f`；逐计划绑定为`sha256:b2a1a7e53f303dfb184b417fa78248251bedd49a84e46dabe7280785ada06505`；实验为`sha256:5e69585bf0ceb8ca62800889af0dccb94e0974606b894bd34e2c2cae7d925961`。两段使用候选2的持久content内公开评估CLI，重复范围分别1–1、2–2，每段中文四任务后英文四任务、jobs=1。模型/smallModel均claude-haiku-5-5，full资料、effort缺省、提取40轮/模板80轮、60分钟、停滞阈值2，全程未改预算、种子或评分。

用户针对具体OpenCode Go endpoint的授权原件见[授权](endpoint-authorization.json)；首次自动审批拒绝发生在进程创建前，未产生调用。取得授权后才执行两段。实际派发与报告见results/block-1.started.json、block-2.started.json及各completed记录；授权前和授权后预登记均另存原件。

[来源登记](results/source-registry.json)核对16次唯一不可变尝试、1224个封存文件，原生CLI 2.1.296及其登记的执行器SHA，初始化与assistant响应模型均符合登记。四类原生result计量与轮次、累计报告逐项一致；提供方修订未知，本地原生证据不是提供方签名认证。原报告realModelObservations=0保留原样，另列来源核验后的16次真实观测；18观测未复用，第二段累计报告不与第一段重复相加。

## 全部质量与失败分层

| 场景 | 第1次 | 第2次 |
|---|---|---|
| 中文数据定义提取 | 通过 | 通过 |
| 中文数据集提取 | 通过 | 通过 |
| 中文模板设计 | 失败 | 通过 |
| 中文模板修改 | 失败 | 失败 |
| 英文数据定义提取 | 通过 | 通过 |
| 英文数据集提取 | 通过 | 通过 |
| 英文模板设计 | 失败 | 通过 |
| 英文模板修改 | 失败 | 失败 |

16次目标修正、非目标保留、未知范围保留、最后有效工具反馈与宿主终检身份一致四项均通过；最终结构qualified。未测样式/可见性保持unknown，不解释为完整视觉通过。6个失败只涉及独立分页取证守卫：必须在缺陷仍在时从后续目录页取得问题。实际出现干净offset20的失败不能表述为“没分页”；改前定点查询与改后目录分页也不能跨报告身份拼成通过。

| 有效失败单元 | 日志时序 | 有效后续页次数 | 改前定点缺陷取证次数 |
|---|---|---:|---:|
| run-1/zh-template-design | 成功后续页读取时缺陷已修正 | 1 | 0 |
| run-1/zh-template-revision | 改前点查缺陷，改后才取后续页 | 1 | 1 |
| run-1/en-template-design | 成功后续页读取时缺陷已修正 | 1 | 0 |
| run-1/en-template-revision | 改前点查缺陷，改后才取后续页 | 1 | 1 |
| run-2/zh-template-revision | 改前点查缺陷，改后才取后续页 | 1 | 1 |
| run-2/en-template-revision | 成功后续页读取时缺陷已修正 | 1 | 0 |

逐工具行号、时间、reportId、offset与issues保存在[完整轨迹](results/feedback-traces.json)。成功对照同样保留：第二次中文模板设计在改前offset20取得region-22的六项偏差，改后同页清零并终检一致。因此现候选能够完成该流程，但未稳定按次序执行；通用接续提示的调整属于待验证修复，不在本批追认效果。

[与18的描述性对照](results/historical-comparison.json)：历史full、on-demand各11/16通过，10个失败同属分页时序；当时32次其他四守卫也均通过。本批候选身份与历史不同，不能合并通过率、补重复槽、因总数差异推断因果，或用历史成功抵消本批有效失败。独立样式/本站/已过/终点/最长文本审核仍由原38承担，21的24个normal区域不替代它。

## 全尝试计量与未知

| 指标 | 全部16次（包含失败） |
|---|---:|
| 输入token | 318 |
| 缓存读token | 6147935 |
| 缓存写token | 869603 |
| 输出token | 128206 |
| thinking token（输出子集，不叠加） | 55816 |
| 实际评估会话墙钟 | 1257311 ms |
| 尝试耗时合计 | 1166779 ms |
| 模型轮次耗时合计 | 1117697 ms |
| 计量未知尝试 | 0 |
| 工具调用 / 转存 | 107 / 0 |
| 人工审核、修正、返工分钟 | 未知 |
| 金额与单位成功订单成本 | 未知 |

无额外尝试、基础设施无效、超时、停滞或硬额度停止；中间工具错误完整保留。实际墙钟按两次完成会话区间汇总，排除段间审核等待；该主机同时执行原38，不是隔离性能基准。全部模型结果和失败都计入成本，未知人工与金额不补零。

## 原件归档与实际恢复

原件根`F:/GenCode/render-weave/out/harness21-trusted-feedback`保存旧0观测准备、候选2输入/绑定、预登记、两段原生日志、全部尝试、报告与取证脚本。归档为`F:/GenCode/render-weave/out/harness21-evidence-archive`，同时保存候选2实际content及依赖；实际恢复到`F:/GenCode/render-weave/out/harness21-evidence-restored`。

[归档清单](results/archive-manifest.json) SHA-256为`ce416f56adf9da273a84ce871872065e0a9112c0fb118c573ff0a52754e651a6`。恢复6986个文件、1588个目录、1966626998逻辑字节；从恢复后的候选compiled公开readReview读取全部16轮，均view存在、problems=0、committed=true。随后重新核对全部文件SHA与目录均一致，见[恢复核验](results/restore-verification.json)。该审核可读性不改变原始评估的有效失败。

原始F盘绝对路径仍保留，归档不重写内部路径，不宣称任意迁移后可直接接续。没有再次调用模型。本次执行与取证已完成，票21的通过结论仍待责任修复和新候选重验；本批永久保留为负结果。

本地已知凭据扫描覆盖全部原件、候选与本次文档，共扫描 7011 个文件，检查 1 个 key，命中 0；只记录计数，不输出凭据，见[扫描记录](results/key-scan.log)。

公开归档/恢复分别使用冻结content内的`node node_modules/tsx/dist/cli.mjs scripts/agent-eval/archive-context-trial.ts --pack <包内post-trial-tools/harness21-archive-inputs.json> --out <新归档目录>`与`--restore <归档目录> --out <新恢复目录>`；执行摘要保存在[打包](results/archive-pack.log)与[恢复](results/archive-restore.log)。来源、轨迹和恢复审核脚本均留在原件根`post-trial-tools/`。
