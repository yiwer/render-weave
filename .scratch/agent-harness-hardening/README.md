# Agent 代建模板的可靠执行与可信验收

[父规格](spec.md) · [拆分依据与验收责任](ticket-breakdown-proposal.md)

编号 01–26 属于本功能；“原票”指 Agent 代建模板本地闭环中的既有票据。

| 标题 | 直接阻塞 | 验收映射 |
|---|---|---|
| [01：转录评分准确拒绝乱序、多报和错误重复](issues/01-ordered-transcription-grading.md) | 无 | A01–A02 |
| [02：换数据和参数后核查模板的实际业务行为](issues/02-template-behavior-checks.md) | 无 | A03 |
| [03：审核固定资源预览，相关资源变化后重新核准](issues/03-pinned-review-resources.md) | 无 | A04；A06 资源兼容 |
| [04：资源替换与应用并发时，核准内容和公开读取保持一致](issues/04-concurrent-apply-and-reads.md) | 03 | A05 并发与正常读取 |
| [05：应用中断后恢复完整工作区，重试不重复发布](issues/05-recover-interrupted-apply.md) | 04 | A05 中断、恢复及幂等 |
| [06：评估续跑拒绝混合条件，重新评分保留原始结论](issues/06-frozen-evaluation-identity.md) | 无 | A12；A14 受控汇总 |
| [07：重试和恢复保留每次尝试与真实用量](issues/07-immutable-attempts-and-usage.md) | 06 | A13 尝试与原始用量 |
| [08：任务启动即可查看持久状态，强退后保留可读诊断](issues/08-durable-round-state.md) | 03 | A06 历史读取；A07 状态；A08 拥有者 |
| [09：已检查的完整候选在强退后可从检查点接续](issues/09-checkpoint-and-resume.md) | 08 | A06 接续；A07 检查点；A08 恢复竞争 |
| [10：整轮超时或取消后有界退出并保留可恢复结果](issues/10-bounded-run-and-cancel.md) | 09 | A09 |
| [11：保留有证据更好的候选，正式交回退步时显示差异](issues/11-retain-better-candidates.md) | 09 | A11 |
| [12：有证据的机械停滞及时停止，正常确认仍可交回](issues/12-stop-confirmed-stagnation.md) | 10 | A10 |
| [13：已不可见的内容不能冒充视觉覆盖完成](issues/13-visible-content-checks.md) | 03 | A16 |
| [14：可信基准随评估任务进入产品路径并形成完整纠偏计划](issues/14-trusted-feedback-eval-inputs.md) | 07、13 | A15 机制及案例准备 |
| [15：按完整订单核算尝试成本与人工投入](issues/15-order-cost-and-review-time.md) | 05、07、09 | A13 订单汇总；A17 人工记录；A19 分享摘要 |
| [16：素材与历史内容不能改变宿主权限和可信结论](issues/16-untrusted-input-boundaries.md) | 05、07、09 | A19 权限边界与成对验证 |
| [17：按需资料策略形成可验证候选并自动检查资料指针](issues/17-on-demand-context-candidate.md) | 14 | A18 资料候选及指针检查 |
| [18：用配对试验决定是否采用按需资料策略](issues/18-context-strategy-paired-trial.md) | 02、12、15、16、17 | A18 配对实跑及默认决定 |
| [19：冻结十二个留出案例及独立审核计划](issues/19-holdout-cases-and-review-plan.md) | 14、15 | A17 案例与审核准备 |
| [20：兼容检查通过后冻结同一份待验候选](issues/20-verified-candidate-freeze.md) | 01、11、18 | A20 自动兼容与候选冻结 |
| [21：固定候选完成中英文四类任务的可信反馈纠偏](issues/21-real-trusted-feedback-observations.md) | 20 | A15 真实模型反馈 |
| [22：横版线路牌留出案例完成九次独立观测](issues/22-landscape-route-holdout.md) | 19、21；[原票 38：固定候选的既有真实模型验收](../agent-template-authoring/issues/38-retest-after-quota-recovery.md) | A17 横版线路牌 |
| [23：竖版线路牌留出案例完成九次独立观测](issues/23-vertical-route-holdout.md) | 19、21；[原票 38：固定候选的既有真实模型验收](../agent-template-authoring/issues/38-retest-after-quota-recovery.md) | A17 竖版线路牌 |
| [24：整站牌留出案例完成九次独立观测](issues/24-bus-stop-board-holdout.md) | 19、21；[原票 38：固定候选的既有真实模型验收](../agent-template-authoring/issues/38-retest-after-quota-recovery.md) | A17 整站牌 |
| [25：双语站名牌留出案例完成九次独立观测](issues/25-bilingual-stop-name-holdout.md) | 19、21；[原票 38：固定候选的既有真实模型验收](../agent-template-authoring/issues/38-retest-after-quota-recovery.md) | A17 双语站名牌 |
| [26：完成真人走查并交付全部验收证据](issues/26-integrated-evidence-and-human-walkthrough.md) | 22、23、24、25 | A20 真人走查与证据收口 |
| [关联：原 38 真实模型验收](../agent-template-authoring/issues/38-retest-after-quota-recovery.md) | 原 31、原 32；[20](issues/20-verified-candidate-freeze.md) | A14 真实四场景；既有英文纠偏与中英文样式/状态审核 |
