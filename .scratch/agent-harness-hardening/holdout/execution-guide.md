# 留出执行与独立审核程序

本程序只消费19准备包和20冻结候选，复用公开 Agent、审核、应用、正式交付和订单入口。19只做无模型准备。22–25各持一个分层的9单元；全流程每单元的三个阶段不另算观测。

## 派发前固定

1. 用户对照 REVIEW.md、原图、逐例事实和种子预览核准。保留实际回复和时间，把批准的 preparationSha256 写入单独的 approval.json，不更改已核准材料。事实修订须新准备目录与重新核准。
2. 待20冻结，确认21和原38使用同一候选并完成有效验收。将20清单、SHA-256、模型/执行器/资料/合同/判据/预算配置及18决定的默认资料策略写入 candidate-binding.json，并留存校验输出。未知服务模型修订继续未知。
3. 每单元经20冻结入口核对源图及全部实际输入；任何身份差异立即停派。禁止改活源码后继续凑单元。仅准备包哈希不代表构建已固定。
4. 第一次真实派发前用冻结CLI将 orders.json 登记到新的 order-register。validation/order-register只是准备冒烟。模型仅接收本例素材、说明及本阶段工作区；其他例、前次重复、人工答案及整个核准目录不能作为模型输入。
5. 全流程工作区从空目录开始；修改单元从 seed-bindings.json 指定的 workspace 单独复制。correctedWorkspace仅供审核者核对，不传给模型。每次重复重新复制原始种子。

## 公开入口顺序

以下变量取自20候选及本包 cases.json、units.json、seed-bindings.json；所有路径为绝对路径。另带20核准的资料策略参数；effort沿用现有缺省。凭据仅沿用环境变量 OPEN_CODE_API_KEY，不写入命令或报告。

~~~powershell
node "$candidate/dist/bin.js" agent order-init --scope "$pack/orders.json" --out "$pack/order-register"

node "$candidate/dist/bin.js" agent run --task definition-extraction --sample "$sample" --brief "$caseDir/brief.md" --resources "$pack/resources" --content-baseline "$caseDir/definition-baseline.json" --out "$unitDir/definition/attempt-01" --model claude-haiku-5-5 --small-model claude-haiku-5-5 --max-turns 40 --timeout-ms 3600000 --claude "$claudeExe"
node "$candidate/dist/bin.js" agent review "$unitDir/definition/attempt-01"
node "$candidate/dist/bin.js" agent apply "$unitDir/definition/attempt-01" --workspace "$unitDir/workspace"

node "$candidate/dist/bin.js" agent run --task dataset-extraction --definition "$name" --workspace "$unitDir/workspace" --sample "$sample" --brief "$caseDir/brief.md" --resources "$pack/resources" --content-baseline "$caseDir/dataset-baseline.json" --out "$unitDir/dataset/attempt-01" --model claude-haiku-5-5 --small-model claude-haiku-5-5 --max-turns 40 --timeout-ms 3600000 --claude "$claudeExe"
node "$candidate/dist/bin.js" agent review "$unitDir/dataset/attempt-01"
node "$candidate/dist/bin.js" agent apply "$unitDir/dataset/attempt-01"

node "$candidate/dist/bin.js" agent run --task template-design --dataset "$dataset" --workspace "$unitDir/workspace" --sample "$sample" --brief "$caseDir/brief.md" --resources "$pack/resources" --request "$caseDir/request.json" --reference "$caseDir/reference.json" --out "$unitDir/template/attempt-01" --model claude-haiku-5-5 --small-model claude-haiku-5-5 --max-turns 80 --timeout-ms 3600000 --claude "$claudeExe"
node "$candidate/dist/bin.js" agent review "$unitDir/template/attempt-01"
node "$candidate/dist/bin.js" agent apply "$unitDir/template/attempt-01"

# 修改单元代替上述三个阶段；seedRequirement来自seed-bindings.json
node "$candidate/dist/bin.js" agent run --task template-revision --dataset "$dataset" --workspace "$unitDir/workspace" --sample "$sample" --brief "$caseDir/brief.md" --resources "$pack/resources" --request "$caseDir/request.json" --reference "$caseDir/reference.json" --requirement "$seedRequirement" --out "$unitDir/revision/attempt-01" --model claude-haiku-5-5 --small-model claude-haiku-5-5 --max-turns 80 --timeout-ms 3600000 --claude "$claudeExe"
node "$candidate/dist/bin.js" agent review "$unitDir/revision/attempt-01"
node "$candidate/dist/bin.js" agent apply "$unitDir/revision/attempt-01"

# 模板/修改经独立审核应用后交付
node "$candidate/dist/bin.js" deliver --workspace "$unitDir/workspace" --resources "$pack/resources" --request "$caseDir/batch-request.json" --out "$unitDir/delivery-01"
~~~

每个apply之前必须核对原始成果或明确的人工修正版，完成审核批准。原始版在人工编辑前冻结；前阶段不能形成可核准数据时，后阶段保持未运行，或由明确记录的人工修正推进，不能把预填答案当作Agent提取结果。每阶段目录包含所有失败、接续与恢复，不能只登记最后成功轮次。

硬额度立即停止整批后续派发；瞬时基础设施错误最多额外2次（60秒、180秒），每次用新attempt目录。有效模型失败不覆盖重跑；人工修正/接续另记成本，不改变首次判断。不擅自换模型、改预算或无限等待额度。

## 独立审核与争议

审核者为用户本人。每阶段提供原图、原始数据/候选、实际图片及核准清单，排除模型notes、生成过程与自评分数。用户先作独立判断，再查看自动分项结论，记录误通过。抽取阶段完整核对站序/道路/附属事实；模板阶段核对内容、样式、状态和修改范围。

review-forms.json是冻结的空白模板，准备成功不自动填pass。实际填写前复制到 observations/reviews/ 下，保留原模板不变；记录与材料身份分别管理。逐单元记录原始内容、站序、样式、状态、范围及总体质量；每项错误附原图位置、候选路径/图片区域、预期与实际和自动结论。必要业务事实有错即关键错误。仅当系统在其明确声明已核查的同一必要范围内判通过，而独立真值确认关键错误，才记criticalFalsePass=true。仅技术qualified、业务范围仍unknown时发现错误，记业务失败/未核查；不能误算评分误通过，也不能宣称该范围全过。每项判断必须记录系统具体声称覆盖的范围；人工修正不能消除首次误通过历史。

审核、修正、返工分别计分钟。未计时为unknown；明确没有修正工作才能填0。原始结论与人工修正结论分开，分别链接内容身份、图片、应用回执及正式出图记录。模型失败、运行invalid、not-run与未知各自保留。

分歧保留各方原话与证据，状态pending；用户对照冻结原图/核准事实裁决，记日期及理由。真值或政策改变须新材料身份与影响清单，不能看结果后放宽当前标准。

通过 agent order-record --order <order-register> --event <事件.json> 登记人工工作、原始/修正业务结论和正式交付。事件结构见本仓库 docs/agent-orders.md；每阶段人工工作登记在对应plan，空表不当合法事件。正式交付应在应用后、工作区下一次修改前登记真实item record。报告使用 agent order-report；分享用 --share，不手工漏掉失败成本。

每分层9次实际观测与独立审核齐全才可关闭执行票；关键错误误通过必须为0，否则停止宣称该集合通过，退回评分责任票，另存事后重评，旧、新身份不拼接通过。

## 污染与交接

结果若用于调整提示、资料、模型、预算或规则，立即写 contamination-log.md，相关家族降级为校准/回归，保留首次原件；重评分不新增独立样本。用户确认素材未用于调优，但整个家族独立性未证实，全部先按回归分组，不推论价签、完整英文线路或生产SLA。

22/23/24/25分别使用 strata/landscape.json、vertical.json、board.json、stop-name.json，共享准备哈希、订单登记和候选绑定。原图不入Git；真实观测放 observations/。validation/是无模型公开入口核查，不计业务质量或token观测。
