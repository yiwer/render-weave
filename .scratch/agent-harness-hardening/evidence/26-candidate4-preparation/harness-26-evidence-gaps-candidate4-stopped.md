# 票26：候选4停止后的证据缺口快照

**本期验收未完成，26不能关闭。** 21现有12个有效通过、1次额度无效、3槽未启动；原38现有4个通过、1个有效失败，另1个已启动但未封存及2个未启动。留出36次与真人走查均未执行。机制能力、归档可读和材料核准均不能代替这些缺项。

记录时间：2026-10-23T21:06:44.384Z。已确认主线为7b867c3；本快照只读取已固定结果、票据及准备材料。原38停止元数据取F盘原件，未假定已合主线。机器摘要：[harness-26-evidence-gaps-candidate4-stopped.json](C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness-26-evidence-gaps-candidate4-stopped.json)。本文件不覆盖[候选4进行中84条映射](C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness-26-evidence-map-candidate4-during-run.md)，沿用其A01–A20/US01–US64责任映射（US48含20、US56含22–25），以下更新的是事实状态与缺口，未产生最终完成判定。

## 真实结果与不能合并的结论

|范围|已固定事实|尚欠或不能宣称|
|---|---|---|
|21 / A15|16计划，13唯一原生尝试均封存；12有效通过、0有效失败、1quota-invalid、3未启动；12次五守卫均true，6次有效模板取得缺陷仍在的后续页反馈|候选4还缺4个有效单元：英文定义第2次无效，英文数据集/设计/修改第2次未运行；不能计16/16|
|原38 / A14|8业务槽、实际7个阶段尝试；5有效业务观测=4pass/1fail，含6个封存阶段；其公开事后报告为4/1/0invalid/3not-run|3not-run中模板第2次已启动且耗费已发生，停止时未封存；另两槽才未启动。不能写成3次零成本未运行，也不能把7阶段当7个业务观测|
|原38独立业务审核|两份候选4中文实际模板/修改审核包已绑定原attempt，审核值均null|中文独立样式/状态/分钟未完成；英文TfL真实参考的具体材料核准、实际验证与独立审核待完成；21受控种子不能替代真实英文图|
|19、22–25 / A17|05输入材料与独立审核计划已获核准，19为resolved；12案例、36订单、96公开阶段已有准备|实际留出0、独立成果审核0；关键错误误通过率与真实家族独立性结论尚未知，不能因0观测写误通过0|
|26 / A20|已有12步走查准备与84条责任映射草稿、机制和归档证据|没有真人完成记录、最终图与审核/修正/返工分钟；完整结果后的最终两轴收口未完成|

原38第1次M402模板为有效失败，压力检查9/10而门槛10，不能因随后额度停止改成invalid。模板修改6/10及366的59/59站序、14/15地标、18/18设施只是按登记阈值达线，不代表每个压力用例或全图完美。第2次模板有原生结果与本地API错误，但宿主没有完成封存，仍按中断未封存保留。

两个计划的API末条`<synthetic>`是经最终result/round错误核对的CLI本地429信封，独立列出；原模型列表和错误原件不删，不把信封算作真实模型响应。真实响应来源为Haiku5.5/CLI2.1.296；本地来源核对不等同提供方签名认证。机制报告realModelObservations=0原字节保留，真实有效数量由另存来源核验支撑。

两份事后公开`--rescore`只汇总固定原件，不能称为第二段原始完整报告，不能补封存、接续或制造有效成功。原38真实门槛当前是fail且执行不完整；21当前是缺有效观测，二者不能互相抵销。

## 21–26逐票剩余工作

|票|当前票面与证据|必须完成的下一项|可审查的完成条件|
|---|---|---|---|
|21|needs-triage，6AC勾选/2未勾；候选4负结果及额度停止已独审合入|先等20最终可用候选与维护者恢复安排；若沿既定新资料形成候选5，重新预登记全16槽及共享英文4槽，全部保留成本和自然失败；收尾延迟另列责任诊断|同一候选全16有效纠偏及5守卫证据、实际来源和成本完整；当前12个成功不拼入新的身份；独立审核不由21代签|
|22 横版线路牌|ready-for-agent但依赖19/21/原38；9AC未勾；0实际|前置齐后，3案例各3次独立初始输入；按既定全流程分配逐阶段绑定，人工review/apply后才绑定真实上游工作区|9次有效结果及独立人审、正式输出、原始成功与人工补救、全部成本/分钟；不能复用前次答案|
|23 竖版线路牌|ready-for-agent但依赖未满足；9AC未勾；0实际|同上，执行此分层3×3，记录真实模板家族与能力边界|9次有效结果与独立审核/正式交付；有效失败保留，不放宽判据|
|24 整站牌|ready-for-agent但依赖未满足；9AC未勾；0实际|同上，执行此分层3×3；按声明的自动范围与人工范围分开判断|9次有效结果与独立审核/成本；unknown不当全图通过|
|25 双语站名牌|ready-for-agent但依赖未满足；9AC未勾；0实际|同上，执行此分层3×3；保留两例已有模板唯一英文字色修正要求，独立重复|9次有效结果与人工审核；英文结论仅限实际字段；不得由此替代原38英文真实参考责任|
|26 综合收口|ready-for-agent但依赖22–25；9AC未勾|把本快照及后续最终身份补进84条映射；实际完成正常生成/审核/应用/正式出图、资源漂移重审、检查点接续；查看既有取消/超时/额度状态|36留出及所需独立审核齐全、至少8案例全流程、关键错误误通过核实、真人分钟/最终图/卡点留证、从40d14f1起最终Spec/Standards收口；缺失或失败仍不得通过|

留出仍为公交四类型，不能重新称中英文×线路牌/价签四格。准备材料的10全流程+2修改各3次不新增96之外的业务阶段；与真人走查共享同一正常订单时只计一次。记录真实模板家族，不将相似家族重复次数包装为独立泛化。材料核准、被指定为独立审核者和实际成果审核是三个不同事实。

## 成本、收尾与恢复证据边界

- **21全13次含额度无效**：input256、cacheRead5281639、cacheCreation724278、output113969；thinking58493是输出子集。实际会话1514118ms、尝试合计1439437ms、轮次合计823734ms，不能相互替代。人工分钟/金额未知。
- **原38全7次含中断**：已知input206、cacheRead5031898、cacheCreation502388、output274664；thinking201112是输出子集。usageComplete=false，一次轮次墙钟和一次尝试耗时未知；actualWallMs=null，已知会话1178888ms。中断尝试已知用量必须保留，不用其未封存状态抹掉成本。两批同主机并行，不推断策略性能收益。
- **21收尾延迟**：run-2中文定义attempt c3e402ab…原elapsed626845ms。20:30:28.217Z已completed/committed，20:39:14.015Z开始经授权的loopback inspector诊断，20:39:58.029Z断开后20:39:58.088Z封存；原因未知，时间相邻不证明调试修复或自然恢复。业务守卫可保留，不能作为无人介入正常收尾或性能比较证据。后备关闭脚本首次HTTP发现即ECONNREFUSED，未执行process._debugEnd；该介入仍留原证据。
- **归档已核，不等于业务通过**：21恢复5924文件/1234目录并只读查看13轮；原38恢复4695文件/762目录并只读查看6个封存阶段。两者检查完整文件/目录集合及全部字节，原始和恢复读取前后相同。原38第7个中断尝试只保存字节，不制造完成凭据；实际绝对路径未改写，不证明任意机器接续。原38恢复清单SHA为`05bfa461fb18a8dd08374893467a8229fe59dc840caeb457661aa33af8814dc5`。
- **人工/范围仍空缺**：两份候选4中文审核表没有独立判断，英文真实参考仍需其具体材料核准和真实执行；混合阿文样例负面评价保留，停止阿文还原，不把旧英文局部包写成已过。现阶段中文/英文范围保留，不重启阿文任务，也不使用12例调优。

## 候选5冻结前的硬缺口

根任务最新协调结论：17新旧资料在同一Windows公开测试都触发原60秒超时，Linux已通过；**改前同失败不是兼容验证通过**。本快照未独立执行该诊断。17实施者需给出最小环境诊断和实际验证结果，03独立复核；20等最终主线及双平台要求满足后才可冻结候选5。若仍未验证，只交付待冻源和缺口，不生成ready候选，不能用说明代替验证。

候选5目前没有创建、激活或派发。若资料变化最终合入，按新来源完整冻结、生成原四8观测/10阶段及21全16槽的新绑定和受影响重验清单；候选4原件、STOP、有效失败及quota-invalid保留。新候选全量重新登记的原因是身份变化，不是筛除旧失败。授权目的地仍按M329，但额度恢复和实际派发安排须由根任务确认；本轮不轮询、不删除STOP、不自动续跑。

## 可复用收尾摘要

本批先完成离线收证：21为12个有效通过、1次额度无效、3槽未启动；原38为4通过/1有效失败，另1个已启动未封存、2个未启动，成本均保留。两批归档和只读恢复有完整路径及字节证明，但独立样式/状态审核、36次留出和真人走查仍缺，26不能关闭。候选5尚等待17的Windows验证及独立结论，只做离线准备，不派发模型。

## 固定读取来源

这些SHA固定的是本快照所读字节，外部读取不修改产品或票状态。正式结果路径和责任票见下表；旧进行中映射原样保留。

|来源|SHA256|
|---|---|
|[registration.results.json](F:/GenCode/render-weave/out/harness-original38-candidate-4-evidence-metadata/registration.results.json)|`406ce6e027013aae126a8a445d525e7897b4a8bf91b681079c087e35c849dd45`|
|[harness-original38-candidate4-stopped-archive-verification.json](F:/GenCode/render-weave/out/harness-original38-candidate4-stopped-archive-verification.json)|`a92983ed1acefcb1eca1da0d2b73a024157b73403d562826d3b84b5983c88b94`|
|[RESULTS.md](F:/GenCode/render-weave/docs/agent-eval/trusted-feedback-acceptance/candidate-4/RESULTS.md)|`ee33204046f200fee63bb0295198de11d71c72363e4d8fcf74325a535ecdeec5`|
|[19-holdout-cases-and-review-plan.md](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/19-holdout-cases-and-review-plan.md)|`7819051c9a996082b24d6f7c8cf3a5bef8827f748a76792746792d788bb2c03d`|
|[21-real-trusted-feedback-observations.md](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/21-real-trusted-feedback-observations.md)|`3a493fe559a854e904be1b2d53141a508480ad208c1b8a6512153ef3e32f1fbe`|
|[22-landscape-route-holdout.md](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/22-landscape-route-holdout.md)|`3a96a2dfbd66ed22b22fd0fd60f829a5e870e89b9da0c87d65b21fac5c301567`|
|[23-vertical-route-holdout.md](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/23-vertical-route-holdout.md)|`a40d108b399e0c7dad847081dfec6c6be485c49e8d8e14e763e63bf58a32d128`|
|[24-bus-stop-board-holdout.md](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/24-bus-stop-board-holdout.md)|`c030736cb077136303b57c806e93039b8d2187cfc99a72ec43ed3efce1bf3743`|
|[25-bilingual-stop-name-holdout.md](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/25-bilingual-stop-name-holdout.md)|`03ea3a3536bb765ead06ebb0bc8de337c29778a244972aa9081c7f6aee37c7ae`|
|[26-integrated-evidence-and-human-walkthrough.md](F:/GenCode/render-weave/.scratch/agent-harness-hardening/issues/26-integrated-evidence-and-human-walkthrough.md)|`5eb8bebbeab61d9ad55830ce647ca015bbac47127b631fcb3eb280907e2f9d9c`|
|[spec.md](F:/GenCode/render-weave/.scratch/agent-harness-hardening/spec.md)|`190bc5662c919c1224505fd7c753893a11422ade9992e3ab29af973b01a32914`|
|[38-retest-after-quota-recovery.md](F:/GenCode/render-weave/.scratch/agent-template-authoring/issues/38-retest-after-quota-recovery.md)|`d1adb87743200ec013e1d73779b3f958d7fb32ac81cf2ea6c94f02b789f79118`|
|[README.md](F:/GenCode/render-weave/out/harness-holdout-execution-preparation-candidate-4/README.md)|`e905e09b51b35a68974c9b44c94390610ce3235f4b2c4774853393a09e722076`|
|[README.md](F:/GenCode/render-weave/out/harness-walkthrough-preparation-candidate-4-v3/README.md)|`969d3aa4ec5223982a74fc506ef2ac3de67a99929b812fe12f60a618ba38447b`|
|[harness-26-evidence-map-candidate4-during-run.md](C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness-26-evidence-map-candidate4-during-run.md)|`67ede67a8c48fb91b24b51c2f514498eb761069eb89b01f54dedc8c2da6c0629`|
|[harness-26-evidence-map-candidate4-during-run.json](C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness-26-evidence-map-candidate4-during-run.json)|`46f71d813a3421f2b00a2c0cedbb0b75fb431f6e4eeeaca1db7e52123460dbf4`|
