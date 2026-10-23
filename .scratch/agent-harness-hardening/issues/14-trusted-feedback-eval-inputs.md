# 14: 可信基准随评估任务进入产品路径并形成完整纠偏计划

**What to build:** 维护者可以从评估入口创建中英文四类任务的可信反馈计划，把核准事实或区域交给真实产品路径，并从假执行器结果核对基准、候选、反馈与终检的关联，为之后一次性真实模型验收准备可冻结输入。

**Blocked by:** 07、13

**Status:** resolved

**Trace:** [父规格](../spec.md) H5、D06–D07、D12–D13；US40–43、US49–50；A15 的评估输入、8 类校准场景及 16 个有效观测计划、分页与内容身份机制子项。本票不承担 A15 的真实模型效果结论。

- [x] 准备中文、英文各数据定义提取、数据集提取、模板辅助设计、模板辅助修改，共 8 类校准场景；每类预登记 2 次有效观测及相同预算，计划完整列出 16 个单元，真实模型尚未运行的保持未运行。
- [x] 提取任务实际传入本次核准内容事实，模板任务实际传入核准参考区域；输入包括素材、任务前提、已知可修缺陷、预期修正与允许改动范围，不能只给出一个基准名称。缺材料或核准事实时列出缺失项，不用旧答案、模型自述或另一场景补足。
- [x] 校准场景从已知可修缺陷出发，区分首次结果与反馈修正结果；分别判断目标修正、非目标保留和未知范围，不将工具调用发生或零 severe 当作纠偏成功。
- [x] 至少一个模板场景有超过 20 个核准区域，后续页包含必须修正的问题；经评估入口和假执行器驱动 MCP 的续取流程，能取得该问题并在结果中核对其处置，不能只检查第一页或仅记一次调用。
- [x] 评估输入指定的核准基准由宿主固定，候选、备注或工具传参中的替代文件不能让编排改用另一份真值；无基准、无效基准和有效基准分别得到诚实状态。运行时越权改写可信文件及凭据隔离由 16 验收，本票不以假执行器服从规则证明权限安全。
- [x] 每次派发保存实际提示词、输入、基准及上游成果身份；合法任务串联与反馈接续不因动态提示词不同被误拒。最后有效比较与宿主终检必须对应同一候选、请求、数据、相关资源、参考和判据身份，改动后旧报告失效。
- [x] 通过假执行器完整驱动 8 类场景及受控 pass、fail、invalid、not-run 结果，报告保留计划和不可覆盖的尝试；假结果显式标为机制验证，不能被计入真实模型有效观测或关闭 A15 的模型验收。
- [x] 计划能引用身份和标准均相容的既有真实证据，并明确尚缺单元；不在本票调用真实模型。原票据 33、34 的业务核查以及 38 的既有真实业务验收仍保留唯一责任，后续统一冻结后只补未覆盖单元，不为本票另跑四场景。
- [x] 本票同步评估配置、报告合同、操作说明、基准格式指引及涉及的 Agent/MCP 资料；公开入口回归验证任务前提、基准实际载入和输出关联，不把合同维护留到最终收口票。

**测试接缝：** 现有评估 CLI 经假执行器进入公开 Agent/CLI 全流程，结合真实 MCP 和宿主成果校验；读取实际轮次文件、工具结果与报告验证基准传递、分页和身份绑定，不调用真实模型，不把合成纠偏当成模型效果。

## Answer

完成日期：2026-10-23。

- 新增公开准备入口 `scripts/agent-eval/prepare-feedback.ts` 和计划入口 `scripts/agent-eval/run.ts --plan`，生成中英文四任务共 8 场景、每类 2 次的 16 单元计划。初始候选明确是受控已知缺陷；目标修正、非目标保留和未知范围独立评分，未派发保持 not-run。
- 可信内容事实、参考区域、种子轮次、实际输入及资料随产品路径固定。24 区域模板的第 22 区问题经真实 MCP 第二页取回；最后有效比较和检查绑定宿主终检内容身份。评分读取公开审核入口的有效候选，pending 覆盖原候选后不能虚报修正。
- 可引用完整实验身份和逐轮身份均相容的既有证据，变更配置、材料、资源、构建或判据明确拒绝导入。机制证据不计真实模型有效观测；本票未调用真实模型，也未使用用户留出素材调优。
- MCP 合同 0.13.1 补充可审计的检查身份、分页摘要；配置、报告、Agent 资料、`docs/agent-feedback-calibration.md`、`docs/agent-eval.md` 与 `docs/mcp.md` 同步。
- 红绿验证：混合 pass/fail/invalid/not-run 揭示并修复执行器报错被技术合格掩盖；pending 覆盖回归先证实旧评分错误通过，再从公开审核有效候选修复。
- `npm run build`、`npm run typecheck` 通过。`npx vitest run test/agent-eval-feedback-cli.test.ts test/agent-eval.test.ts test/agent-eval-identity.test.ts test/agent-eval-attempts.test.ts test/mcp.test.ts --maxWorkers=1`：5 文件 86 项通过；追加 pending 和报告标识修复后，`npx vitest run test/agent-eval-feedback-cli.test.ts test/agent-dataset-template.test.ts --maxWorkers=1`：2 文件 19 项通过。
- 验收边界：无偏离；真实模型的 16 个有效观测、业务效果与模型来源资格仍由票 21 统一冻结后承担，本票仅证明准备、传递、分页、身份和评分机制。
集成复核：以 e874543 非压缩合并至集成分支。核对有效候选、来源身份及技术合格但执行器报错的 mixed 语义；主线 build/typecheck/diff-check 通过，反馈 CLI 与 MCP 两文件 40/40 通过（88.02 秒）。两份预存未跟踪报告未改。


### 2026-10-23 责任修复重新打开

候选3真实观测揭示目标text路径不存在时评分总try提前返回，其余独立守卫未执行却标false。原件与严格corrections政策保留；本轮按公开评估CLI/真实MCP接缝红绿修复独立核查与未核查诊断，不调用模型、不覆盖历史评分。

### 2026-10-23 责任修复重新验收

完成提交：独立诊断 abacbd9，只读审核 60af3ed；最终测试源码 6d0ccc237cc37e56d8641cd0cf30ba1f6f1b5202（合入主线资料修复与历史恢复边界更正）。

- 公开 CLI/真实 MCP 复现 text 改为 slot 后总 try 短路：严格 corrections/1 原属性白名单仍令目标和非目标范围失败，其他守卫独立核对。新增 feedback-score/2，以 null/unchecked 区分未核查与实际失败；空完整日志的未调用为 false，缺失/损坏日志为 null，两者均不能过门槛。模型、输入、阈值与允许范围不变。
- 公开审核新增 persistArtifacts:false；评分的两处读取均使用只读方式。缺检查/预览缓存时不写 checks/previews，实际内存渲染保留尺寸、问题与 assessment，不返回虚构 image。默认审核、资源身份、损坏保护回归保留。文件与目录完整集合及逐文件 SHA 的公开回归覆盖 API 与 CLI rescore。
- 先证实 slot、缺日志、只读缺 checks、只读缺 previews 和 rescore 写缓存五项实际反例，再逐项修复；首个缺日志夹具错误保留但不冒充产品红灯。红绿原件与命令见 docs/agent-eval/feedback-diagnostics/evidence.json。
- 原诊断两文件回归：Windows 29 通过、Linux 29 通过。扩展只读后最终命令：npx vitest run test/agent-eval-feedback-cli.test.ts test/agent-eval-identity.test.ts test/agent-review.test.ts test/agent-resource-identity.test.ts --maxWorkers=1；Windows 4 文件 54 通过（487.14 秒），Linux Node22.23.3 同 54 通过（320.9 秒），两平台 npm run build/typecheck 通过。
- 在新独立恢复副本公开 --rescore 另存新评分身份报告，严格 gate 仍 fail、7 pass/1 fail/8 not-run；原始报告 SHA 13ca58f744090f77f2e95273d30c3d0ff6e5fe25f523bbed15a865e5c3f18c47 不变。新评分器 sha256:99439a81470a6fe374f8902bfd0654ad032c8a298981ec332f4c6cbe106121ed 的三个独立守卫为 true，仅目标/非目标范围 false。原始与恢复各5172文件/977目录经完整集合/SHA前后比较无新增缺改，8轮公开只读审核通过。新报告与完整证明位于 F:/GenCode/render-weave/out/harness-feedback-diagnostics/historical-rescore-readonly-v2/ 和同根 historical-rescore-readonly-v2-verification.json。
- 旧恢复件默认审核新增缓存的更正另存，旧失败日志、缓存及历史报告不删除不改写；新的只读证明不沿用仅检查 manifest 已列文件的边界。详见 docs/agent-eval/feedback-diagnostics/README.md。
- 无模型调用、无留出素材、无历史结果回写；不宣称票21或候选4通过。CONTEXT由独立集成者更新，本轮无新政策决定。
