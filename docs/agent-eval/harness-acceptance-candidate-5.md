# 候选5：边界输入保真资料修复后的离线重验准备

候选5已完成离线发布及原四、21的公共计划绑定，发布时真实模型观测为0。它沿用已批准预算、真值、判据与full默认，仅两份通用资料改变。候选4的有效失败、额度停止、中断成本与收尾诊断全部保留；本次没有激活、launcher、独立派发预登记、真实调用或额度轮询，也不宣称模型质量改善。

## 固定执行来源

- 持久包：`F:/GenCode/render-weave/out/harness-acceptance-20/candidate-5`，未来执行来源为其`content/`；身份`sha256:187d36a38bd24950511931a548e67f911cbe87de49e03aaf813a05d174a06526`，manifest SHA256 `c81211854666dd6b9b313945429543a9d8913c65afb31c2aa3d6361a63b6c8ba`。
- 来源提交`3720db9f6f0a87b170ce961bdc3927b747b4ecb0`，同步已独审主线`766123ebcc26774cf59cb768076948f1e196be3e`；17最终交付40f83c81、测试去重a9b055e均已合入。20来源树重建与类型检查通过。
- 3322共同文件中仅`agent/guide.md`、`agent/tasks/template-design.md`改变，其余3320字节与候选4相同。新资料字节与17受测清单一致，另核765受测文件一致。新测试去重不进入共同运行包；核心渲染、Schema、共享样例、评分脚本与依赖字节不变。详见[source快照](../../out/harness-acceptance-20/candidate5-source-validation.json)。
- MCP0.17.0、feedback-score/2、转录/3、strict corrections/1与后续页取证要求不变。full、原生Haiku5.5及同小模型、effort缺省、提取40/模板80轮、3600000ms、停滞2、每场景2次/jobs1不变。Node24.12.0二进制及原生CLI身份沿候选4绑定；提供方内部修订仍未知。

## 验证依据与旧失败

沿用[原基线全量及责任回归](harness-acceptance-candidate.md)、[候选4验证](harness-acceptance-candidate-4.md)，没有宣称最终字节另做过一次完整全量。17最初Linux24项通过，Windows23项通过而一项在原60秒限时失败；旧资料同测试也失败，这个A/B结果没有被写成兼容通过。

诊断发现12种公开错误输入各重复调用两次，累计耗时触发限时。修复仅复用同一公开run返回的Promise，同时断言错误类型和消息；保留12cases、24断言与60000ms，不是产品性能修改。最终Windows单例1项32.79秒/整文件11项142.30秒，Linux单例1项6.61秒/整文件11项56.15秒均退出0；既有未变资料、身份和上下文回归继续引用。最终验证SHA`b218940ca842f7b93781ec368bfd9abcde00e0299fe2a5603469b9a9a57abbe0`，独立03复核7504项无发现；初次ANSI日志匹配审计错误和旧红灯均原样保留。详见[17最终验证](../../out/harness-boundary-input-test-reuse-fix/validation.json)。

[验证依据](../../out/harness-acceptance-20/candidate5-validation-basis.json)固定131份证据SHA，[readiness5](../../out/harness-acceptance-20/candidate-readiness-5.json)保存共同内容及计划身份；[publication-5步骤](../../out/harness-acceptance-20/publication-5/steps.json)的公开freeze、包内verify、prepare-feedback、两bind、plan及再次verify共7步全部退出0。[索引5](../../out/harness-acceptance-20/evidence-index-5.json)固定538项，旧414项摘要重核不变；原件和工具脚本在publication-5单独保存。

## 公共计划绑定与全部重验

|计划|新绑定与实验身份|重验|
|---|---|---|
|原38原四场景|binding `sha256:11bfbf76e17f5e941da49a1562104797f4afcf2478007ee64932f131f308cbd7`；experiment `sha256:98633ab5fb9e764ac85a28f0119b367eda55adf64ca008780276950eaf3c580e`|8业务观测、10阶段|
|21可信反馈|binding `sha256:f2bafc4b004a8661a11d27c27a41003b7b6486332442a7df65d44b4c0193d133`；experiment `sha256:909d871e159476ed835477bbb20a6ce74f6489aecf5d098ab943aadad286174b`|8类任务×2次，共16单元|

原四继续使用`plans/original-four/config.json`与新`binding-5`。21使用`out/harness21-trusted-feedback-candidate-5/inputs/config.real-model.json`、`binding`和`plan.json`。两绑定的previous-binding均明确指候选4，完整列出10/16重验阶段。

21的8类受控初始种子由新包公开prepare-feedback生成，计划16槽全部not-run，不计真实观测。40份业务输入引用与旧4逐字相同，配置除新根路径外相同；22份资源实拷贝逐字相同，真值、缺陷、政策和预算没有改。seed执行元数据、资料来源及UUID属于新准备，不要求与旧种子字节等同；没有复制旧修正答案。详见[计划材料核对](../../out/harness-acceptance-20/candidate5-plan-material-verification.json)。其中`real-model-registration.json`仅是公共配置evidence标签转换的来源记录，不是独立派发预登记。

## 尚未执行与历史边界

候选4的21为12有效通过、1额度无效、3未启动；原38为4通过、1有效失败，报告另3not-run中有1已启动未封存、2未启动。一次21收尾经loopback调试后封存，原因仍未知，不能用于无人介入正常收尾或性能结论。原件、成本、旧STOP和[21结果](trusted-feedback-acceptance/candidate-4/RESULTS.md)、[原38结果](../../.scratch/agent-template-authoring/original38-harness/candidate-4-results.md)不改。

新资料使共同身份变化，所有原四及21单元重新登记，不能拼旧成功或只补缺槽。本次只交付可验证离线包与公共绑定；独立复核合入后，维护者再安排额度恢复和唯一派发登记，当前不自动执行。中文/英文独立样式状态审核、十二例留出与真人走查仍未完成；本发布不关闭21、原38或22–26。
