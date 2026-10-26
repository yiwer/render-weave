# 原四候选6：完整真实门槛与待人工审核成果

2026-10-25（原始UTC时间为10月26日），候选6按事前登记完成四场景各两次：8个业务观测全部达线，10个实际模型阶段封存，0有效失败、0无效、0未运行。此结论只完成原38的四场景自动门槛；独立样式/状态和人工比较仍待审核，原38不关闭。

[最终原报告](raw/segment-2/report.json) SHA256：`4f1e2eeb27ee0231bf2ededbde5d06eb6ef03ad50e229c373e853a2f4ebca6aa`。原报告 `evidence.kind:unverified`、`realModelObservations:0` 原样保留；[独立来源审计](raw/source-final.json)另以3274项核查、0发现确认10个真实阶段、846份封存文件。入库原件均按[来源索引](source-index.json)与持久out逐字节对应；未重评分、未改旧报告和任何失败历史。

## 身份、授权与实际派发

| 项目 | 值 |
| --- | --- |
| 共同候选 | `sha256:9b8a0ada4a0ac2837a0b231eb44e6da4c405910c9ace50064e4972b2afa356b1` |
| 原四绑定 | `sha256:48a742b1ea7f0d49fa0440d82278a4e015b3a24d3f1247bca789cecbd62d987a` |
| 原四实验 | `sha256:4062145cb5e1909135878218991f1e1b2b11b2a8dedd9b58409f08a66855de4a` |
| 原生CLI | Claude Code 2.1.296；exe SHA `76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a` |
| 实际响应模型 | `claude-haiku-5-5`，与请求model/smallModel相同 |
| 端点 / 合同 | `https://opencode.ai/inference/go/anthropic` / MCP0.17.0 |
| 配置 | full；effort缺省；jobs1；重复2次；提取40轮，模板80轮；3600000ms；停滞阈值2 |
| providerRevision | 未知 |

原四52份输入、28份来源材料及预算沿[预登记](raw/registration.json)固定。[激活](raw/activation.json)核实票21两段已完成且无共享STOP后，root唯一串行派发，未同时发起另一模型计划。执行为已审公开启动器：

```powershell
node docs/agent-eval/candidate-dispatch.mjs --registration F:/GenCode/render-weave/out/harness-original38-candidate-6/registration.json --activation F:/GenCode/render-weave/out/harness-original38-candidate-6/activation.json --segment 1
node docs/agent-eval/candidate-dispatch.mjs --registration F:/GenCode/render-weave/out/harness-original38-candidate-6/registration.json --activation F:/GenCode/render-weave/out/harness-original38-candidate-6/activation.json --segment 2
```

两段分别调用候选6 content内的公开评估入口，完整argv、进程身份、开始/结束及输出见两段原始 `started.json`、`completed.json`。首段退出3，4pass/4not-run表示尚未完成；第二段退出0，累计8pass。两段均 `stopped:false`，monitor/record/childError为null。本批原生 `api_retry` 0、API错误消息0、外层重试0，无额度事件；不据没有429宣称即时取消时延已证明，不触发自动额度探测。

## 达线结果及保留差异

| 场景 | 第1遍 | 第2遍 | 实际模型阶段 |
| --- | --- | --- | --- |
| M402定义 | 14/15字段，6/6约定，pass | 14/15字段，6/6约定，pass | 2 |
| M402模板 | 压测10/10，版面2/2，pass | 压测10/10，版面2/2，pass | 2 |
| M402修改 | 压测6/10，版面2/2，范围违例0，pass | 压测6/10，版面2/2，范围违例0，pass | 2 |
| 366定义与转录 | 59站，有序名称58/59，pass | 59站，有序名称59/59，pass | 4 |

两次M402定义仍缺“班车类型”，14/15达到事前门槛，不写成全部字段完备。366两个定义阶段为12/15字段，转录阶段另按有序名称及标注条件验收。首遍唯一名称差异为第4站候选“滨河强天桥”、真值“滨河华强天桥”；第二遍没有名称编辑差异。两遍地标均15/15、设施18/18且无额外项，无顺序、插入、重复或遗漏；原始逐项alignment和errors保留。

修改场景6/10是事前配置的数量阈值，沿历史基线限制未授权范围；代码按stress6/layout2/scope0判断，并没有动态逐缺陷对照旧版。两遍仍有“本站0”的 `check.failed`，以及“两站”“50站1500”“35站1500”的 `render.sizeOutOfRange`；不因达线写成全部压测无问题。设计场景的门槛另为10/10。两次修改的实际变更仅道路段和站点格，范围违例为0。

10个封存阶段最后一次成功 `check_outcome` 的contentIdentity均与宿主终检一致；原生来源、实际资料、预算及轮次提交指纹均核对。自动达线、qualified和零范围违例不替代独立人工判断。

## 用量、时间及40/47计数边界

最终报告累计值如下；首段已包含在内，不能把两份报告再次相加。

| 项目 | 合计 |
| --- | ---: |
| input tokens | 330 |
| output tokens | 465145 |
| thinking tokens（output子集） | 326540 |
| cache read tokens | 10206316 |
| cache creation tokens | 869723 |
| 工具调用 / 转存结果 | 222 / 0 |
| 原生result API时间 | 3835237ms |
| 原生result运行时间 | 3854769ms |
| 轮次墙钟 | 3868340ms |
| 尝试elapsed | 3883756ms |
| 两个评估会话实际墙钟 | 3935615ms |

四类token与10个原生result逐项相等，报告usageComplete为true，未知用量尝试0。提供方实际收费未知；CLI的本地list估价不当账单，人工审核/修正/返工分钟未知，不填0。API时间、轮次墙钟、尝试和会话时间分别记账，不称纯推理耗时。

按阶段原生返回轮数为第1遍38/44/30/40/34，第2遍32/73/28/39/47。第2遍366数据集请求maxTurns40而成功返回num_turns47，必须保留该差异。[专项核对](raw/turn-count-40-47.md)确认其原生流61条assistant事件归并为19个message.id，其中18个含工具；46条user事件、45个工具调用及45个工具结果，成功计数47等于46条user加初始1。固定CLI同一SHA的短执行片段区分成功结果Ot与max_turns附件turnCount。请求上限和成功结果计数不是同一变量，不能据47判断超预算，也不据此证明40硬截断已实测。

## 四个实际中文成果包

正式入口是 [新版四包总索引](F:/GenCode/render-weave/out/harness-original38-review/zh-candidate-6-index-v2/index.html)。[目录原件](raw/review/packages.json)与[独立final-v2审核](raw/review/independent-final-v2.json)固定：

- `zh-template-r1-candidate-6-v2`
- `zh-revision-r1-candidate-6-v3`
- `zh-template-r2-candidate-6-v2`
- `zh-revision-r2-candidate-6-v2`

新版显式展示封存brief排除“站名上方蓝色数字圈”的原范围；修改包同时展示原两项修改要求，避免把同图另一轮设计授权扩到修改任务。旧包和更正过程保留。新版14张图与旧版字节相同；实际请求50DPI/1457×325、独立比较预览120DPI/3496×780分开标明，不用预览替代实际输出。

四包共511文件，来自4个真实封存轮次的429文件/100目录；包不是模型尝试。64个人工项、审核者、分钟及预看诊断字段仍空白；交付与来源审核通过不表示业务人工通过。总索引HTML SHA `374113e4003e3c2427df51d105f44a62df18309bed4414d95c8c8d218b15d5ac`，packages.json SHA `783724541109fe998e251784694807b6d2bb51aa7adb944569d263f534acc219`；两者不能混用。

## 同候选英文引用与独立业务审核

新建[候选6英文共享引用清单](raw/conditional-english-reference.candidate-6.json)，固定票21最终报告SHA `3e12be8957425fc613099f4153796b9df2e9043bfebe87303f8b1740ae855771`，逐项绑定 `en-template-design`、`en-template-revision`各两次的真实attempt、seal、轮次、身份、预算和五项守卫。它们由票21唯一派发，四份引用均 `countsAsNewObservation:false`，不增加实际模型观测数。两计划共同候选相同，但逐计划输入/绑定/实验不同，不把受控输入当原四输入。

旧 `conditional-english-reference.json` 是候选2历史，原样保留，不当候选6身份。票21受控英文纠偏不等于用户TfL161独立业务样例；候选5纯英文首次设计、唯一纠偏及用户“确认接受”的总体结论另保留，39细项和工时没有因此补填。独立样式/状态及人工比较责任仍由原38承担。

## 完整归档与恢复只读核验

候选6公开 `archive-context-trial.ts --pack/--restore` 均退出0，实际归档原始运行根、共同候选、原四plan、最新四包及index-v2共8根。精确命令见 [pack](raw/archive/pack.json) 和 [restore](raw/archive/restore.json)。

- 归档：`F:/GenCode/render-weave/out/harness-original38-candidate6-evidence-archive`。
- 恢复：同路径后缀 `-restored`。
- 完整清单：5768文件、1037目录，另8个恢复标签根。
- manifest SHA：`3719599f817789a25bd14f06cd67663e10d9fcb090c3664227177a867c127087`。

[验证](raw/archive/verification.json)132项核查0发现；使用恢复候选的公开 `readReview(round,{persistArtifacts:false})` 读取10个恢复轮次，全部已提交、completed、qualified。读取前后原始8根、恢复8根及归档的完整文件/目录集合和SHA均不变；没有只验清单内旧文件而漏查新增缓存。5768文件按当前可用已知凭据匹配，0命中，不记录密钥值。最终证据索引在进程退出、run.log关闭后生成。

绝对路径原样保留，原F盘目录仍存在；本次证明归档字节完整与同宿主不持久化审核可读，不证明任意路径搬迁后可续跑。大档及全路径清单留在持久out，入库仅必要原件和索引。不往已归档运行根、候选或票21源根补写文件。

本次来源核验、共享引用、归档恢复和文档整理新增模型调用0。原报告默认unverified由独立来源证据补足，不通过改字段伪造验证。原四门槛完成、遵守授权及额度停止规则的条目可勾选；原38仍needs-triage，独立人审与后续22–26不关闭。
