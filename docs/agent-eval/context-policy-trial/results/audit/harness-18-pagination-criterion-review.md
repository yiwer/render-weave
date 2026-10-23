# 18分页判据只读复核

判断：当前两次fail属于已登记的独立分页取证要求未满足，是模型执行顺序不足；不是把正确纠偏成果误判为内容错误，也没有证据要求修公共比较工具或放宽评分器。最小建议是在20/21前澄清文档：“缺陷仍存在时从后续页实际取得该问题”；同时明确此校准预告region-22，不测盲发现能力。

本轮32项预登记试验全部保留原政策、原结果及原成本；不能把改前定点查询与改后分页拼成通过。本文只读分析两个已完成轮次，不重评分、不修改代码/政策/票状态、不调用模型。未来21若同样未完成这一独立要求，照实报告fail，不补跑到通过。

## 已核对的事实

读取来源根目录：`F:/GenCode/render-weave/out/harness18-context-trial`。

| 单元 | 不可变尝试原件 | 当前五项反馈结果 |
|---|---|---|
| full/run-1/zh-template-design | `full/run-1/zh-template-design/attempts/96c80ec2-5fcb-4020-baf6-df317d9143ef/round/` | targetCorrection=true、nonTargetPreservation=true、unknownRetained=true、finalCheckMatches=true、pagination=false，场景fail |
| on-demand/run-1/zh-template-revision | `on-demand/run-1/zh-template-revision/attempts/e63edd10-e044-42d0-bc51-4b4ffc1d21c7/round/` | 同上，场景fail |

对应`feedback/`兼容目录的feedback.md、tools.jsonl、stream.jsonl、check.json均与上述原件逐文件SHA相同，已核对。两份最终check均为qualified、视觉needsReview、unknownRegions=24；因此“技术可用/授权修正成功”和“独立取证流程未达线”没有被混成一个无法解释的标签。

共同反馈原文：

> 仅修正 calibration-zh/region-22 的文字、字号、颜色、横向位置；其余内容原样保留。参考目录超过20项，沿nextRegionOffset取得后续页，再点查region-22。修改后重新compare_reference并check_outcome。未测维度保持未知。

这不是事后追加顺序：先后续页、再点查、修改后重查已在实际载入的反馈里。冻结政策`registration/frozen-policy.json`也已列五项守卫，其中包含pagination；登记时间2026-10-23T15:04:00.798Z，登记时observationsAtRegistration=0，plannedObservations=32。

## 实际调用顺序

两例改前视觉报告均为：

`2f65d82004c38b38d5e38a2410b03dd542538419867469c3f472d3db66a0b553`

改后视觉报告均为：

`1b7d2e64f8c9c569743816a8951688c3da00d892eb7444f32c318f7ea2549f56`

两者不同，且差异对应实际候选修正。视觉reportId和完整outcome contentIdentity是不同口径，不混用。

| 单元与日志位置 | 已验证行为 | 含义 |
|---|---|---|
| full tools第1行；stream第26行 | `regions:["region-22"]`，regionOffset为空；改前report，regionIssues中22出现6次 | 确实取到了目标6项偏差，属于定点查询 |
| full stream第32、36行 | Edit实际候选 | 先改候选 |
| full tools第4行、stream第42行 | 改后第一页，目录01–20，issues=[] | 修改后才开始目录遍历 |
| full tools第5行、stream第46行 | regionOffset=20，目录21–24含22，issues=[]，改后report | 后续页已经取得，但该页没有待修问题 |
| full tools第6/8行；stream第47/58行 | 改后点查22无异常，最后check_outcome qualified | 修正与终检证据成立；不能补造改前分页取证 |
| on-demand tools第3行；stream第37行 | 改前第一页offset=0，目录01–20，不含22异常 | 第一页已读，尚未续取 |
| on-demand tools第4行；stream第40行 | 直接点查22，改前report，6项偏差 | 跳过改前第二页，直接点查 |
| on-demand stream第44行 | Edit实际候选 | 修正后才能观察下一阶段 |
| on-demand tools第8/9行；stream第52/54行 | 改后点查22及offset=20页，均issues=[] | 两种入口都已成功，但没有“后续页里的待修问题”证据 |
| on-demand tools第10/11行；stream第59/65行 | 首次终检unqualified，补写outcome后末次qualified | 原始失败保留；末次有效身份独立核对通过 |

full最终完整内容身份为`574d86db3d1e0815a44d14c3d9b08f0023710a4bf1a1c68b13eacd51bbb46b56`；on-demand最终为`acce760fa59228dfb44fe40c177e56a9b2c260d2ae03577ba1a971225b8e166c`。不要求不同任务的完整内容身份相同。

## 规格、合同与实际守卫

| 来源 | 已登记要求 | 对本次的判断 |
|---|---|---|
| PRD D13与A15 | 至少一个模板任务超过20区域，后续页有必须处理的问题；基准载入、修正、范围、未知和终检分别有效 | PRD没有禁止定点查询，也不把调用次数当成功；但要求实际覆盖后续页问题 |
| 票14第4项 | 经评估与真实MCP续取流程取得后续页问题，并核对处置，不能只查第一页/记一次调用 | 为分页能力设置独立取证是合理机制验收 |
| 票21第2/3项 | 超20区域并实际处理后续页必修问题；保存原始/反馈/修正/终检 | 实跑时不能由已知ID定点读取自动替代后续页取证 |
| 公开compare_reference合同 | regions与regionOffset互斥；始终测量全清单，参数只控制返回详情；沿nextRegionOffset翻页，目录ID可点查 | 点查是合法产品操作、确实反馈了缺陷；合法入口不等于已满足指定分页验收 |
| scoreFeedback | 成功compare日志同时具有offset≥20、该页catalog含目标ID、该页regionIssues含目标ID | 证明目标问题尚存在时确实在后续页被取到；这两例不满足 |
| 冻结18政策 | 五项守卫都要满足才允许候选资格；已有有效失败不覆盖 | 本次保留负结果，不能为默认决策事后改线 |

现有守卫不是“翻过页即可”；也不是“通过任意入口取得缺陷，再在任意时间翻一次页即可”。两例证明了定点反馈可用和改后分页可用，却没有取得指定的完整分页问题流程证据。这一差别不能靠模型已改对来消除。

同时，现有守卫只检查一条后续页日志，它没有证明模型不知道region-22、没有从提示中获知目标，也不证明其认知过程。固定反馈直接点名22，校准本来就是已知缺陷纠偏；把此结果宣传为“盲发现隐藏问题能力”会超出证据。该限制应明示，但不使本轮预登记守卫无效。

## 最小可审查建议

建议本轮仅做文档/结果解释澄清，不要求票14代码修复、重新准备或重跑；不以此阻止20工具实现继续。20最终冻结仍按既定前置决定执行。

可在后续操作说明或21派发说明增加以下文字，保持实际判据不变：

> 本校准包含一项独立流程要求：在缺陷尚未修正时，先沿参考目录取得包含必修问题的后续页，再查看详情并修改。修改后仍要重新比较并完成终检。仅在修改后读取无异常的后续页，不满足该项。目标区域已在反馈中给出，因此该项验证后续页取证与纠偏流程，不验证盲发现能力；授权修正结果与流程结果分别报告。

最小审核范围：

1. 保留五个现有布尔分项，不删pagination、不用targetCorrection覆盖它。
2. 结果说明把当前原因写为“缺陷仍在时的后续页取证未完成”，并引用上述日志；不是“模板没有修好”或“不会分页”。
3. 本轮32项的原配置、提示、评分脚本、报告、原件与成本全部不变。若另写说明，关联冻结政策/观测身份，明确它是解释，不是重评分。
4. 21仍按预登记完整计划执行；相同失败作为有效失败留下。不得把本轮的成功纠偏部分拆成新的通过观测，不能增加重复槽位洗掉失败。
5. 若将来另研究“未告知ID的分页发现”，需要独立的新校准设计和预登记，不在本轮或本次21中偷偷换题；当前没有此实施要求。

不建议“允许改前定点异常+改后页20”作为现有分页通过线。它会把已经修完的空白页检查误当成后续页问题取证，削弱真实覆盖；两个不同reportId更不能拼接成同一次检查。

## 原件摘要

| 原件 | SHA256 |
|---|---|
| 两例feedback.md（相同） | 42c7c25eef2b1aab10d811cea37e4eec0986d0d9366e82b15bb4cc25680d37ec |
| full tools.jsonl | ccb75be2b63868ad4deb89a5436236509824215c4b629f6fceebbf72b7fec354 |
| full stream.jsonl | 55ec94ea68260af3bf4712cb1c54b70dcd2531666aa7f5160dc6004c203d211d |
| full check.json | b107b291a1c09fc0d020bee171ba88ef99c3326c4d68789cf2c090b23009fddd |
| on-demand tools.jsonl | 6946fb6488d4d794d8aa66e6adf58e96986dcfd462854b27629221904c0fe5b4 |
| on-demand stream.jsonl | 5eae18446c83a8ecdde3d7b6c749724b54f7d50fba7a2496c4a1695f0cd56f64 |
| on-demand check.json | 4d74a6cca118363439f98e91666b648f618c63b5e654fd19d7f7a2d64c71774d |

## 直接依据

- [PRD D13/A15](F:/GenCode/render-weave/.scratch/agent-harness-hardening/spec.md:204)
- [票14](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/14-trusted-feedback-eval-inputs.md)
- [票21](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/21-real-trusted-feedback-observations.md)
- [分页评分](F:/GenCode/render-weave/scripts/agent-eval/feedback.ts:142)
- [实际反馈生成](F:/GenCode/render-weave/scripts/agent-eval/prepare-feedback.ts:60)
- [公开工具合同与摘要](F:/GenCode/render-weave/src/mcp/tools.ts:302)
- [公开分页说明](F:/GenCode/render-weave/docs/agent-visual-feedback.md:57)
- [冻结18政策](F:/GenCode/render-weave/out/harness18-context-trial/registration/frozen-policy.json)

下一步：保留完整32项结果及当前默认决策规则，只在结果解释和未来操作说明中澄清该独立证据要求；不重判当前fail，不自动追加模型调用。

