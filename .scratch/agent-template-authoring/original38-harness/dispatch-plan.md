# 原38：harness 固定候选验收登记

本登记承接原38的现有四场景，不增加重复次数、不改变通过线。当前仅完成无模型准备；候选身份与绑定待20完成，不能据本文件派发或计为通过。新增可信反馈16单元由harness21唯一派发，与此处8单元没有精确可复用观测。

## 四场景与预算

| 单元 | 案例 | 重复 | 阶段预算 | 既有通过线 |
|---|---|---:|---|---|
| G-D-1 | m402-definition | 1 | definition 40轮 | conventions≥6，expertFields≥14 |
| G-D-2 | m402-definition | 2 | definition 40轮 | 同上 |
| G-T-1 | m402-template | 1 | template 80轮 | stress≥10，layoutChecks≥2 |
| G-T-2 | m402-template | 2 | template 80轮 | 同上 |
| G-R-1 | m402-revision | 1 | revision 80轮 | stress≥6，layoutChecks≥2，scopeViolations=0 |
| G-R-2 | m402-revision | 2 | revision 80轮 | 同上 |
| G-S-1 | 366-transcription | 1 | definition 40轮→dataset 40轮 | names≥57，landmarks≥14，facilities≥17；顺序/多报/重复/附属误报均0 |
| G-S-2 | 366-transcription | 2 | definition 40轮→dataset 40轮 | 同上 |

共8个业务观测、10个模型阶段；366沿既有评估入口模拟采纳数据定义，属于该校准任务的既有条件，不是独立人工审核，不推广到19的留出流程。每单元保留所有失败及无效尝试；一个不可变观测只能占一个重复槽位。

请求模型和smallModel均claude-haiku-5-5，effort不覆盖，full资料，整轮3600000ms，停滞阈值2，jobs=1、repeat=2；任务轮数沿上表，不传统一max-turns。执行器使用原生Claude Code 2.1.296，其实际版本/文件摘要必须在最终绑定时重核。实际提供方模型修订未知，不宣称可固定。

## 输入与候选的衔接

20已准备持久输入：`F:/GenCode/render-weave/out/harness-acceptance-20/plans/original-four/`。其中config.json保留原配置通过线，仅将全部输入/资源改为持久绝对路径；preparation.json保存原配置摘要、52份文件的来源与复制摘要。最终派发前再次验证文件摘要。

运行入口必须来自20最终候选的content目录，使用该目录自己的tsx及scripts/agent-eval/run.ts。由同一content的freeze.ts绑定上述config及原生执行器/预算，模型派发必须提供candidate-binding。不得改工作树源码后从新构建继续凑通过；C工作树只用于登记和证据文档，不成为真实派发的唯一输入来源。

最终派发登记另存不可覆盖文件，包含候选/绑定/完整实验身份、输入/配置/执行器摘要、确切命令、输出目录和开始时间。各轮由现有评估入口保留原件、启动/完成及实际模型/用量；报告退出码1不等同基础设施无效。

有效失败留在原槽位，不改阈值、不覆盖到成功；只有无效或未运行可按原计划有限续跑。明确硬额度错误停止全部后续模型派发，不轮询、不换模型、不绕过限制。与21并行时，两方共享停止通知，但不重复派发彼此槽位。计时如有并行开发负载明确记录，不作隔离性能承诺。

## 英文纠偏与独立样式/状态

21中的英文真实模型纠偏，只能在派发前逐条登记候选、案例、重复、预算和范围相同后条件引用；引用不产生新观测，也不替代本票四场景或真实参考样式/状态审核。合成初始缺陷的纠偏不证明首次自由设计，也不直接覆盖真实英文牌。

中文审核使用本次M402模板/修改的实际成果、实际50DPI请求和原图；不能把共享样例120DPI或旧0.10.x成果当本次结果。范围包括35站、15道路段、15班次、全部独立样式及已过/本站/普通/终点/最长文本的适用对象；变体请求与原图比较分开。

英文可以准备历史混合站牌中英文与几何的局部只读对照。13个纯英文站点节点及3个英文独立标题/说明可定位；混排子段、终点英文和全样本最长文本未独立测量部分明确未知。保留原塑形阻断，不删除其他文字、启动新的阿文生成或宣称整图可交付。此离线局部审核不是新的模型纠偏。

真实人工审核仍需实际观察原图与本次成果，先记录独立判断再查看自动结论，保留逐样式/状态证据及分钟。现有coding agent标注不替代人审；用户对12例素材的审核承诺不自动构成本包已审核。未核准、未观察或有效失败均不勾选原38的未完条目。

## 当前边界

本登记不关闭原38，不修改其历史已勾选的中文纠偏记录，不重复承担原34的实现。后续真实结果、共享引用和人工审核应写入原38票据及其绑定证据；harness26只引用相应结论。

## 公开审核材料生成器（离线准备）

prepare-review.mjs 仅生成独立材料，不派发模型、不批准或应用。实际轮次先完整复制到新目录并核对逐文件摘要；在副本上调用公开 readReview、readPreviousRound、loadWorkspace 和 render，获取已生效的审核修改及固定资源。原轮次前后逐文件摘要必须相同。

正式材料同时传 --candidate 与其 content 的 --runtime，前后用公开 freeze.ts --verify --current 核查来源；仅离线工具预演允许 --preflight。实际出图保持本轮 request.json 的模式与 DPI。公开审核页的草稿预览可自动调整 DPI，因此另列预览尺寸与 DPI，不将其当成原请求结果。没有实际图片时保留受阻结果；缺固定资源则拒绝，不用当前资源补造历史身份。

输出含实际请求图片/布局、单独的公开审核预览、有效候选、独立范围说明、不可变材料清单、空白人工记录和 review.html。首页先展示原图及结果，诊断入口收折；这只能支持独立观察，不能技术上保证审核人从未读过诊断。人工须据实际情况记录 autoDiagnosticsSeenBeforeFirstJudgment，未知工时保持 null。材料本身保持 prepared-not-reviewed。

2026-10-23 已用18的一个已结束合成中文模板轮次做工具预演，位置 F:/GenCode/render-weave/out/harness-original38-review-preflight-02/：公开入口读到1份有效候选，实际请求100 DPI/866×610，预览100 DPI/866×610；原轮次所有字节不变。它只验证工具可运行，不是原38业务观测、人审结果或20固定候选上的测试。初版预演01一并保留，不能计成第二次模型观测。

20完成后的命令形状（实际值待最终登记）：

    node .scratch/agent-template-authoring/original38-harness/prepare-review.mjs --candidate <候选包> --runtime <候选包/content> --evaluation <本次评估根目录> --binding <20对应计划绑定目录> --round <本次评估/run-N/场景/attempts/id/round> --out <新的审核目录> --scope .scratch/agent-template-authoring/original38-harness/zh-style-inventory.md

每次M402模板/修改成果独立生成一包。脚本不能替代人对照全部35站、15道路段、15班次及独立样式/状态；也不能将英文局部离线材料当整体可交付结果。


## 英文局部材料生成器（准备完成，待20候选）

`prepare-legacy-en-review.mjs` 强制提供20的候选包，前后核对其公开 `freeze.ts --verify --current`。它逐一验证库存所列原始材料摘要，在新目录复制5份快照文档、3份原样旧候选和资源，调用公开 `loadWorkspace` 与 `render`。原正式请求保留50 DPI与本站6，同时单独生成干净草稿内容供人工查看；原来的严重问题与正式出图阻断保留，不构造缺失的 outcome 或审核记录。

输出41项同位置上下文面板、完整整图、公开渲染结果和空白人工记录。历史框仅用作定位，未核准事实与测量不传给自动比较，因此不产生自动通过结论。面板按同一整板坐标显示，保留位置偏差；混排项只审核英文局部，16站最长英文仍由审核者逐项判断。生成器字节、实际渲染器身份、全部输入和输出摘要一并留存，原件结束后重新验哈希。

已通过 `node --check`；尚未在20候选上渲染，不计已验证的业务结果。20冻结后的命令为：

    node .scratch/agent-template-authoring/original38-harness/prepare-legacy-en-review.mjs --candidate <20最终候选包> --inventory .scratch/agent-template-authoring/original38-harness/en-inventory.json --out <新的英文局部审核目录>

共享引用已逐项登记在 `conditional-english-reference.json`：21唯一派发的 F-ET-1、F-ET-2、F-ER-1、F-ER-2，共4个英文模板纠偏槽位。原38只按实际完整结果条件引用，不另外派发，不增加观测数，也不代替本票8个四场景观测或真实参考人审。当前均未运行；20交接后、真实派发前补入确切候选/绑定/实验身份，并与21登记互核。

## 审核生成器来源保护补验

正式模板包同时核对候选、计划绑定、eval.identity、attempt.started与round/evaluation.json的实验身份，以及completed.seal.json记录的全部原始文件。只接受attempts下的封存round原件，拒绝兼容视图、旧实验与未绑定轮次；技术不合格的真实失败成果仍保留供审核，不要求评分通过。completed.json可缺失，存在时须与封存一致。绑定配置、资源和原始轮次前后重核；来源记录另存进包，不靠新渲染器身份给旧观测补造来源。

两生成器均在写入前禁止输出落在来源内，并拒绝来源根及祖先链接，防止复制junction后回写原件。2026-10-23已从生成器CLI验证3项拒绝：源内输出、源根junction、正式包缺evaluation/binding；临时canary原件不变，证据位于 F:/GenCode/render-weave/out/harness-original38-review-guard-check-02/results.json。首次非提权junction创建被Windows权限拒绝，未开展该例；随后在专用目录完成，并只解除已校验本次junction。

修改后的无模型预演03在 C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness-original38-review-preflight-03/：一个有效候选、实际与预览均100 DPI/866×610，原轮次所有字节不变、人工未审核。仅为工具预演，不是20候选或本次原38的模型观测；正式绑定的正向验证须使用本次实际封存结果。
