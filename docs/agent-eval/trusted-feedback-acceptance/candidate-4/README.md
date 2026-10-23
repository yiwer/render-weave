# 候选4可信反馈：16单元全新预登记

以下保留派发前登记；实际结果已另存[部分结果](RESULTS.md)：12有效通过、1额度无效、3未运行，票未关闭。预登记时16槽全部not-run、真实模型观测0。候选3首段7通过、1严格范围失败、8未派发及其诊断边界留在[旧结果](../candidate-3/RESULTS.md)；候选2的10通过、6有效失败也保留。本次是14/17责任修复后的完整新候选重验，不拼接旧、新结果或把历史另存重评分计入新观测。

[登记](registration.json)固定两段原命令、预算、槽位、唯一派发者和共享STOP；[输入证据](input-evidence.json)固定8类受控seed共450文件和40个反馈/政策/事实/素材/说明引用；[证据索引](evidence-index.json)保留空结果位置。40份固定材料和22资源与候选3逐字节一致，seed从candidate4/content重新生成，不是模型观测。

- 候选：sha256:7ce9b838a00faa36038bb1c68e1d9e957380c23ead0d0abedf6dc0c1da449804
- 绑定：sha256:46cb478e587cc6c73aff68871d373a841b791f3818c4c6d8c987d589a807bd80
- 实验：sha256:ed56446a11984236ce1b00daf0f0b1ad597716e8966eacfbce19e28e89719410

实际执行目录为F:/GenCode/render-weave/out/harness-acceptance-20/candidate-4/content。新根out/harness21-trusted-feedback-candidate-4的inputs/config.real-model.json、binding和plan.json全部来自20包内准备。原生Haiku5.5、full、effort缺省、提取40轮/模板80轮、整轮60分钟、停滞阈值2、jobs1、两段repetitions1-1和2-2保持。feedback-score/2只纠正独立诊断与未核查表达；strict corrections/1、允许属性、分页缺陷存在时的取证及其余门槛不变。

21唯一派发16槽。原38条件引用指定4英文模板槽，不增加观测；它另行派发原四8观测和业务人审。首段结束后普通有效模型失败如实保留并继续第二段，不筛选成功首段、不重跑到通过；只因硬额度/429、真实工程缺陷或用户停止另记未派发。公开launcher拒绝重复分段、存在未派发标记、任一共享STOP，第二段要求第一段已完成且未停止。

共享停止文件是本根STOP.json和out/harness-original38-candidate-4/STOP.json；遇429/硬额度立即写入、通知并阻止后续，必要时终止本计划执行器子树，保留原件，不自动续跑。M329具体端点授权原字节保存在[授权](endpoint-authorization.json)。正式派发须等20发布与本登记独立复核合入，再创建activation；本预登记没有模型调用或人工审核结论，票21保持needs-triage。
