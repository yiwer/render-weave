# 候选3首段结果：7通过、1有效失败、8未派发

票21仍为needs-triage。固定候选3第一段的8次真实观测全部完成，7pass、1fail、0invalid；第二段8槽已按维护者决定登记not-run，不再派发。门槛fail且完整计划未完成。严格结构政策与原始评分不变，后续由责任14修复独立守卫的诊断短路，不在这批原件上重评分。

| 场景 | 第1次 | 第2次 |
| --- | --- | --- |
| 中文数据定义提取 | pass | not-run |
| 中文数据集提取 | pass | not-run |
| 中文模板辅助设计 | fail | not-run |
| 中文模板辅助修改 | pass | not-run |
| 英文数据定义提取 | pass | not-run |
| 英文数据集提取 | pass | not-run |
| 英文模板辅助设计 | pass | not-run |
| 英文模板辅助修改 | pass | not-run |

## 原始结果与失败边界

原报告[block-1.report.json](results/block-1.report.json) SHA256 `13ca58f744090f77f2e95273d30c3d0ff6e5fe25f523bbed15a865e5c3f18c47`；公开评估exit1、stopped=false。16槽登记及当前状态见[结果登记](results/registration.results.json)；[第二段不派发决定](results/block-2-not-dispatched.json)为exclusive新文件，没有第二段尝试或模型调用。这不是额度不足、基础设施无效或旧候选缺观测补跑。

中文模板设计第1次的技术终检qualified、执行器exit0、135270ms、28原生turns。它把 `content[0].text="科枝园"` 删除并新增 `slot="stopName"`；当前数据画面显示“科技园”，字号/颜色/left修正正确，但引入随数据变化的绑定语义。固定policy只允许原text值和另外三个属性路径，slot新增超出严格允许范围；不能因为当前画面相同就判通过。模型可见反馈只写“文字”等四项，没有逐字列text键或JSON Pointer，文字清晰度边界另行保留。

实际仅5个JSON操作：color/fontSize/left三项replace，删除text、新增slot。完整文件、SHA和原文记录在[范围诊断](results/template-design-1-scope-diagnosis.json)。这不是执行错误、超时或候选文件丢失。

评分器在读取不存在的text路径时抛错，整个try提前退出；后续非目标保留、未知保留、终检身份及分页守卫尚未计算，原结果中均保留false。**这些false不能描述为四项实际已失败。** 独立读取原件确认：

- 19:03:58.127 UTC，改前offset20取得region-22的6项异常；19:04:20.594 UTC，改后offset20异常为空。
- 最后compare报告 `2b4f7184…ad4d` 与宿主visual相同；最后check内容身份 `2418d1de…de7` 与宿主终检相同。
- 宿主unknownRegions=24、visual=needsReview，异常0。

原[工具时序摘要](results/feedback-trace-block-1.json)的该项分类沿原pagination=false推导，受短路影响；其laterPageDefectReads=1计数正确。原文件保留，以上范围诊断单独解释，既不覆盖分类原件，也不重判原fail。其余7个已完成单元全部五项守卫通过。候选2旧10pass/6fail没有拼入本批，不据两批样本推断资料改动的因果成功率。

## 来源、成本与实际执行

候选b52cc553…e61c、绑定ab144c6d…5809d、实验519ae413…9680，完整身份见[登记](registration.json)。实际cwd为F候选3/content；全程原生CLI2.1.296及响应claude-haiku-5-5，同endpoint/full/预算，无重试、429、硬额度或时限停止。[来源核查](results/source-registry.json)验证8个唯一attempt、608个封存文件，原生四类计量逐项与round及报告一致。原报告realModelObservations=0保持，8次实际来源资格另存，不回填机制计数。

| 项目 | 值 |
| --- | ---: |
| input | 162 |
| cache read | 3,788,695 |
| cache creation | 509,088 |
| output | 68,750 |
| thinking（已含output） | 35,442 |
| 工具调用 / 转存 | 62 / 0 |
| 报告实际评估会话墙钟 | 672,755 ms |
| 尝试耗时合计 | 630,314 ms |
| 模型轮次耗时合计 | 602,750 ms |
| 外部launcher开始至退出 | 676,736 ms |

未知用量0；人工审核/修正/返工分钟和金额仍null。原四计划与本计划同期各jobs1并行，保留实际负载条件，不把这组时间与其他批次作因果比较。8个未派发槽没有attempt，不能写成“零成本已尝试”。

## 归档恢复

原件根 `F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-3` 和同一候选3完整归档至 `out/harness21-candidate3-evidence-archive`；实际恢复至 `out/harness21-candidate3-evidence-restored`。公开archive/restore命令退出0，5172文件、977目录、1,077,395,448逻辑字节；清单SHA256 `f4345789032d3d93408eda764c8cc38a832089085d29137713c6e40b1d2e95c9`。

恢复后的公开readReview读取8轮均有view、0问题、committed=true，随后全文件SHA与目录再次通过，见[恢复证明](results/restore-verification.json)。内部绝对路径没有重写，不宣称任意搬迁后可直接续跑。已知key本地扫描5172文件，0命中；没有向Git提交原生完整stream或工具原始日志，它们留在完整归档中。原件、旧候选、失败和诊断均保持。

下一步：责任14通过公开CLI红绿验证各守卫独立计算、未核查与实际失败明确区分；评分身份变更后另存重评分，禁止改此原报告。原38独立模型和样式/状态人工验收仍不由本票替代。
