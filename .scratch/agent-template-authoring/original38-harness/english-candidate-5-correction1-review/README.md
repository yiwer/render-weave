# TfL161 候选 5 唯一纠偏实际审核包

已从真实封存的 `correction-1` 生成三图与 39 项空白审核包。生成器调用 `exit 0`，产物自核 464 项、0 发现；这只证明来源、只读边界与审核结构，不代表视觉验收通过。

- [打开审核页](F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-correction1-candidate-5/review.html)：原样整页、页首原图、首次设计与唯一纠偏，39 个区域分别对照。
- [原图页首](F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-correction1-candidate-5/source-panel-original-pixels.png)、[首次原始成果](F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-correction1-candidate-5/first-actual-request.png)、[唯一纠偏原始成果](F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-correction1-candidate-5/actual-request.png)。两份实际成果均为核准正式请求 `1653×500 @ 200 DPI`，未经重采样。
- [单独诊断页](F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-correction1-candidate-5/diagnostics.html) 与人审首页分开；[39 项空表](F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-correction1-candidate-5/independent-review.json) 的 `firstOutcome` 引用真实首次固定包，`correctedOutcome` 引用实际纠偏；所有逐项判断、总判断、审核者与分钟仍为 `null`，工时事件仍为空。

冻结候选为 `sha256:187d36a38bd24950511931a548e67f911cbe87de49e03aaf813a05d174a06526`；纠偏阶段绑定为 `sha256:e953de91cb519acf137bdf40c62f2ca7589e4b5634831130bab1a288b5e4dfe4`。实际 previous 直接指向首次 outcome `1d534eefa0dcc7f365684d4a9862c6b4bf517b7b6e65ee0ecd20807afe8c3357`，纠偏 outcome 为 `64793b28269025534c8da296b00ee11312c9dbd1b19922edb0574bfb16f35b4c`，首次审核状态和 SHA 均为 null。

包内 119 文件、26 目录；纠偏原轮次 89 文件、24 目录及普通副本前后完整路径集合/SHA 一致；首次原轮次 93 文件/26 目录、首次审核包 119 文件/28 目录和核准材料 59 文件/11 目录完整集合也保持不变。使用公开 `readReview(...,{persistArtifacts:false})`、`readPreviousRound`、`loadWorkspace`、`render`；候选与阶段公开验证均通过。

| 固定原件 | SHA-256 |
| --- | --- |
| 新包 manifest.json | `154dde04271dd0dc0d2427ffcfef2cfb8c45abe67df1fdb45cdc8d8cecc41b14` |
| 新包 source-proof.json | `e2d2e9d08f446bcc0291d1f8d7529b6296341f792111800027f6fdab6315d2d1` |
| 唯一纠偏实际 PNG | `0f0610d1b0c3b2b8afefefc5b4680220e08dc3432d1f47ccd5db6778d5c60703` |
| 包结构自核 audit.json | `ac893b9599a968370f867de0625378cda7afcd468e68b17832de0f8445dd4dda` |

本目录的 JSON 与日志是 F 盘持久原件的逐字节副本，来源分别为 `out/harness-english-review-generator-actual-correction1/` 和实际审核包。生成器源码固定在 `775a6e5`，独立工具审查已合 `372de70`；实际运行命令与时间见 [generation-result.json](generation-result.json)，自核见 [audit.json](audit.json)。

本次生成器没有模型调用、批准或应用。真实模型观测由根线程统一登记，首次有一次 502/server_error 原生自动重试，两轮最终 success、无 quota/terminal error，不能写成“全程无 API 错误”；来源见 [observations.json](F:/GenCode/render-weave/out/harness-original38-english-tfl161-final-candidate-5/observations.json)。首次记录不覆盖，没有第三轮。原 38 状态与总验收结论不在此更改。

下一步：独立复核实际包并由用户填写 39 项判断及真实人工时间。
