# 17: 按需资料策略形成可验证候选并自动检查资料指针

**What to build:** 维护者可以在校准场景中选择保留强制约束的按需资料候选，确认资料和工具引用可达，并生成与现有全量阅读策略可公平配对的输入；默认策略暂不改变。

**Blocked by:** 14

**Status:** resolved

**Trace:** [父规格](../spec.md) H6、D15–D16；US58–59；A18 的资料策略候选、自动指针检查和配对输入准备子项。配对实跑与收益判定归票据 18。

- [x] 保留现有全量资料策略作为对照，新增可显式选择的按需策略候选；命名、单位、作用域、成果交回、能力与信任边界等强制约束仍在入口可见，默认和既有 effort 决定不变。
- [x] 按需候选以简短资料目录引导按任务阶段读取循环/子模板、文本适配、状态与变量等现有参考；只使用公开 DSL 参考工具已经可达的资料，不增加新的 DSL 语法或另一份规则权威。
- [x] 局部问题按代码或目标聚类，返回必要上下文、实例/源模板位置和续取入口；截断必须明确，不能因压缩资料丢掉必修约束、未知范围或后续页问题。
- [x] 自动检查候选资料目录、DSL 参考、工具合同和共享样例之间的指针与可达性，结果列出通过项、遗留错误及其责任；原数据定义示例的错误指向仍归原票据 20，不在本票重复修复，也不要求原 20 整票关闭后才能验证候选。
- [x] 对原票据 20 的已知遗留错误明确记为未解决，按需候选可通过已可达的正确公开参考验证其路径；检查报告不得因已知责任归属而把错误标成通过。其他新增或由本候选引入的失效指针必须在本票消除。
- [x] 只使用票据 14 的校准场景及其他明确属于校准用途的输入验证资料获取、缺失/无效参考、分页和错误修复引导；不读取留出结果来调整策略，材料不足明确未完成。
- [x] 为两个策略保存可冻结的策略身份、实际资料范围和配对输入，确保后续可固定模型、预算、样本和调度条件比较。当前只用假执行器与公开工具验证可执行性，不运行配对真实模型、不宣称降低成本或提高成功率；实跑、质量守卫和是否改变默认由票据 18 决定。
- [x] 候选策略说明、资料目录、相关工具合同及校准操作指引在本票同步；旧全量资料路径仍可用，候选失效能得到明确错误。同步内容与遗留问题随版本记录，不能留待最后整体验收补说明。

**测试接缝：** 现有评估/Agent 入口的策略选择与实际资料成果，辅以公开 DSL 参考和 MCP 结果；以校准样例和假执行器观察参考可达、约束保留、分页、错误状态与策略身份。真实配对实验不在本票。

## Answer

完成日期：2026-10-23。主实现 `767b091`，参考冻结与审查修复 `3e6b2e3`；同步最新集成 `fdc8a77` 为 `bbd6444`。决定 M322，MCP 合同0.16.0，操作与记录见[资料策略](../../../docs/agent-context-policy.md)、[MCP合同](../../../docs/mcp.md)。CONTEXT由集成任务统一更新。

公开 `agent run` 与评估 CLI 支持 `--context-policy full|on-demand`；缺省full、原全量路径、effort及预算保持不变。候选入口包含原参考逐字摘录的强制约束及完整guide/outcome，阶段目录仅定位现有公开参考。宿主一次保存七份参考/Schema字节，入口与MCP共用，服务启动后不再读活文件；策略身份记录实际可用资料和入口摘要。

`check_outcome.feedback` 给出冻结报告ID；只读 `outcome_feedback` 按代码/目标续取所有局部问题、候选信息、修订差异、实例/源模板位置、未知与待确认。页读不重检、不保存新检查点；修改后需重新检查，下次检查使旧ID失效。单项过长按JSON分片无损还原；首响应总预算兜底保留身份/状态/计数/续页入口并明确 `detailsTruncated`，不能把空摘要当无问题。

`scripts/agent-eval/context.ts --check` 通过真实MCP核对目录、Schema指针、工具合同及共享样例。原票20的错误仍未解决并保留责任，候选以正确 `reference/data-definition` 验证；不存在参考、无效pointer、缺章节均拒绝候选。`--prepare-pair` 只接受票14已登记合成校准资料，保存两组完整身份及执行参数；材料缺失输出ready=false、空arms、退出3，参数漂移在派发前拒绝。

红绿与验收重点：新增策略/工具最初不存在；缺资料计划原先在身份读取阶段报错，现保存未完成计划；固定资料文件缺失/会话中改变、原检查后候选改变、240个覆盖问题后页、700个区域问题、超长未知说明JSON分片、错误/过期报告ID均从公开入口验证。独立Spec审查新增20个合法长区域名反例，原 `check_outcome` 返回76157字符被服务拒绝、续页入口不可达；修复后首响应有界，原始长名称和异常在续页完整还原。中文/英文四任务实际获取目录与反馈后纠偏，模板页含实例及源模板位置；评估入口实际派发8个受控单元并保存on-demand轮次身份。只用假执行器和真实MCP，无远端模型。

验证命令与结果：

- `npm run build`、`npm run typecheck`、`git diff --check`：通过。
- 审查修复前联动：`node node_modules/vitest/vitest.mjs run test/agent-context-policy.test.ts test/agent-dataset-template.test.ts test/agent-eval-identity.test.ts test/agent-eval-feedback-cli.test.ts test/mcp.test.ts --maxWorkers=1`：5文件73项通过，487.89秒。
- 最终同步主线及长名称修复后：`node node_modules/vitest/vitest.mjs run test/agent-context-policy.test.ts test/mcp.test.ts test/agent-eval.test.ts --maxWorkers=1`：Windows 3文件62项通过，249.04秒。
- Linux Node22本地镜像 `renderweave-service-test:local`，`docker run --rm --init` 只读挂载本树并复制到/app（排除.git、宿主node_modules、service/node_modules、out、outside_context），重建后 `./node_modules/.bin/vitest run test/agent-context-policy.test.ts test/mcp.test.ts --maxWorkers=1`：最终2文件40项通过，116.61秒。
- MCP快照用 `vitest -u` 更新并逐项核对：仅新增outcome_feedback及check_outcome续取说明；版本断言与各任务工具清单同步。

Standards自查：没有新增依赖、HTTP服务或DSL语法，测试从真实CLI/MCP和公开报告观察，不导入新的内部函数。独立Spec轴发现的总预算缺陷已用公共反例修复。资料目录、合同、代建指南、决定记录和校准指引同时完成。此结果只证明候选机制可执行；不读取留出结果，不证明真实模型节约或质量改善，也不关闭原票20。票18负责完整配对、成本/质量守卫及默认决定。

集成复核（2026-10-23）：最终分支 `6bcf158` 以 `76207d2` 非压缩合入主集成，无冲突。复核已指出的首响应总预算问题：兜底仍保留内容身份、状态/计数、截断标识和同一冻结报告的完整续页入口；参考固定字节、默认 full、强制约束以及分页不重检的边界保持。

- 主集成 `npm run build`、`npm run typecheck` 通过。
- `node node_modules/vitest/vitest.mjs run test/agent-context-policy.test.ts -t '显式按需|真实MCP的问题|合法超长|公开参考服务' --maxWorkers=1`：4 项通过、4 项未选取，8.47 秒。复核默认入口、同身份续页、合法长区域名称首响应和会话参考固定。
- 合同保留 0.16.0，CONTEXT 同步阶段与能力。未重复双平台全量，分支最终 Windows 62 项及 Linux 40 项的证据保留在上文；两份用户既有未跟踪评估报告原字节未改。


### 首轮正式派发前的来源路径修复（2026-10-23）

本票重新打开：候选1的 `contextPolicy.sources` 将 `agent/README.md`、`agent/tasks/...`、`agent/reference/...` 写成缺首字符的路径。根因是资料目录保留尾分隔符，`materialHashes` 通过目录字符串长度截取时多删一个字符。此前验收只检查身份变化，未核对来源键能否直接定位真实文件，因此没有发现此缺口。

只读逐字节核查候选1和两份计划绑定：15份实际Agent材料映射到15个键，无覆盖或遗漏；七份公开参考/Schema内容完整，`identity.materials` 与候选共同内容清单均按正确路径完整覆盖。候选1仍是零模型观测准备包；修复不改它、票18的32次观测、既有报告或归档。资料来源实现归本票，后续候选2冻结与新计划绑定归票20。

公开评估CLI经受控Agent执行器新增full/on-demand两例：读取 `eval.json` 与轮次provenance，要求来源路径保留真实文件名，完整材料集合一致，并按每个路径读回实际字节核对摘要。修复前两例均因缺首字符失败，日志 `F:/GenCode/render-weave/out/harness-context-source-fix/windows-red.log`；改用平台标准相对路径后两例均通过，日志 `windows-green.log`。不导入私有身份函数，不调用真实模型。

修复后保留原身份格式、MCP合同、默认full、模型和effort；来源键与源码/构建字节改变会自然产生新身份。双平台相关回归已完成，本次验收缺口闭合后重新关闭本票；原18业务结论不重新计数。


最终实现提交 `7339fab`，已基于票20验证提交 `2fe039a`。本次没有修改渲染实现、评分判据或资料内容，因此不重跑渲染全量；相关身份与资料策略回归覆盖既有实验拒绝漂移、来源文件可读、固定公开参考、资料获取与配对报告。

- Windows Node24.12.0：`npm run build`、`npm run typecheck`通过；`node node_modules/vitest/vitest.mjs run test/agent-eval-identity.test.ts test/agent-context-policy.test.ts test/agent-context-trial.test.ts --maxWorkers=1`，3文件38项通过，311.52秒，退出0。
- Linux Node22.23.3 / npm10.9.9：独立容器中从本次源码和实字体重建，同命令3文件38项通过，227.20秒，退出0；build、typecheck通过。
- 两组均为身份19项、资料策略8项、配对比较11项；真实模型观测0。日志、独立Linux源码包与执行脚本另存 `F:/GenCode/render-weave/out/harness-context-source-fix/`，保留红例、绿例及两个平台全部结果。
- 候选1路径标签的只读完整性核查另存 `C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness-context-source-label-audit.json`。旧记录不修补；20须发布新候选与新绑定后再启动首轮，不能把本次机制验证算成正式模型或人工业务通过。

### 模板接续的改前反馈顺序修复（2026-10-23）

本票按资料责任重新打开。票21候选2的16次有效真实观测为10通过、6失败，六次均因模板分页过程守卫失败，其余目标修正、非目标保留、未知保留、终检身份四项守卫全部通过。最终报告SHA256为 `d52b37523959616df1f5cacfdf47b56db09154c90688765f8387f33526045487`；原件与后续新候选的结果分别记录，不重写有效失败。票14的受控校准能力与票21的真实遵循结果不能互相替代。

资料缺口：通用接续先插入按反馈修改的工作副本说明，再要求本轮outcome；模板修改任务在改前核对之前说直接修改，且未明确完整目录的结束条件。已有compare_reference在没有outcome时支持显式templates，目录和点查也可完成正确流程；本批中文模板设计的第二次真实观测已全部通过。因此本修复定位为降低通用接续遗漏风险，不宣称工具能力损坏或模型成功率已提升。

本次只调整 `agent/tasks/next-round.md` 与 `agent/tasks/template-revision.md` 的操作顺序：修改前显式传入全部预置模板工作副本，在相同字节上从目录首页续取到null，再补取必修/截断详情；修改后重查并终检。无核准参考与unknown如实保留，outcome仍按各任务原有规则交回。默认full、MCP合同0.17.0、评分器、预算、校准夹具与可信答案均未改。候选2与其历史观测保持原字节，后续验证需另冻结候选及计划绑定。

已读TDD与writing-for-agents技能，沿已核准公开Agent/CLI/MCP接缝验证。实际公开失败作为改前缺口证据；本次资料变更不新增逐字匹配提示词或让假执行器按新句子分支的镜像测试。现有回归只证明资料传递、分页能力和身份守卫，不证明真实模型遵循。双平台公开回归已完成，资料责任缺口闭合后重新关闭本票；21的真实有效失败仍由该票保留并继续处理。

实现固定在 `d9ebe44`；独立只读审查指出旧接续句“不能只列本轮新改文件”可能与模板修改规则混读，`e4b2d1e` 将其明确为相对本轮已保存模板有改动的工作副本与新建模板，保留原交回范围。测试结束后合入最新集成 `42a2bfe` 为 `12e5ca4`，仅吸收21/原38结果与审核资料，没有改变被测执行内容。CONTEXT由独立集成任务统一更新。

验证命令与结果：

- Windows Node24.12.0 与 Linux Node22.23.3：`npm run build`、`npm run typecheck` 通过；工作树 `git diff --check` 通过。
- 在 `d9ebe44` 固定资料上运行 `node node_modules/vitest/vitest.mjs run test/agent-rounds.test.ts test/agent-context-policy.test.ts test/agent-style-verification.test.ts test/agent-eval-feedback-cli.test.ts --maxWorkers=1`：Windows四文件48项通过，510.72秒；Linux四文件47项通过、1项跳过，303.52秒。跳过项是原有 `test/agent-rounds.test.ts:545` 的Windows模板替换阻断用例，Windows已通过。
- `node node_modules/vitest/vitest.mjs run test/agent-eval-identity.test.ts -t '同一实验固定派发条件|实验来源保留可定位' --maxWorkers=1`：两平台各3项通过（19.30/14.84秒）；`-t '续跑逐项拒绝实际构建'`：两平台各1项通过（19.29/15.96秒），覆盖资料/构建/输入/资源等变化在派发前拒绝、旧实验字节不变。未选取的用例不计本轮通过。
- 对 `e4b2d1e` 最后一句消歧，用现有 `agent-rounds.test.ts -t '下一轮拿到素材'` 和 `agent-eval-identity.test.ts -t '实验来源保留可定位'` 再验证公开提示词传递及full/on-demand来源：Windows各1+2项通过（12.66/11.84秒），Linux各1+2项通过（8.88/7.71秒）。这是已通过关联回归后的最小资料补验，不冒称最终字节再跑过整套全量。
- Linux使用本地 `renderweave-service-test:local`、`docker run --rm --init`，把冻结源码tar和四个真实字体复制到独立 `/tested`，依赖从镜像 `/app/node_modules` 独立复制；没有共享工作树node_modules联接。

改前两份任务原件、固定源码包、全部日志与SHA保存于 `F:/GenCode/render-weave/out/harness-feedback-order-fix/`。`validation.json` 保留首轮结果，`validation-final.json` 固定最终3322个共同执行文件摘要及两份资料前后SHA；与候选2逐项比较，仅 `agent/tasks/next-round.md`、`agent/tasks/template-revision.md` 改变，其余3320个文件相同。候选2清单及两份原任务字节仍匹配旧身份。`linux-run.sh`、`linux-drift-run.sh`、`linux-final-run.sh` 记录可复现命令。

本修复没有调用真实模型；52项Windows及51项Linux关联通过（另1项原平台跳过）与最后各3项补验，只证明公开资料/分页/身份流程仍可执行。真实反馈顺序是否更稳定必须由新候选、新绑定和新观测判断，不能用受控执行器通过覆盖票21的6次失败，也不以本次修改关闭21或原38。


### 候选3后的局部修改与内容判断修复（2026-10-23）

本票按通用资料责任重新打开。候选3的21首段8次真实观测为7通过、1失败；失败轮将固定文字改为变量插槽，当前数据的视觉修正不能替代对授权属性范围的遵守。评分器在目标路径变化后提前返回、令其他守卫一并显示失败的问题由票14另行修复，本票不把这些短路结果解释为全部守卫独立失败。原四场景的M402定义首轮为13/15；其outcome已识别相关说明，但因其标题排版及变化性未定而按固定文字待确认，未为该内容建可选字段。这触发了 docs/stage3-acceptance.md 第308–312行保留的通用指南修正条件。两份原始真实失败保留，不以本次资料验证改判。

实现固定在 `d81df93`，基于 `ad7733a`；验证后以 `402bbdb` 合入主线 `acaea68` 的21候选3负结果文档，未改变执行内容。独立资料审查通过。只改三份通用资料：guide 第1条明确内容判断先于标题/括注排版，含义已知但变化性未知时为该内容建可选字段并在其上列待确认；含义本身未知仍按第8条处理。guide 的“局部修改”成为单一规则来源，两份任务入口按适用分支引用；未授权的文字/插槽、常量/变量表示形式及节点/引用结构保留，只改授权属性值，需要扩展结构才可完成时说明范围并待确认。首次自由设计与明确授权的结构修改保留。

未修改领域约定、首次设计任务、校准答案/反馈、评分器、预算、模型或effort；MCP合同保持0.17.0、默认仍full。三份资料都会进入实际资料身份，下一候选须重新冻结和绑定。原四场景8次及票21的16次有效观测需由候选4重新执行；历史6次额外稳定性探针仅保留为旧参考，本次未派发。不关闭21或原38，不把技术回归当作真实模型遵循。

沿已核准的公开Agent/CLI/MCP接缝，读取两项真实失败作为改前证据，再跑现有受控执行器回归；不加逐字匹配新句子或让执行器按新措辞改行为的镜像测试。验证如下：

- Windows Node24.12.0、Linux Node22.23.3：`npm run build`、`npm run typecheck`、`git diff --check`通过。
- `node node_modules/vitest/vitest.mjs run test/agent-rounds.test.ts test/agent-context-policy.test.ts test/agent-eval-feedback-cli.test.ts --maxWorkers=1`：Windows 3文件38项通过，553.68秒；Linux 3文件37项通过、1项原Windows专用用例跳过，310.84秒。覆盖公开接续/修改提示词传递、全量与按需资料、真实MCP分页、受控反馈与报告边界。
- `test/agent.test.ts -t '轮次目录组装三层资料'`：两平台各1项通过，7.98/3.67秒，核对定义提取收到当前完整guide及任务资料。
- `test/agent-eval-identity.test.ts -t '同一实验固定派发条件|实验来源保留可定位|续跑逐项拒绝实际构建'`：两平台各4项通过，42.12/31.57秒。核对full/on-demand实际来源及摘要、已有有效失败保留、资料变化在派发前拒绝且原实验不变。上述命令均沿用`node node_modules/vitest/vitest.mjs run`及`--maxWorkers=1`；未选取项不计通过。
- 最终共同文件逐字节核对发现本树`src/agent/provenance.ts`有33个CR换行残留；规范为仓库要求及候选3的LF原字节，Git源码无差异、编译产物未变。首轮`source.tar`及原文件另存，最终另存`source-final.tar`，两平台重新build并各跑`agent-eval-identity.test.ts -t '实验来源保留可定位'`2项通过（12.57/8.79秒）。不冒称首轮源码包与最终包全字节相同。
- 最终核对候选3全部3322个共同文件：旧包所有原字节未变；本树仅guide、next-round、template-revision三份资料不同，其余3319个完全相同，四个字体均为实文件。Linux在本地镜像的独立目录复制依赖与源码，没有共享依赖联接。

改前资料、10份真实失败相关原件快照、公开回归日志、两份源码包及最终3322文件摘要保存于 `F:/GenCode/render-weave/out/harness-minimal-change-guide-fix/`；`red-evidence.json`区分模型越界与评分短路，`validation.json`记录所有摘要及平台结果。实际模型调用0；本次资料责任缺口闭合后将本票重新记为resolved，真实质量改善仍待新候选观测。CONTEXT由独立集成者更新。

独立集成：以 `356cdcad` 非压缩合入 `d8bf777`。固定措辞审查无阻塞；42份证据逐项SHA/大小、全部3322共同文件、候选3旧字节、3份最终Git资料字节及日志摘要共6791项只读断言通过，其余3319共同文件完全相同。没有重跑测试或模型。证据清单SHA为 `8a60f1122556c9877c7c805ba5074c40cc5576b268f2f06c549d6c5d53e747c3`；外部 `C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness17-minimal-guidance-final-audit.json` SHA为 `994f4aecbd7270f4001927b14c04ccfa390032253bdcc2df6711d48fad6839f2`。最终diff-check通过，旧候选与失败原件不改。
