# 候选4可信反馈部分结果（2026-10-23）

12个有效观测通过，1次额度无效、3槽未运行，完整16槽门槛未完成。票21保持needs-triage；当前需要处理额度边界，且一次收尾延迟原因未知。所有旧候选2/3失败和本次尝试原件均保留，不自动续跑、不改变预算或判据。

## 固定来源与完整计划

共同候选为`sha256:7ce9b838a00faa36038bb1c68e1d9e957380c23ead0d0abedf6dc0c1da449804`；绑定`sha256:46cb478e587cc6c73aff68871d373a841b791f3818c4c6d8c987d589a807bd80`；实验`sha256:ed56446a11984236ce1b00daf0f0b1ad597716e8966eacfbce19e28e89719410`。两段从candidate-4/content的公开CLI执行，Haiku5.5、full、effort缺省、提取40轮/模板80轮、60分钟、阈值2、jobs1和登记顺序均未改。M329目的地授权与独立复核后激活见[登记结果](results/registration.results.json)和[激活](results/activation.json)。

| 场景 | 第1次 | 第2次 |
|---|---|---|
| 中文数据定义提取 | 通过 | 通过 |
| 中文数据集提取 | 通过 | 通过 |
| 中文模板设计 | 通过 | 通过 |
| 中文模板修改 | 通过 | 通过 |
| 英文数据定义提取 | 通过 | 额度无效 |
| 英文数据集提取 | 通过 | 未运行 |
| 英文模板设计 | 通过 | 未运行 |
| 英文模板修改 | 通过 | 未运行 |

12个有效观测的五项守卫全部为true。6次模板观测均从缺陷仍存在的后续页取得region-22问题；未知区域仍明确unknown，不等同整体视觉/业务状态通过。[完整轨迹](results/feedback-traces.json)保留原始行号、时间、内容身份及分页分类；原38只条件引用4英文模板槽，本次其中第二次两槽未运行，不能补齐其英文条件。

第二段英文定义提取收到`API Error: Request rejected (429) · Go usage limit exceeded`。即使已有候选qualified且五守卫为true，执行器exit1/API错误仍使该次为quota-invalid，不能计有效通过。未派发3槽没有尝试，不把它们说成已执行且零成本。共享STOP于20:45:02.373Z落盘，启动器停止自己的已核验进程树；未自动重试、换模型或轮询额度。

## 原生来源与报告边界

[来源核验](results/source-audit.json)核对13个唯一原生attempt、978个封存文件。CLI2.1.296/执行器SHA、Haiku5.5真实响应和四类用量逐项一致。额度尝试末条assistant是CLI合成`<synthetic>`/`error=rate_limit`，原model列表保留；它只在最终result.is_error和round错误429同时吻合时单列，不计为服务模型响应或额外观测。本地证据不是提供方签名认证；提供方修订未知。

首段8通过原报告与dispatch完整保留。第二段STOP时13尝试均已封存，但最终报告尚未发布，completed.reports为空。随后使用同一候选的公开`--rescore`离线另存[事后汇总](results/post-stop-report.json)，退出3，评分器与原实验一致；它不是第二段原始报告。1975文件/692目录在读取前后完整集合与SHA不变，见[证明](results/post-stop-proof.json)。核验包装最初误读not-run位置以及合成API消息的两次错误与修正另存[记录](results/verification-corrections.json)，没有第二次评分或修改原件。原报告realModelObservations=0仍保留，12有效真实观测及13实际尝试另证。

## 全尝试成本与收尾诊断

| 指标 | 全部13次（含额度无效） |
|---|---:|
| 输入token | 256 |
| 缓存读token | 5281639 |
| 缓存写token | 724278 |
| 输出token | 113969 |
| thinking（输出子集，不叠加） | 58493 |
| 实际评估会话墙钟 | 1514118 ms |
| 尝试耗时合计 | 1439437 ms |
| 轮次墙钟合计 | 823734 ms |
| 工具调用 / 转存 | 93 / 0 |
| 已执行尝试计量未知 | 0 |
| 人工审核/修正/返工分钟、金额 | 未知 |

run-2中文定义尝试c3e402ab…在20:30:28.217Z已记录completed/committed，但进程没有收尾。维护者允许对核验的自有worker125740临时启用127.0.0.1 inspector：20:39:14.015Z请求启用；20:39:47.931Z开始连接；资源类型仅PipeWrap两项；pause未取得栈，随后resume/关闭调试，20:39:58.029Z连接结束，20:39:58.088Z尝试封存。没有读取env、凭据、堆对象或强制业务Promise，没有模型重跑。后备关闭脚本在首次HTTP发现即ECONNREFUSED，未再次建立WebSocket或执行process._debugEnd，见[补充](results/close-delay-diagnostic-supplement.json)。

本项原elapsed=626845ms、轮次wall=54395ms均保留；不能从调试断开与封存时间相邻推断原因或修复效果。它可以保留原业务守卫结论，但不证明无人介入的正常收尾，也不用于性能比较。等待快照的63文件/24目录与封存后完全一致，仅正常新增evaluation.json，66封存文件核对通过，见[诊断](results/close-delay-diagnostic.json)。两计划在同一主机并行，全部成本与墙钟如实记录，不扣除等待/调试时间，也不作为隔离性能基准。

## 归档与实际恢复

公开archive/restore实际恢复5924文件、1234目录，清单SHA256为`5dc831d67f5cd5d42af8a912fca2e133144e089aaec39ddc95a5dd98ffbed320`。从恢复候选的公开`readReview(path,{persistArtifacts:false})`读取全部13轮（含额度无效），均有view、problems=0、committed=true；这不改变有效性。读取前后对原始与恢复两根完整文件/目录集合和字节核对，新增/缺失/改变均为0，见[完整恢复证明](results/restore-verification.json)。反馈根2601文件/874目录，候选根3323文件/360目录；不是只检查manifest已有文件。

原件根F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4；归档harness21-candidate4-evidence-archive、恢复harness21-candidate4-evidence-restored。保留原F盘绝对路径，不证明任意迁移可直接续跑。归档工具和取证脚本均随原件保存。候选2/3只作[历史描述](results/historical-comparison.json)，不补当前缺槽；独立样式/状态审核仍属原38，12张留出实际未运行。

下一步：维护者确认额度可用及续跑安排后，先核候选/绑定/已有封存原件，再另登记缺失与额度无效槽；当前STOP不删除，不自动派发。收尾延迟另列待诊断，不以本次调试收尾关闭可靠性问题。

本地已知凭据扫描：扫描 5971 个文件，检查 1 个 key，命中 0。只输出命中计数/路径，不输出key，见[扫描记录](results/key-scan.log)。
