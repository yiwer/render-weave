# 01: 转录评分准确拒绝乱序、多报和错误重复

**What to build:** 维护者经评估命令核对转录成果时，能按停靠站点的每次出现看到有序对齐证据、错误分类和通过判定，既拒绝反序与多报，也不误伤合法同名站点。

**Blocked by:** 无

**Status:** resolved

**Trace:** [父规格](../spec.md) H1、D04；US02–04、US08；A01、A02。

- [x] 真值原序通过；全部反序、相邻交换、真实插入和超额重复分别被拒绝，报告指出候选位置、真值位置及错误种类，不能只报告命中总数。
- [x] 同一次出现至多匹配一次。合法的 A→B→A→C 通过，两个 A 的地标、设施按各自出现位置核对；地标或设施串位、额外增加的地标或设施不能借同名项抵消。
- [x] 单字错误按对应位置的替换计入站名容错，单次漏项不导致后续全部错位；替换、漏项、插入、错误重复、顺序违例以及地标/设施漏报和误报分别列出。
- [x] 366 保留站名至少 57/59、地标至少 14/15、设施至少 17/18 的既有命中门槛，同时要求已对齐站点顺序违例、真实插入、超额重复、地标误报和设施误报均为 0；门槛来自案例的核准政策，不写入通用领域资料。
- [x] 对无法区分替换与插入等存在歧义的输入给出对齐歧义及所需复核，不任选有利对齐自动通过；评分器版本和匹配政策随报告记录。
- [x] 经现有评估 CLI 对受控成果执行评分，结果与退出状态能区分合法对照和上述反例；本票不以真实模型是否恰好生成错误作为验收条件，也不改写历史报告。
- [x] 评分判据、报告字段说明、案例容错资料与相应公开合同在本票同步；若本票改变模型可见资料或工具行为，记录精确版本及后续模型验收责任，不用离线通过代替模型结论。
- [x] 主模板基准的剩余定位与上下文验收仍归原票据 18，既有四场景真实门槛仍归原票据 38；本票不重复创建或关闭这些责任。缺少真值或核准容错时明确未完成，不用候选自述代替。

**测试接缝：** 现有评估 CLI 的评分与报告出口；使用真值原序及最小变体观察最终分类、对齐证据、判定和退出状态，不直接测试私有匹配中间结构。


## Answer

2026-10-23 完成。评分器改为 `renderweave-transcription/2`，匹配政策为 `ordered-occurrences/1`；按每次出现保留一对一对齐、错误位置及全部最优对应的歧义。纯反序按移位与顺序违例报告；净数量不变的超额同名项也不能藏进单字容错。地标与设施按出现位置分别记漏报和误报，设施重复按多重集合核对。

- `npm run build`：通过。
- `npm run typecheck`：通过。
- `node node_modules/vitest/vitest.mjs run test/agent-eval-transcription.test.ts test/agent-eval.test.ts --maxWorkers=1`：2 个文件、41 项通过（19 项新增公开 CLI 验收，22 项既有评估回归）。假执行器经产品入口交回候选，再由现有评估 CLI 重新评分，检查报告与退出码；没有调用真实模型。
- `git diff --check`：通过。提交前已并入集成基线 `71136d9`。

新增 CLI 验收覆盖原序、反序、交换、真实插入、超额重复、替换与漏项容错、合法同名项及附属内容串位、地标/设施错误值与额外值、同设施重复、带地标设施的单次漏项、替换/插入歧义、同名漏项歧义，以及缺真值、缺政策与旧配置拒绝。合法原序退出 0，业务反例/待复核歧义退出 1；缺核准条件或旧配置退出 2 并明确评估未完成。

成果：[评分实现](../../../scripts/agent-eval/score.ts)、[CLI 验收](../../../test/agent-eval-transcription.test.ts)、[公开报告与运行说明](../../../docs/agent-eval.md)、[366 案例政策](../../../scripts/agent-eval/scenarios/366/policy.md)。配置合同升级为 `renderweave-agent-eval-config/2`；新增 `--config` 读取显式核准案例。366 命中门槛仍为 57/59、14/15、17/18，五类错误上限为 0，歧义必须复核。旧 `/1` 配置不静默补造政策。

历史夹具重查的口径变化：`des-366-gd` 中福滨新村把真值 ① 写成 ②，现在同时列为漏报与误报，地标误报从旧摘要的 3 更正为 4，命中仍为 11/15；既有存档报告未改。

验收偏差：无。本票未改 `agent/` 模型可见资料、任务提示词、MCP 工具或 DSL，MCP 合同仍为 0.10.1。离线通过不代表模型验收完成；固定候选下的既有四场景和英文/样式业务证据仍归原 38，主模板基准剩余定位与上下文验收仍归原 18。本票未关闭这两张原票。`CONTEXT.md` 由集成方统一更新。

### 2026-10-23 冻结前审查缺口与重新验收

冻结前两轴审查发现原闭合证据漏掉“同站有正确地标、另一个字段再报地标”的情况：评分器 /2 只取首个匹配，额外不同值与重复正确值都会被吞掉，违反本票地标误报上限 0。公开 Agent 受控成果经过定义审核/应用、数据集提取及 `--rescore` 后，两个反例原本退出 0；[红测](../../../out/harness-prefreeze-fixes/landmark-red.log)保留原错误通过。状态在 `a02329a` 重开为 ready-for-agent，本次修复及双平台回归完成后重新关闭，不将旧关闭记录解释为已覆盖这些反例。

评分器升为 `renderweave-transcription/3`，站名匹配政策仍为 `ordered-occurrences/1`，增加 `landmarkReferences: all-occurrences-multiset`：逐站收集所有字段、列表及嵌套数据中的地标引用，仅消费一个核准命中，其余每次出现都记为误报。门槛不变，旧报告不改写；评分源码哈希和后续候选身份随本次代码改变。未改 MCP 合同、模型可见资料或 DSL。

[绿测](../../../out/harness-prefreeze-fixes/landmark-green.log)验证同站正确值加额外值、重复正确值均退出 1；补充图片列表中同值重复及异值共存的公开回归，同时确认地铁设施保持正常。既有原序、合法同名站、地标/设施串位、无地标站多报、设施重复及容错边界继续通过。

验证固定源码 `a02329a`（由集成 `d3661a3` 合入票20固定源码 `4f17dc3` 后修复，执行前再次合最新集成为 already up to date）：

- Windows Node 24.12.0：`npm run build`、`npm run typecheck` 通过；`node node_modules/vitest/vitest.mjs run test/agent-template-behavior.test.ts test/agent-eval-transcription.test.ts test/agent-candidate-freeze.test.ts test/agent-visibility.test.ts test/agent-eval-identity.test.ts --maxWorkers=1`：5 文件 67 项全过，753.51 秒，退出 0。
- Linux Node 22.23.3/npm 10.9.9：独立源码快照和镜像内独立依赖运行同一构建、类型检查及五文件回归，67 项全过，512.58 秒，退出 0。容器镜像 `renderweave-service-test:local`，启动脚本与快照清单保存于 `out/harness-prefreeze-fixes/linux-run.sh`、`linux-files.txt`。
- 持久日志：[Windows 回归](../../../out/harness-prefreeze-fixes/windows-regression.log)、[Linux 回归](../../../out/harness-prefreeze-fixes/linux-regression.log)；同目录保留两平台 build/typecheck 日志及 Linux runtime。未运行真实模型，不替代20统一全量或后续业务验收。
