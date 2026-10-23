# 候选4：独立诊断、只读审核和通用修改范围修复后的重验准备

候选4已从独立审查合入的票14与17修复冻结，具备进入新一轮真实验收的离线依据；发布时真实模型观测为0。候选3的21首段为7通过、1严格范围失败、8未派发；原四首段3通过、1失败、4未派发。旧结果保持，候选4全部重新登记，不继承旧通过。

## 执行来源与变化

- 候选：`sha256:7ce9b838a00faa36038bb1c68e1d9e957380c23ead0d0abedf6dc0c1da449804`，持久目录 `F:/GenCode/render-weave/out/harness-acceptance-20/candidate-4`，实际执行目录为 `content/`。
- 来源提交 `38e73feaf12551c9dcef8d288010952ee661ccad`，已吸收主线 `631d56480f67e7091117538024272185c4a199f7`；14交付8b6f3b3、17交付d8bf777均经独立审查合入。
- 共同3322文件全部实字节核对。相对候选3仅13处改变：guide、next-round、template-revision三份资料；review/preview两个源文件及六个声明/JS/map构建文件；eval/feedback两个评分脚本。其余3309份字节一致，完整来源及每项变化见 [source-validation](../../out/harness-acceptance-20/candidate4-source-validation.json)。13项新字节另与14最终受测树及17验证资料逐项一致。
- 资料明确局部修改保留未授权表示形式与结构，并把内容判断放在标题排版之前。feedback-score/2 的五项守卫独立核查，无法核查用null/unchecked；严格corrections/1、分页时序要求和门槛不变。公开readReview的persistArtifacts:false供评估只读读取，默认交互审核仍可保存检查/预览。
- MCP0.17.0、转录/3、full、原生Haiku5.5与小模型、effort缺省、提取40轮/模板80轮、整轮3600000ms、停滞阈值2、jobs1、每场景2次保持。Node版本/二进制与原生执行器身份均和候选3绑定一致；提供方内部修订仍未知。

## 验证依据和限制

保留[原基线全量及责任回归](harness-acceptance-candidate.md)与[候选3资料修复证据](harness-acceptance-candidate-3.md)，不声称最终源码完成单次全量。票14最终固定源码6d0ccc2在Windows与Linux各4文件54项通过（487.14/320.90秒），包含反馈、身份、默认审核与资源损坏保护，两平台build/typecheck通过；历史新恢复副本经公开rescore及8次只读审核，全文件/目录集合和SHA不变。诊断仍保留strict失败，详见[14证据](feedback-diagnostics/README.md)。

票17三份资料修复：Windows38、Linux37加原平台条件跳过1；另两平台各1项定义资料、4项来源/身份验证，最终换行字节规范后各2项来源验证；build/typecheck通过。它只证明资料传递与身份流程，真实遵循改善待本候选实际观测。发布来源另行build/typecheck通过。核心布局/绘制、Schema及共享样例字节未变，没有为本发布新增图片基线。

[readiness4](../../out/harness-acceptance-20/candidate-readiness-4.json)绑定46份验证依据与完整计划；[publication-4/steps.json](../../out/harness-acceptance-20/publication-4/steps.json)记录公开freeze、包内verify、prepare-feedback、两bind、plan及再次verify共7步，全部退出0。[证据索引4](../../out/harness-acceptance-20/evidence-index-4.json)固定414原件摘要，旧索引301项全部重核未变；工具脚本实拷贝在publication-4/tooling。

## 完整新计划

| 计划 | 位置 | 重验范围 |
| --- | --- | --- |
| 原38唯一派发原四 | 原config；plans/original-four/binding-4 | 8观测、10阶段 |
| 21唯一派发可信反馈 | out/harness21-trusted-feedback-candidate-4 的inputs/config.real-model.json、binding、plan.json | 8类任务×2次，16单元 |

- 原四绑定 `sha256:c95dfdb1e4c3154cfb85fe981c528246d115fb6b80480adc1c05de33581e85d0`，实验 `sha256:c6eccead1b20d245dc2369dd1a2853f87f5445f201a0811f75a1aeaf08a257c9`。
- 21绑定 `sha256:46cb478e587cc6c73aff68871d373a841b791f3818c4c6d8c987d589a807bd80`，实验 `sha256:ed56446a11984236ce1b00daf0f0b1ad597716e8966eacfbce19e28e89719410`。

两份绑定都指定previous-binding为旧3并列出全部重验阶段。21从新content准备8类受控初始种子，22份资源独立复制；固定真值、缺陷与允许范围保持，16单元ready/not-run。受控种子不计真实观测；没有使用12张留出调优或派发模型。

候选3及更早包、输入、所有失败、未派发标记与历史诊断分别保留。新评分器身份只进入新候选；候选3另存的历史重评分不计候选4观测。独立发布复核、各计划预登记与激活后才开始真实验收；冻结不关闭21、原38或后续留出/人工审核票。
