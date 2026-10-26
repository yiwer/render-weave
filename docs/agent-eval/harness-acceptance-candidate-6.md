# 候选6：Windows 监督器收尾补修后的共同验收候选

2026-10-25：候选6已离线冻结，原四与可信反馈计划已重新绑定。发布时真实模型观测为0，独立派发登记另行保存；冻结不等于模型或人工验收通过。

## 修复与验证

主线 `6348aac` 修复清理超时遮住已提交成果的问题：Windows 两项确认期限各30秒，清理未确认时交回既有成果并告警；停止结果无法保存时按宿主无效记录，硬额度仍停止。补修 `01ff22f` 经公开 CLI 红绿复现，保证 `cleanup.json` 本身发布失败也不拒交已提交成果，明确 `receiptPersisted:false`，并保留无记录退出时的宿主/额度分类。M331 的 host 不重试但继续后续单元、quota 停止政策不变。

独立审查后的源码为 `41ae798cf509afb328dbc58137ad44429fe0dbd9`，已快进合入 main，主目录构建通过。未修改测试限时、预算或通过阈值。采用既有候选的全量基线加本次责任回归，不声称最终源码另跑过一次全量：

- 原剩余4项与新增3项：Windows 7通过，双语八任务140.436秒，仍使用180秒限时。旧版串行3通过/1超时保留。
- 补修后 Windows 评估、预算和尝试记录3个完整测试文件：44通过/1平台跳过，294.80秒。
- Linux 预算和尝试记录2个完整测试文件：17通过/6平台跳过，74.89秒；容器无网络，依赖锁与宿主逐字相同。
- 两平台构建与类型检查通过；独立审查、源字节及日志摘要见[验证清单](../../out/windows-supervision-recheck/validation-final.json)、[合入记录](../../out/windows-supervision-recheck/main-integration.md)。原始红测和诊断写盘失败的红绿见[责任补修](../../out/harness-cleanup-receipt-fix/validation.json)。

通用[派发器](candidate-dispatch.md)独立复核后合入；最终源码10项进程演练、4次公开预检、4次拒绝检查通过，3977个旧文件SHA不变。它补齐结构化 `type:error` 与退出后的公开额度回执，跨计划共享停止；普通文本引用、host 无效和已提交成果告警不误停。实际新候选登记仍需自己的四次预检。见[派发器证据](candidate-dispatch-validation/validation.json)。

## 固定身份与范围

- 包：`F:/GenCode/render-weave/out/harness-acceptance-20/candidate-6`，实际执行来自 `content/`。
- candidate ID：`sha256:9b8a0ada4a0ac2837a0b231eb44e6da4c405910c9ace50064e4972b2afa356b1`。
- manifest SHA256：`6caa67bba49bf23db7b9b2326701a829260eeb517ed625ecd91d1c735d6d712f`。
- 3322个共同文件中20个变化，逐项对应监督器、执行诊断、结果/CLI、评估分类与审核页及其构建。渲染、DSL/Schema、模型资料、依赖、Node字节、MCP0.17.0和默认运行请求不变。
- full、原生Haiku5.5、同小模型、effort缺省、提取40/模板80轮、1小时、停滞2、每场景2次/jobs1均保留。提供方内部模型修订仍未知。

| 计划 | 绑定 | 实验身份 | 全量重验 |
| --- | --- | --- | --- |
| 原38原四场景 | `sha256:48a742b1ea7f0d49fa0440d82278a4e015b3a24d3f1247bca789cecbd62d987a` | `4062145cb5e1909135878218991f1e1b2b11b2a8dedd9b58409f08a66855de4a` | 8业务观测、10阶段 |
| 21可信反馈 | `sha256:528117b478d6b44833ae57217ee94861b1dc4c65c22ee552fa5377ebd9b25643` | `e094c67782b03026354fde7da533b07e104b00e8897053104f5c9bdb092e7c97` | 8类任务各2次、16单元 |

两份 previous-binding 均指候选5。7步公开发布命令全部退出0，22资源逐字复制，受控种子重新生成，只将配置 evidence 从 mechanism 转为 real-model。候选5完整包重新验证通过，没有原地替换。详细[步骤](../../out/harness-acceptance-20/publication-6/steps.json)与[字节及绑定核查](../../out/harness-acceptance-20/publication-6/verification.json)保留。

## 历史与后续

候选5的纯英文首次设计、唯一纠偏及用户总体接受记录保留；不再增加第三次英文运行，也不将旧成功拼入候选6原四/21的新槽位。旧候选2–4的有效失败、额度停止及未知成本继续保留。

按已批准的同一业务范围与M329端点授权，先21两个分段，再原38两个分段；两计划共用候选6的STOP和独占锁。遇到额度停止即保留记录，不轮询、不换模型、不重跑覆盖有效失败。21、原38及后续12例留出和真人走查仍须各自证据，不因离线发布关闭。
