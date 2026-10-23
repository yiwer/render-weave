# 候选2可信反馈验收：16次完成，门槛未通过

当前重验准备见[候选3新登记](candidate-3/README.md)，全部16槽重新登记；下文和原JSON继续保留候选2的历史记录。

已按预登记完成中文/英文四任务各两次，共16个有效真实观测，10通过、6失败；票21保持needs-triage。完整结果、每项守卫、失败时序、来源/成本及归档恢复见[实跑结果](RESULTS.md)。[原预登记](registration.json)保持派发前含义，当前状态以[结果登记](results/registration.results.json)为准。18的32次资料策略试验不占这里任何槽位。

## 固定计划与责任

资料策略沿18决定使用`full`，模型及smallModel为`claude-haiku-5-5`、effort缺省；提取40轮、模板80轮，整轮60分钟、停滞阈值2、jobs=1。按两个分段执行，重复1的八场景结束后才进入重复2；每段依次为中文四任务、英文四任务，均沿14的原始顺序。实际执行前与20绑定逐项核对，不临时改预算。

| 场景 | 第1次槽位 | 第2次槽位 | 允许修正 |
|---|---|---|---|
| 中文数据定义提取 | F-ZD-1 | F-ZD-2 | 第二字段名stpoName→stopName |
| 中文数据集提取 | F-ZS-1 | F-ZS-2 | stopName：科枝园→科技园 |
| 中文模板辅助设计 | F-ZT-1 | F-ZT-2 | region-22文字、字号、颜色、横向位置 |
| 中文模板辅助修改 | F-ZR-1 | F-ZR-2 | 同上 |
| 英文数据定义提取 | F-ED-1 | F-ED-2 | 第二字段名stpoName→stopName |
| 英文数据集提取 | F-ES-1 | F-ES-2 | stopName：Science Pork→Science Park |
| 英文模板辅助设计 | F-ET-1 | F-ET-2 | region-22文字、字号、颜色、横向位置 |
| 英文模板辅助修改 | F-ER-1 | F-ER-2 | 同上 |

模板固定220×155mm、final 100 DPI、24个核准normal区域。第22区字号5→7、颜色#FF0000→#172B4D、left 63→60，文字按语言纠正；其他候选与属性保留。提取加载可信内容事实，模板加载可信区域，未核准语义/未测维度保持未知。详细事实、缺陷与JSON Pointer仍来自14准备器及其政策文件，本登记不添加答案或改变评分。

后续页守卫沿已有条件：**缺陷仍存在时从后续目录页取得region-22待修问题**，修正后重新比较并终检。改前定点查询与改后无异常的分页不能拼为通过；改后直接点查region-21至24不代替目录续页。region-22已经预告，不测试盲发现。这里澄清既有判据，不修改提示、工具或通过线。

受控seed仅制造已知初始缺陷，不计真实观测；这里只验真实模型从该状态纠偏，不推断首次自由提取/设计成功率。目标修正、非目标保留、未知保留、分页取证、末次有效反馈与宿主终检身份必须逐项满足。有效失败永久保留为fail，不覆盖重跑到成功；基础设施无效保留全部尝试并按原规则区分，硬额度立即停止全部后续派发，不自动等待或换模型。

21唯一派发这16槽；原38唯一派发旧四场景8槽。两计划没有精确可复用项，不互相占重复槽位。原38的英文真实纠偏子项可条件引用这里匹配的英文模板观测，但同一观测仍只算一次，不替代原四场景或中英文独立样式/状态审核。24个normal区域不证明本站、已过、终点或最长文本的独立业务审核。

## 持久目录与20交接

根目录：`F:/GenCode/render-weave/out/harness21-trusted-feedback`。

- `resources/`已独立复制，22文件逐一与`fixtures/resources`核对SHA，包含4个字体。资源清单见登记；未使用用户留出图。
- 20已从最终候选`content/`唯一生成`inputs-2/`、`plan-2.json`与`binding-2/`；8类受控seed准备通过；plan-2保留派发前16单元未运行状态，当前结果见results/registration.results.json。旧候选1的`inputs/`、`binding/`与计划保留为0观测准备原件，不用于本轮。
- `observations/`保存公开评估生成的不可变尝试和轮次；`reports/`保存每次分段报告；`dispatch/`保存首次派发参数、开始/完成、日志与报告快照。两段已执行，成功与有效失败均已封存。
- 21工作树仅准备说明和登记，独立安装依赖，不修改main、20工作树、Agent资料或构建。

20交接已核对：候选3322文件、15份公开资料真实路径，配置及各15个绑定资源摘要，16槽公开计划与预登记逐项一致；full/模型/执行器/预算/停滞阈值均吻合。登记已补共同候选、绑定、实验及每槽seed/反馈/政策/核准事实摘要，另存candidate-2.pending-authorization快照。受控seed哈希按相对路径排序的完整文件摘要映射计算，规则和原件路径见input-evidence.json。授权已获，实际派发使用另存的registration.candidate-2.authorized.json与activation.json；待授权快照仍原样保留。

20已执行的准备入口如下；这段仅作命令形状说明，不能再次覆盖已有输入。实际命令、cwd和退出码见20的publication-2/steps.json：

```powershell
node node_modules/tsx/dist/cli.mjs scripts/agent-eval/prepare-feedback.ts --out F:/GenCode/render-weave/out/harness21-trusted-feedback/inputs-2 --resources F:/GenCode/render-weave/out/harness21-trusted-feedback/resources
node node_modules/tsx/dist/cli.mjs scripts/agent-eval/run.ts --config F:/GenCode/render-weave/out/harness21-trusted-feedback/inputs-2/config.real-model.json --plan F:/GenCode/render-weave/out/harness21-trusted-feedback/plan-2.json
node node_modules/tsx/dist/cli.mjs scripts/agent-eval/freeze.ts --verify <最终候选目录> --current
```

绑定和派发均显式固定登记中的模型/smallModel/endpoint、`--context-policy full`、`--repeat 2`、`--timeout-ms 3600000`、`--stagnation-threshold 2`、原生`--claude`路径。effort与统一max-turns不传，沿缺省与任务40/80预算；jobs固定1。普通单策略计划不加`--paired`，并发调度作为派发事实记录。绑定仅执行版本查询和字节核对，不读取密钥或调用模型。

21实际评估还必须提供`--candidate-binding <本计划绑定目录>`；分段参数为`--repetitions 1-1`和`2-2`，使用同一个完整repeat=2计划、label与输出根。凭据仅经`--key-env OPEN_CODE_API_KEY`读取，登记不含值。20未交接或公开校验未通过时不得派发。

## 证据与停止原则

每个槽保存受控原始成果、可信事实及反馈、原生真实纠偏流、修正候选、最后有效compare/check身份和宿主终检。每次尝试保留started与完成封存、实际退出/停止原因、所有用量；四类提供方计量、thinking及部分/未知来源分开列，thinking不重复相加。人工审核/修正/返工分钟与金额未知时保持null。

实际模型资格沿18已验证方法：核对执行器版本及字节、冻结派发和候选绑定、不可变轮次与全部封存摘要，分别记录初始化模型和响应消息模型。提供方修订未知保留null；机制报告的真实计数0不改写为证明，另建真实来源登记。

分段报告立刻另存不可覆盖快照及SHA，最终累计报告不能与早期分段重复计数。归档包括成功、有效失败、无效尝试、重试与中断；记录空目录，实际恢复到新目录后核对所有SHA并从公开审核入口抽查。绝对路径不自动重写，不宣称任意迁移后可以直接续跑。

有效失败意味着本票门槛未通过；尚未运行或无有效结果则保留not-run/invalid。不能因某条内容已修好而忽略分页等独立要求，也不能拿18的成功轮次补缺。若观察到实现缺陷，先回责任票修复、形成新候选和受影响清单，再决定证据有效性；不能在本轮边跑边改判据。

20已完成受控seed与候选绑定；21两段已全部完成但门槛未通过，尚未关闭票21。候选为72a5e749…b949f，绑定b2a1a7e5…6505，实验5e69585b…5961，完整身份见登记。用户已于call_8fa6a92a2dc64ba3b1b97b5c2378792b明确同意具体opencode.ai端点，已另存可派发登记并依原两段参数执行；出现硬额度或429立即联动原38停止后续，保留中断原件，不自动续跑。
