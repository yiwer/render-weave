# RenderWeave 项目上下文

接续工作的入口：当前阶段、下一步、已实现能力与文档地图。本文只放结论和指针。

- **接手顺序**：先看「当前阶段与下一步」里在进行的两条线，再按对应的票据索引领取票据（规则见 `docs/agents/issue-tracker.md`）。换设备或首次接手时，先照[开发环境与接续](docs/dev-setup.md)准备软件、key 与不进版本库的材料。
- **事实源**：票据状态以票据文件的 `**Status:**` 行为准；验收细节、测试数量与提交记录分别在票据 `## Answer`、对应的 `docs/*.md` 和 git log 里。决定逐条记为 M 编号（[需求探索记录](docs/discovery/requirements.md)），难以逆转的写成 [ADR](docs/adr/)。

## 一句话

RenderWeave 围绕数据定义、模板与数据集出图：先设计数据结构及其出图方式，再用符合定义的数据批量生成 PNG/JPG。首个业务场景是公交线路牌。

- **产品**（M204–M207，[产品路线图](docs/roadmap.md)）：对外 SaaS。v1.0 把出图做成多租户服务，模板由内部团队用 Agent 代建，已在阶段 4 验收；现在是阶段 5 客户自助做模板。
- **Agent**：用户给出示例图或数据集，业务 Agent 辅助完成数据定义、数据集与模板（M189）。Agent 与人类共用一套写入能力，缺省直发，租户可要求发布前批准，靠版本、审计与回退控制风险（ADR-0022）；产品中的 Agent 循环由服务端进程内的 Tool Runner 驱动（ADR-0027）。
- **界面**：交互参考 Claude Design，左栏对话、右侧模块与画布、评论定位、实时旋钮（M208）；方向见[桌面工作台原型](docs/prototypes/desktop-workbench/README.md)。桌面端是包同一份页面的薄壳（M341）。

## 当前阶段与下一步

两条线并行：P1 是阶段 5 的主线；Agent 验收与 Tool Runner 门槛是 P0，P2（服务端 Agent）开工前两边都要完成。阶段 5 的六段划分见[路线图](docs/roadmap.md#阶段-5-的分段2026-10-27)。

### P1 代建接口与人类页面（阶段 5.0）

[PRD](.scratch/authoring-api-and-pages/spec.md)、[13 张票据的索引](.scratch/authoring-api-and-pages/README.md)，规划决定 M343–M348；界面看[原型截图](docs/prototypes/desktop-workbench/README.md#画板)，票据按画板编号引用。

- **已完成（2026-10-27–28）**：01 控制台换成标题栏模块下拉、`Ctrl+K` 与状态栏的新框架，数据定义模块先只读；02 引擎公开入口 `diffDefinition` 给出两份数据定义的字段级差异；03 审计记代建写入的前后内容哈希与差异摘要，可按主体筛选、导出 CSV（开放 API 1.1.0）。
- **接着做**：
  - 现在就能领取：04 数据定义草案接口、12 平台管理页，可以并行；
  - 07 模板工作副本接口等 04：要用 04 加的权限名，两张票都加迁移，串行免得编号冲突；
  - 之后 05 → 06 与 07 → 08、09、10 两条线并行，11 审批策略等 06、09、10，13 阶段验收收尾。
- **怎么做**：每张票在独立 worktree 里做，合入 main 前确认主检出没有评估在跑（[开发环境与接续](docs/dev-setup.md)「已知的坑」）。
- **顺带合入的修复**：Docker 后端测试的单项超时从 1.5 秒改为 8 秒、超时用例改用 16,000 项的压力牌（M349），本机安静时连续两次 139 条全过；渲染子进程在两项之间退出时换新再交（M350）。
- **测试现状**（2026-10-28，main `e4780ea`，临时 worktree）：构建、类型检查与服务组测试（110 通过、16 跳过）通过。引擎组 6 个 worker 并行时 1,182 通过、57 失败，全在 17 个 `agent-*` 重型集成文件；这 17 个文件逐文件串行（`--no-file-parallelism`，约 60 分钟）重跑后 256 通过、3 失败，所以其余 54 条是并行下的超时与抢 `fixtures/resources` 写锁的 `local.storeBusy`。剩下 3 条都不是 P1 带来的：
  - `agent-budgets`「tool 同步检查阻塞仍按整轮预算结束」：单独跑 3 次都失败，在 P1 之前的 `bd54fc7` 上同样失败；故障注入的标记文件 `renderer-blocked` 没写出来，原因未查；
  - `agent-candidate-freeze`「直接数据集阶段绑定人工应用后的工作区…」：建符号链接报 `EPERM`，本机没开 Windows 开发者模式，已验证 node 在这里建不了符号链接；
  - `agent-context-policy`「票14双语四任务…」：驱动真实命令行的重型用例超过 180 秒时限，推断是本机慢，没在 `bd54fc7` 上对照。

  Docker 后端整组没有在合入 M350 之后的 main 上重跑。下一步：在开了开发者模式的空闲机器上重跑这 3 条与 `node service/scripts/test-docker.mjs`；`agent-budgets` 那条另查故障注入为什么没触发。

### Agent 验收与 Tool Runner 门槛（P0）

缩写：**原四场景**是 M230 的四个评估场景（M402 数据定义、M402 模板、M402 模板辅助修改、366 转录）；**原 38** 是第三阶段票据 38（[额度恢复后的复跑](.scratch/agent-template-authoring/issues/38-retest-after-quota-recovery.md)）；**21–26** 是 [harness 票据](.scratch/agent-harness-hardening/README.md)。

- **正式验收统一用[候选 6](docs/agent-eval/harness-acceptance-candidate-6.md)**（2026-10-25 起；Windows 监督器收尾补修已合入 main）：
  - 已完成：[21 可信反馈真实验收](docs/agent-eval/trusted-feedback-acceptance/candidate-6/RESULTS.md)与[原四场景完整门槛](.scratch/agent-template-authoring/original38-harness/candidate-6-results/README.md)，来源核验及完整归档恢复已独立审核通过；四份中文实际成果审核包已交付（在原设备的 `out/harness-original38-review/zh-candidate-6-index-v2/`，不进版本库）；候选 5 的纯英文成果用户已总体接受，原包保留，不拼入新候选槽位。
  - 还没完成：原 38 的独立样式/状态判断与审核工时；然后按依赖做公交四类型留出（22 横版线路牌、23 竖版线路牌、24 站牌、25 双语站名，v1.1、M317，用户已提供 12 张候选素材）；最后 26 集成证据与真人走查。
  - 历次候选（2–5）的观测、停止与恢复记录见「已完成的工作」里的 harness 一条。
- **Tool Runner**（M340，[ADR-0027](docs/adr/0027-agent-loop-driven-in-process-by-tool-runner.md)）：在空闲机器上用一次评估跑满原四场景并补全量测试，通过后把本机 `agent run` 的缺省改为 Tool Runner。托管给客户前还要：威胁建模复核、生产模型渠道、评估身份按执行器区分。
- **生产化**（v1.0 收费前，[平台化研究](docs/research/2026-10-26-platform-architecture.md)第 6 节 4.x）：单 VM 部署、备份与恢复、登录限频、OTel 与告警、整批导出取舍，都还没开票。

### 未排期的后续

- 阶段 4 验收留下的后续（[第四阶段验收](docs/stage4-acceptance.md#后续)），其中整批导出包按项展开字体（千项 M402 约 33 GB）要先定取舍。
- Agent 外围工具复核的票据 18（模板设计的主模板基准必须等于数据集选定的数据定义）、20（修正模板参考里的数据定义示例指向）是 `ready-for-agent`，做时另升 MCP 合同版本、另跑评估。
- 控制台状态栏"进行中的批次"只数本标签页提交的；要租户范围，得加只读的批次列表端点（P1 票据 01 的偏差）。

## 已完成的工作

按时间排，只留结论与指针。

- **需求探索与业务实体建模**：已完成，见[需求探索记录](docs/discovery/requirements.md)与 `docs/model/`。
- **第一阶段 [渲染流水线](.scratch/render-pipeline/spec.md)**：14 张票据全部 resolved，M402 能从数据集校验一路出到 PNG。收尾审查见 [阶段验收](docs/stage1-acceptance.md)，参考图差异见 [M402 验收记录](docs/examples/m402-acceptance.md)。
- **第二阶段 [本地生产出图](.scratch/local-production-output/spec.md)**：13 张票据全部 resolved。Windows/Linux 全新环境复跑、跨平台比对与两轴审查见 [第二阶段验收](docs/stage2-acceptance.md)，首次使用见[使用指南](docs/guide.md)。
- **第三阶段 [Agent 代建模板的本地闭环](.scratch/agent-template-authoring/spec.md)**（v0.3，[索引](.scratch/agent-template-authoring/README.md)）：15 张票据全部完成，阶段验收通过（[第三阶段验收](docs/stage3-acceptance.md)，M231、M235）。依据是 Agent 运行方式验证（[验证记录](docs/agent-validation.md)，M209–M217，ADR-0015）。
  - DSL 1.0 与 JSON Schema（M223、M224）；`renderweave mcp` 只读工具（M225）；`renderweave agent` 的提取、审核、应用、多轮与模板修改（M226–M229）；三层资料与评估门槛（M230）。
  - 价签与 366 两张新示例图按[代建指南](docs/agent-guide.md)走完全流程，代建模式可行；A11 由用户本人用 M162 竖版线路牌补测，人工约 30 分钟，到正式出图为止。
  - 验收后补了：交回前核对成果的 `check_outcome`（M233）、`view_image` 看资源仓库中的图片（M234）、纵向循环（M236，DSL 1.x 的第一笔加法）、网格中元素静默重叠的修正（M237，ADR-0016 补了布局缺陷修正的口径）、画板上声明缩字下限（M238）、资源命令对非版本仓库目录的提示（M239）。
  - M402 数据定义的评分余量（资料相同的 16 次里 14 次达线）按用户决定不再跟进，资料没变时门槛再因它没过才重新处理（[第三阶段验收](docs/stage3-acceptance.md#后续)）。
- **DSL 1.x 平面设计能力演进**（[规格](.scratch/dsl-graphic-capabilities/spec.md)，[索引](.scratch/dsl-graphic-capabilities/README.md)）：7 张票据全部完成（M251–M257），已变基到阶段 4 之上、跑通全量测试（M249），并在更新后的 `agent/reference/template.md` 上复跑通过 Haiku 5.5 评估门槛（[2026-10-19-dsl-graphic-capabilities](docs/agent-eval/reports/2026-10-19-dsl-graphic-capabilities.json)）。能力见「已实现能力」的元素、模板与线路牌适配三条。
- **第四阶段 [出图服务第一版](.scratch/render-service-v1/spec.md)**（v1.0，[索引](.scratch/render-service-v1/README.md)，M244–M249）：15 张票据全部完成，阶段验收通过（[第四阶段验收](docs/stage4-acceptance.md)，M302–M304）。本机 Docker Compose 从空环境走完 PRD 的完成标准；真人走查从登录到导出记录，动手约 5 分半钟；容量基线是每个 worker 1 个 CPU、2 GB 内存、单项超时 60 秒，M402 线路牌每个 worker 每分钟约 60 张，按物理核数起 worker；OpenAPI 1.0.0 基线定稿。开工前的 ADR 是 ADR-0017–0020（M243）；部署、字体与计费由用户定下（M240–M242）。控制台的结构先做了一轮原型，用户选定方案一（以数据集为中心），原型存档在分支 `prototype/console-v1`。[第二阶段验收](docs/stage2-acceptance.md#接入服务前必须补的验证)列的接入服务前必须补的验证（资源隔离、执行隔离、容量、存储替代）都在本阶段落实；不受信任的记录按 PRD 不接收。
- **模型**（M232）：改用 OpenCode Go，缺省 Claude Haiku 5.5，质量要求高的单子用 Gemini 4 Argon；千问不再使用。Haiku 已在合同 0.7.0 与票据 17 的修改任务提示词上通过四场景评估门槛，Gemini 已在合同 0.5.0 上过门槛（[Agent 评估](docs/agent-eval.md)）。key 只有 `OPEN_CODE_API_KEY` 一个，只经环境变量传入，由维护者在各设备上自行设置，不进仓库。
- **Agent 外围工具复核（2026-10-19）**：[首轮复核](docs/agent-tooling-review.md)开了票据 16–21，[二次复核与实测](docs/agent-tooling-evaluation.md)新开 22–24。已完成 16、17（M293）、19 与 22（合同 0.6.0）、21、23（`--effort`，M291）、24（M292）与 30（提取类单独用 low 也不改）；18 的判据已改写，18、20 还没做（见「未排期的后续」）。
- **阿拉伯文站牌试跑（2026-10-20）**：正式出图 0 问题，但引擎不做塑形与双向排版；用户决定阿拉伯文属于特殊需求，暂不做排版。由此做了票据 25–29：Gemini 转换代理改走流式、去掉 300 秒超时（M287，Gemini 评估门槛没有重跑，下一次 Gemini 评估一并覆盖）；这类文字报严重问题 `text.unshapedScript`（M288）；资料补领域约定的适用条件与文字能力边界（M290）；`agent run` 先校验出图请求；`list_resources` 给字体的字重与覆盖的文字（M289）。同图复跑（[复跑报告](docs/agent-arabic-retest.md)）的后续是[票据 31–38](.scratch/agent-template-authoring/README.md#同图复跑后续2026-10-21按执行优先级)：成果评估、受阻草稿与硬额度停止（M294–M296、ADR-0021），可信参考、多维局部反馈与普通轮次来源留存（M306，[复核报告](docs/agent-33-34-review.md)、[视觉反馈](docs/agent-visual-feedback.md)、[实测](docs/agent-visual-live-acceptance.md)、[提交结果](docs/agent-visual-feedback-results.md)）。用户要求聚焦中文、英文（M307），阿文新模板试跑已停止，已有结果只作历史诊断。
- **Agent harness 实施（2026-10-23 起）**：[可靠执行与可信验收 PRD](.scratch/agent-harness-hardening/spec.md)与 [26 张实施票](.scratch/agent-harness-hardening/README.md)（集成分支 `codex/agent-harness-hardening`，规格基线 `40d14f1`），决定见 M308–M332、ADR-0023–0026，研究依据见[工程评估](docs/research/2026-10-23-agent-dsl-harness-review.md)。
  - 01–21 已合入：有序转录评分、模板业务行为、固定审核资源、并发提交与崩溃恢复、实验身份、不可覆盖尝试及完整成本、持久轮次状态、完整检查点、运行时限、停滞控制、订单成本与人工投入、信任边界、按需资料候选、可信反馈校准等，能力见「已实现能力」。
  - 18 的 32 次真实配对：按需资料的输入加缓存只降 9.07%，质量守卫未全部通过，保留全量资料为缺省（[配对结果](docs/agent-eval/context-policy-trial/RESULTS.md)）。
  - 20 冻结并独立核验了候选 5（[候选 5 离线发布](docs/agent-eval/harness-acceptance-candidate-5.md)），正式计划后来更新为候选 6。
  - 历次候选的观测与停止：候选 2 的 21 为 10 通过、6 次分页时序有效失败；候选 3 首段 7 通过、1 失败（[首段结果](docs/agent-eval/trusted-feedback-acceptance/candidate-3/RESULTS.md)，[修复证据](docs/agent-eval/feedback-diagnostics/README.md)）；候选 4 两个计划在 429 后停止、不自动续跑（[停止及完整恢复](.scratch/agent-template-authoring/original38-harness/candidate-4-results.md)，[只读恢复复验](docs/agent-eval/archive-readonly-candidate4.md)，[边界更正](docs/agent-eval/archive-restore-boundary-correction.md)）；纯英文 TfL161 材料已核准（M330），候选 5 完成首次设计与一次纠偏。混合站牌的负面评价保留，停止继续还原；旧失败一律保留不覆盖。
- **模板设计评估集（2026-10-25–26）**（[规格](.scratch/template-design-eval/spec.md)，[索引](.scratch/template-design-eval/README.md)，M333–M339）：12 个模板辅助设计用例（线路牌横竖版、价签两种与 8 个新领域）与 8 个领域约定包；通过线是压测全部、版面 85%（M337）。main 的 Agent 上 Haiku 5.5 达线 11/12（06 补约定后重跑达线），DeepSeek V4.1 Flash 放宽到 3 小时也只有 5/12，模板任务继续用 Haiku（M338）。评估集暴露出通用资料没写"文字元素只有一行、不会自动换行"，已补进资料并采用（M339）。
- **Agent 执行方式（2026-10-26）**：产品中的业务 Agent 用 Tool Runner 驱动，不依赖 Claude Code（M340，[ADR-0027](docs/adr/0027-agent-loop-driven-in-process-by-tool-runner.md)）；依据是[平台化研究](docs/research/2026-10-26-platform-architecture.md)与[执行器原型](docs/agent-eval/tool-runner-prototype.md)，原型在原四场景上与 Claude Code 执行器各 2/2 达线。
- **阶段 5 规划（2026-10-27）**：分 P0–P5 六段（[路线图](docs/roadmap.md#阶段-5-的分段2026-10-27)）；桌面端做 Electron 薄壳（M341），模块上下文对话先只读（M342）；P1 规格与票据见上文。

## 已实现能力

领域模型文档含未来设计，当前可执行的能力以本节为准。

- **DSL 1.0**：数据定义、数据集、模板、渲染请求与批次请求都有人读参考（[docs/dsl/](docs/dsl/README.md)）、JSON Schema（`schemas/`）与一致性测试，兼容策略见 ADR-0016；公开入口 `checkDslDocument`、`dslDocumentKind` 识别并检查单份文档。Agent 参考在 `agent/reference/`。
- **入口**：渲染入口 `render(workspace, request)` 返回图片、问题清单与布局摘要，这是主接缝；发布静态数据定义是次接缝。CLI `renderweave render` / `publish` 把成果写到输出目录，用法见 [README](README.md)。
- **数据**：数据定义发布为静态数据定义，并编译出 JSON Schema；数据集按全部字段类型与约束校验。公开入口 `diffDefinition(before, after)` 按字段列出两份数据定义之间的增、删、改与属性键，改名是一删一增并标为会影响绑定，字段顺序与列表、引用的子键单独标出，读不了的输入回答问题清单（[用法](docs/dsl/data-definition.md#比较两份数据定义)，P1 票据 02）。
- **元素与布局**：画板与容器（自由、堆叠及 `wrap`/`crossGap` 自动流式换行、网格，M253）；横排与竖排文本（横竖排片段独立字体与字号、插槽展示格式、常态字间距 `letterSpacing`、横排倾斜、文字描边、竖排方向性标点顺时针旋转 90°，M255、M256）；PNG/JPEG/WebP/SVG 图片（三种适配、可选 `tint` 单色重染，M257，SVG 见 [SVG 说明](docs/render-svg.md)）；矩形、椭圆、线条、多边形、路径（线条、多边形、路径支持 `viewBox` 与 `fit` 随框缩放，M254）。
- **模板**：模板参数、派生变量（条件分支与 `all`/`any` 复合条件、取项、按分隔符拆取文本 `splitPart`、长度、加减乘除取模，M251）、检查项、绑定、条件显示、状态样式，出图前做静态检查；循环容器（横向或纵向排列，每项等分、随内容或固定尺寸，支持 `reverse` 反序、`slice` 区间切片与 `wrap`/`crossGap` 自动流式换行，M236、M252、M253）与子模板调用（独立作用域）。
- **线路牌适配**：横向或纵向合并相邻同值项与道路带（M252）；横排按墨迹分布，先收紧字距、再压缩字形、再缩字（M255）；竖排缩字组跨循环与子模板统一字号并按比例缩放片段字号（M256）。缩字下限由模板在画板上声明，缺省 5 mm，价签一类小标签可低到 1.5 mm（M238）。
- **字体与模式**：缺字逐字替代为思源黑体（[字体说明](docs/render-fonts.md)）；阿拉伯文、希伯来文、印度系文字等需要塑形或从右往左的文字报严重问题 `text.unshapedScript`（M288）；草稿显示占位与问题边框，正式模式有严重问题时不出图（[模式说明](docs/render-modes.md)）。
- **第二阶段已完成**：二维码（[说明](docs/render-qrcode.md)）、CODE128（[说明](docs/render-barcode.md)）、EAN/UPC（[说明](docs/render-retail-barcodes.md)）、资源内容版本的导入与替换（[说明](docs/resources-versioning.md)）、1–1,000 项的批量正式交付、批量草稿预览、逐项记录重放、项间取消与中断后辨认、同批素材硬链接去重、码图模板交付与重放（[说明](docs/output-records.md)，[带码线路牌样例](docs/examples/coded-route-sign/README.md)）。
- **MCP 只读工具服务**：`renderweave mcp` 提供 12 个只读工具：读取工作区快照与资源、校验数据定义/数据集/模板工作副本、草稿预览（工作副本、数据集文件、局部预览）、元素检查、局部放大（工作目录内的图片，或用 `res:资源ID` 看资源仓库中的图片，M234）、DSL 参考与交回前核对成果（`check_outcome`，M233）。工具合同有快照测试，当前版本 0.17.0（历次加法见 [MCP 工具服务](docs/mcp.md#合同与版本)）：看图缺省最多 2 倍，文字结果不超过 40,000 字符（问题清单与元素检查有上限，大 Schema 返回目录、按 `pointer` 取一段），字体带字重与覆盖的文字（M289）；`check_outcome` 返回模板修改的状态、路径与属性键名，每候选最多 100 条、约 20,000 字符，截断给总数（M293），见 [MCP 工具服务](docs/mcp.md)。
- **业务 Agent 任务**：`renderweave agent run` 支持数据定义提取、数据集提取（`--definition`）、模板辅助设计（`--dataset`、`--request`）与模板辅助修改（`--requirement`，主模板调用树中的已保存模板预置为工作副本），带反馈的下一轮用 `--from`、`--feedback`，在独占轮次目录中组装三层资料与工作区快照，按 ADR-0015 在空白环境里启动 Claude Code，只连 `renderweave mcp`。`--executor tool-runner` 改由宿主进程内的 Tool Runner 驱动同一套工具，读图缩到 2000 像素以内（ADR-0027；原型，本机缺省仍是 Claude Code）。Agent 交回前可用 `check_outcome` 按同一套规则自查；交回的成果先查结构、再经引擎校验，写出 `outcome.json`、`check.json` 与 `round.json`。`agent review` 在本机打开审核页：对照示例图、图上位置与 RenderWeave 重新渲染的草稿预览（M52；模板辅助修改另有修改前的预览与结构化差异），逐项处理待确认项、整体确认，结果存进 `review.json`，并列出轮次链；`agent apply` 只接受审核通过的轮次，工作区变化时列出差异并拒绝（`--overwrite` 覆盖，或带反馈重做），把数据定义发布为下一个版本，数据集与新模板保存为新文件，模板的工作副本替换已保存的模板。见 [业务 Agent 任务](docs/agent-tasks.md)，从示例图到出图与修改的整套操作见 [代建指南](docs/agent-guide.md)。模型缺省为 OpenCode Go 上的 Claude Haiku 5.5；选 Gemini 4 Argon 时 `agent run` 在本机起转换代理，Claude Code 只拿到本轮令牌（M232）。资料在 `agent/`，领域约定包有公交线路牌 `route-sign`、超市商品价签 `price-tag`，以及为模板设计评估集写的 `asset-tag`、`metro-strip`、`clinic-doorplate`、`waybill`、`departure-board`、`hazmat-label`、`order-label`、`boarding-pass`（M336）；审核页在 `web/`。
- **Agent 评估**：`npx tsx scripts/agent-eval/run.ts` 经产品路径跑 M402 数据定义、M402 模板、M402 模板辅助修改与 366 转录四个场景，按 M211–M217 的检查评分，每个场景连续两次达线门槛才通过；报告只存摘要，存档在 `docs/agent-eval/reports/`。升级 Claude Code、换模型、改资料、改工具合同后必须跑，不进 `npm test`；额度窗口装不下一整遍时可分段跑；上游 500 一类瞬时错误按轮次重试，额度窗口的 429 停止派发并打印续跑命令，结果作废的单元记 `invalid`，门槛可能是 `incomplete`（退出码 3）。模板辅助修改按版面、压测与已保存模板的修改范围评分，另记改动元素数（M292）。报告记思考 token、被转存的工具结果数与模板轮首次检查的问题数，`--effort` 透传给 `agent run`（M291）。Gemini 经 `agent run` 内置的转换代理评估。qwen3.8-max 与 OpenCode Go 上的 Claude Haiku 5.5、Gemini 4 Argon 门槛通过。见 [Agent 评估](docs/agent-eval.md)。门槛之外有模板设计评估集（`--config scripts/agent-eval/template-design/config.json`，12 例，M333–M335）：每例在单元目录里组只含本例图片的资源仓库，按用例的 `stress.json` 压测与 `checks.json` 版面检查评分；通过线是压测全部、版面 85%（M337）。
- **存储接口**：工作区文档、版本化资源仓库与出图记录都经接口读写，有本地与内存两种实现，同一组合同测试；批量交付拆成"固定"与"交付单项"两步，批次快照可序列化（[说明](docs/storage-interfaces.md)，ADR-0018，M250）。
- **出图服务骨架**：`service/` 单独成包，只经引擎的公开入口调用引擎。
  - `node service/scripts/up.mjs` 一条命令起 PostgreSQL、S3 兼容存储、接口进程与 worker；
  - 迁移按版本号执行、启动时检查，健康检查分存活与就绪，日志是结构化 JSON；
  - 工作区文档、资源仓库与出图记录有 PostgreSQL 加 S3 实现，与本地、内存实现跑同一组合同用例；
  - 租户、成员与五种身份的鉴权：会话、API 密钥与代建令牌只存哈希，权限按 M247 的矩阵；应用账号加行级安全、跨租户端点清单与审计（M261–M263）；代建写入的审计另记前后内容哈希与差异摘要，可按主体种类与时间筛选、导出 CSV（M347，开放 API 1.1.0）；
  - 代建推送：`renderweave push` 把本地工作区与资源版本仓库推送到客户的租户，先列差异，有冲突整体拒绝，没有冲突一次提交；令牌只经环境变量传入；模板记修订，`template-revisions` 可把当前修订指回旧修订（M264、M265）；
  - 渲染 worker 与草稿预览：PostgreSQL 任务队列，调度进程加渲染子进程，单项超时、容器内存上限与子进程换新；模板列表与查看，同步草稿预览，入队前用引擎的 `measureRender` 检查像素与展开规模，按租户限并发与频率（M266、M267）；数值按容量基线定：每个 worker 1 个 CPU、2 GB 内存、单项超时 60 秒、做满 500 项换新，并发数是 worker 个数 `RW_WORKERS`（M302）；渲染子进程在两项之间退出（例如被 cgroup 因内存结束）时换新再交这一项，调度进程不再整个退出（M350）；
  - 批量正式交付：`POST /v1/batches` 固定批次、按项入队，worker 逐项交付出图记录、发布批次清单，可查进度、可取消（正在渲染的一项也能结束）、带幂等键重试；批次只由接受它的构建交付，worker 停止前做完已接受的项，中途退出的项过了租约由同构建重领（M268、M269）；
  - 数据集与资源接口：数据集的新建、读取、修改、复制、列出与只校验，按原始字节存，保存时由引擎的 `checkDataset` 校验，问题与渲染时相同；图片与字体资源的上传、列出与读回，替换先检查影响（引擎的 `resourceImpact`，与本地 `resources-check` 共用），再由管理员凭报告按预期版本应用，提交前在同一把锁里核对工作区指纹（M270、M271）；
  - 出图记录：按时间、模板与批次查询，下载单个文件与整批图片，按项或按批次导出（与本地 `deliver` 的成果逐字节相同，能用 `batch-read`、`record-read`、`replay` 离线核对），读取时逐文件核对哈希；重放按记录里的构建标识交给那个构建的 worker，worker 定期报到，没有那个构建的 worker 时拒绝；镜像按构建保留，Compose 的 `replay` 配置用旧镜像起 worker（M272、M273）；
  - 计量与额度：平台管理员设套餐（每月出图张数、单张最大像素、并发数）；提交批次在一个事务里锁当期计数行预占，额度不够整批拒绝（429 `quota.exceeded` 带剩余额度）；交付成功与登记同一事务计 1 张，失败与未执行退回预占，批次结束退回剩余；周期是 UTC+8 的自然月，不结转；接口进程定期对账，退回没人再交付的批次遗留的预占；`renderweave push --rounds` 把代建各轮的 token 记为用量事件，只记不拦；客户管理员与平台管理员查已用、预占、剩余与明细（M274、M275），合计操作员与 API 密钥也能查（M300）；
  - 开放 API 合同与 webhook：`GET /v1/openapi.json` 返回按路由生成的 OpenAPI 3.1 描述，快照在 `docs/api/openapi.json`，相对 1.0.0 基线只做加法；错误回答按类别映射状态，每个用例的回答都按描述核对；客户管理员与 API 密钥注册 webhook，批次结束时投递带 HMAC 签名与时间戳的事件，失败按指数退避重试，投递记录可查；签名密钥加密存放（[开放 API](docs/api.md)，M276、M277）；
  - 出图控制台：接口进程在 `/console/` 下提供 React 加 Vite 的网页，只调开放 API。客户的管理员与操作员以数据集为中心工作：按编译产物生成的表单填数据（九种字段类型，对象列表排成表格），边填边按服务端问题清单校验，草稿预览的问题叠加在图上；出图在侧栏里进行，能按一个整数参数的范围出多张、几份数据集一起出，逐项看进度、取消，下载单张与整批压缩包；模板只读，可调参预览。静态数据定义有只读端点（[出图服务](docs/service.md#出图控制台)，M278–M282）。另有出图记录（按日期、模板、批次查询，下载图片，按项或按批次导出）、资源（上传，管理员替换前看影响、确认后应用）、用量（合计两种角色都看，明细只给管理员，M300）与只给客户管理员的管理页（成员与角色、只显示一次的 API 密钥、webhook 与投递记录、审计日志，M301；审计日志显示内容哈希与差异摘要，按主体与日期筛选、导出 CSV）。框架是原型第 29 版：标题栏的模块下拉按角色只列能进的模块、`Ctrl+数字` 切换，`Ctrl+K` 只列模块与常用动作，状态栏显示连接、租户、本月剩余与本标签页进行中的批次；Agent 左栏留了位置、P2 前不显示；数据定义模块先只读（P1 票据 01）；
  - Excel 导入：服务端解析 `.xlsx`（只用 MIT 的解压库，解开之前按登记的大小限量），一行一个渲染项，简单列表写在一格，引用列表另起一张表用关联值对应；答导入预览——逐行的数据集与问题（定位到工作表、行与列）和只含能提交的行的批量请求，确认后照常提交批次；按数据定义下载空白表；控制台在数据集页的侧栏里导入（[出图服务](docs/service.md#excel-导入)，M283–M286）；
  - 可观测与维护：worker 的就绪检查带队列积压、存活检查带渲染用时；接口进程队列不空时定期记一行积压，并删掉过了保留期的预览与重放任务行（M303）；
  - 验收与容量：`service/scripts/accept-stage4.mjs` 从空环境走完完成标准，`service/scripts/capacity.mjs` 测单项画像、千项长批次、多个 worker 与长期负载（M304）；
  - 开放 API 用例跑内存后端进 `npm test`，跑 PostgreSQL 加 S3 后端在 Docker 后端测试 `node service/scripts/test-docker.mjs`；控制台的浏览器用例在 Docker 后端测试里跑（[出图服务](docs/service.md)，M259–M286）。
- **成果与中断处理（M294、M295）**：MCP 合同 0.10.0 的 `check_outcome` 分开评估结构、候选、内容待审核及完整请求的实际渲染；已知能力受阻保留成果说明，严重问题继续阻止批准与应用。未交回有效 outcome 时，宿主另存带哈希的 `draft.json`，可查看但不能批准；`--from` 恢复候选。应用前在当前工作区重渲染。明确硬额度错误会封住 Google 代理后续请求并停止本轮执行器，记录 `run.stopped` 和续跑入口；直连仅在运行时明确报告同类错误时停止。普通限流与瞬时错误保持原处理。
- **参考比较（M306）**：`--reference` 固定人工核准区域、原图与画板尺寸；只读 `compare_reference` 返回真实内容的同尺度三联图、缺项/文字/字号/尺寸/位置/文字颜色差异及源模板/实例位置，和最终检查共用模块。报告绑定实际工作区、数据、资源字节、参考与构建。状态仅来自核准清单；最终遮挡、对比度、复杂变换及未标注部分保持未知，不输出整体分数。
- **提取覆盖核查（M306）**：`--content-baseline` 提供本次可信字段与数值事实，缺省为未核查；领域名、模型备注不能制造真值。明确严重不一致会阻止技术合格，pending 与预览使用同一有效候选但仍需审核；派生语义等未知项独立列出，总分为 null。
- **普通轮次来源留存**：与评估共用源码/资料清单生成逻辑，保存实际任务提示词、实际资料副本及哈希、工具合同、引擎标识与固定参考；下一轮检查参考字节再继承。复跑命令见[视觉反馈](docs/agent-visual-feedback.md)。
- **可信反馈校准**：公开准备与评估计划入口提供中文/英文四任务共 8 场景、16 单元，可信基准随任务固定；目标修正、非目标保留及未知范围独立判断，待确认值使用审核有效候选，最后工具检查与宿主终检核对身份。反馈评分`renderweave-feedback-score/2`以null/unchecked区分证据不足与已核查失败；公开`readReview(roundDir, {persistArtifacts:false})`可核查封存轮次而不保存检查/预览缓存，默认交互审核行为不变。24 区域样例含第二页必须处理的缺陷，兼容来源须核对完整实验与轮次身份；机制通过不计真实模型观测；该能力首发 MCP 合同 0.13.1，当前版本随集成升版。入口与边界见 [反馈校准](docs/agent-feedback-calibration.md)。
- **harness 已合入能力**：转录评分器 `/3` 按停靠位置核查站序、多报、重复及附属事实，评估配置 `/2` 明确独立真值与容错政策；`--behavior-policy` 从公开渲染入口离线核查六类反事实和修改范围，缺少事实继续未核查（[模板业务行为检查](docs/agent-template-behavior.md)）。MCP 合同已升至 **0.17.0**：审核使用私有固定资源与检查内容身份，相关资源改变使旧批准失效，`reopen` 重新固定资源并核准，覆盖选项不能绕过；历史缺身份记录须重审，损坏不覆盖原检查与预览证据（[Agent 任务](docs/agent-tasks.md)）。应用共享有序写锁并在提交前重核内容身份；读者取得完整工作区快照。评估冻结构建、资料、输入、资源实际字节、判据和运行参数，并对每个实际轮次封存。新轮次持久保留启动与执行状态，强退不会冒充完成；有限可见性核查支持透明、轴对齐裁剪、后绘制不透明矩形完全遮挡，其他情形保持未知。应用以持久提交意图和幂等回执恢复，操作系统拥有权与短锁避免并发恢复破坏新写入。评估每次派发保留独立尝试原件和兼容视图，重试与强退成本、未知用量、实际会话墙钟分别记录。受管 MCP 的完整检查由宿主固定字节后保存检查点，强退接续恢复完整集合，拥有权冲突和损坏副本明确拒绝。候选选择保留最新完整及有证据改善的较好候选；同核准依据下按完整问题、未知范围和核准改善比较，互有得失与不可比较明确区分，审核可看内容差异并按选择接续。可信反馈校准提供中英文四任务、16单元离线计划，固定核准事实和24区域参考，从真实公开入口核对后续页问题、目标修正、非目标保留及终检身份；机制结果不计真实模型观测。监督层可按整轮时限或取消终止本轮进程树并有界保存最后完整检查点；运行时限验收见票10。停滞只在核准必修问题经完整反馈和修复复测仍无进展、执行器继续修复时停止，正常确认、缺页与不足证据不计；阈值默认两周期，实际值进入轮次与实验身份，停止复用有界保存并可新轮次接续（[停滞控制](docs/agent-stagnation.md)）。订单入口固定业务范围，关联全部尝试、原始和人工修正质量、独立人工分钟及正式交付；单位成功订单成本纳入失败订单，未知不补零，分享只输出白名单摘要（[订单成本与人工投入](docs/agent-orders.md)）。Anthropic 与 Google 上游凭据留在宿主，执行器只持本轮代理令牌；已知凭据在进入响应、日志与诊断前脱敏，四类低可信来源的实际拒绝和正常交付分开验证，边界见 [本地信任边界](docs/agent-trust-boundary.md)。可显式选择 full/on-demand 资料策略，默认仍为 full；入口保留强制约束，七份公开参考与 Schema 由宿主固定字节。outcome_feedback 按同一检查身份完整续取问题、差异及未知范围，分页不重检，超长首响应保留状态、计数和续页入口；资料目录、合同与共享样例可自动核对，遗留指向问题继续归原20。候选机制与默认决策边界见[资料策略](docs/agent-context-policy.md)。已完成32次真实配对，输入加缓存下降9.07%，未达20%且质量守卫未全部通过，保留 full 默认；完整负结果、来源及归档恢复见[配对结果](docs/agent-eval/context-policy-trial/RESULTS.md)。本次校准不替代20冻结之后的模型与独立业务验收。共同待验候选已按实际源码、构建、审核页、资料、Schema及运行依赖实拷贝冻结，公开资料路径可定位；原四与可信反馈有独立计划绑定，派发前核对字节，新候选列出全部重验单元。人工审核链逐阶段固定实际工作区与上游应用凭据，保持人工review/apply边界。验证由双平台基线全量和明确责任修复回归组成，原失败保留；冻结不代表模型门槛或独立业务审核通过。
- **未实现**：URL 图片、动态模板、OCR 接入；网页上编辑数据定义与模板（P1 在做）；服务端托管的业务 Agent 与 Agent 写工具（P2）；桌面端（P5）；命令行没有跨批次去重（服务端按哈希去重）。

## 文档地图

| 文档 | 职责 |
|---|---|
| [AGENTS.md](AGENTS.md) | agent 工作方式与技能配置（`CLAUDE.md` 只是加载入口） |
| [CODING_STANDARDS.md](CODING_STANDARDS.md) | 引擎边界、测试接缝、快照与 golden 更新 |
| [GLOSSARY.md](GLOSSARY.md) | 领域术语表，唯一的术语事实源 |
| [docs/discovery/requirements.md](docs/discovery/requirements.md) | 需求访谈、已核查事实（旧系统、CloudKiln、Qwen-OCR）、M 编号逐条决定 |
| [docs/model/business-entities.md](docs/model/business-entities.md) | 业务实体、关系与规则，含两张关系图与 G 系列待定事项 |
| [docs/model/template-elements.md](docs/model/template-elements.md) | 13 种模板元素、共有属性、位置与尺寸、可绑定范围、排布与适配 |
| [docs/examples/route-sign.md](docs/examples/route-sign.md) | 线路牌走查：演示 A–D（同名站点、站数与长站名、素材不完整、辅助修改） |
| [docs/examples/m402-acceptance.md](docs/examples/m402-acceptance.md) | 首期端到端验收、场景结果、参考图差异与复现命令 |
| [docs/stage1-acceptance.md](docs/stage1-acceptance.md) | 阶段收尾审查、可靠性/鲁棒性/可用性、修复结果与 DSL 能力边界 |
| [docs/stage2-acceptance.md](docs/stage2-acceptance.md) | 第二阶段全新环境复跑、跨平台比对、指南实测、两轴审查与服务前要求 |
| [docs/stage3-acceptance.md](docs/stage3-acceptance.md) | 第三阶段验收矩阵 A01–A12、两张新示例图的端到端代建记录、模型对比、两轴审查与后续 |
| [docs/stage4-acceptance.md](docs/stage4-acceptance.md) | 第四阶段验收：完成标准的全流程、容量基线与长期负载、真人走查、回归与跨平台、安全、两轴审查与后续 |
| [docs/agent-tooling-review.md](docs/agent-tooling-review.md) | 2026-10-19 的 Agent 外围工具复核：P1/P2/P3、证据、对应票据与未开票小账 |
| [docs/agent-tooling-evaluation.md](docs/agent-tooling-evaluation.md) | 同日的二次复核与实测：看图倍数与拼图、Claude Code 的工具结果上限、工具输出大小、评估流日志统计、逐票意见、新发现与落地顺序 |
| [docs/dev-setup.md](docs/dev-setup.md) | 换设备接续：软件版本与自检、key 与模型服务、不进版本库的材料、Linux 测试与 key 扫描、已知的坑 |
| [docs/roadmap.md](docs/roadmap.md) | 产品定位、形态、v1.0 代建模式、阶段与稳定版本、待定的难逆转事项 |
| [docs/agent-validation.md](docs/agent-validation.md) | M190 Agent 运行方式验证与阶段 3 首测：看图、工具闭环、数据定义候选、领域约定复测、模板生成、产品命令实跑、审核与应用走查、数据集与模板实跑、模板辅助修改与多轮实跑（M215 复现）、模型取舍与复现 |
| [docs/guide.md](docs/guide.md) | 首次使用指南：导入资源、批量交付、失败定位、替换与独立重放 |
| [docs/examples/m402-design-analysis.md](docs/examples/m402-design-analysis.md) | 真实设计稿对照模型 |
| [docs/examples/m402-dsl/](docs/examples/m402-dsl/README.md) | 数据定义 DSL、编译产物、数据集、模板 DSL、渲染请求草稿 |
| [docs/adr/](docs/adr/) | 难以逆转、需要解释的决定 |
| [docs/render-modes.md](docs/render-modes.md) | 检查顺序、阻止展开、草稿占位与问题边框 |
| [docs/render-retail-barcodes.md](docs/render-retail-barcodes.md) | EAN/UPC 完整编号、校验位、专属留白及解码格式核对 |
| [docs/render-barcode.md](docs/render-barcode.md) | CODE128 DSL、下方文字、尺寸与独立解码验收 |
| [docs/render-qrcode.md](docs/render-qrcode.md) | 二维码 DSL、整数像素模块、独立解码与错误诊断 |
| [docs/render-svg.md](docs/render-svg.md) | SVG 资源、字体、加载边界与跨平台复现 |
| [docs/render-fonts.md](docs/render-fonts.md) | 字体加载、缺字替代、引擎后备字体配置与问题摘要 |
| [docs/output-records.md](docs/output-records.md) | 批量正式交付、草稿预览、取消与中断辨认、自足重放与故障验收 |
| [docs/resources-versioning.md](docs/resources-versioning.md) | 资源导入、替换影响检查、旧版查询与固定版本出图 |
| [docs/storage-interfaces.md](docs/storage-interfaces.md) | 工作区文档、版本化资源仓库与出图记录的存储接口，本地与内存两种实现，批量交付的固定与交付单项 |
| [docs/service.md](docs/service.md) | 出图服务：本机一条命令启动、配置的环境变量、进程与命令、健康检查、容量基线、迁移、存储布局、构建标识与镜像、Docker 后端测试 |
| [docs/api.md](docs/api.md) | 开放 API：鉴权、错误与问题清单、各类端点、webhook、OpenAPI 快照与变更记录 |
| [docs/research/](docs/research/) | 一手资料研究：Agent 与 DSL harness 工程评估（2026-10-23）、平台化的产品形态与技术选型（2026-10-26） |
| [docs/dsl/](docs/dsl/README.md) | DSL 1.0 参考：五种文档的写法、Schema 与引擎的分工、Schema 之外的检查、已知限制 |
| [docs/mcp.md](docs/mcp.md) | `renderweave mcp`：启动、12 个只读工具、草稿预览与元素检查的输入、交回前核对、查看资源图片、路径限制、合同版本 |
| [docs/agent-guide.md](docs/agent-guide.md) | 代建指南：准备 key 与资料、写项目说明、发起各类任务、审核、应用、出图与修改，命令可以直接复制 |
| [docs/agent-tasks.md](docs/agent-tasks.md) | `renderweave agent run`、`review`、`apply`：四种任务的输入与工具、模板辅助修改、下一轮与轮次链、隔离、轮次目录、成果格式与校验、审核页、预览与 review.json、应用与冲突、退出码 |
| [agent/](agent/README.md) | 交给业务 Agent 的资料：通用做法 `guide.md`、领域约定 `domains/`（含模板）、项目说明模板 `briefs/`、任务提示词 `tasks/`、DSL 参考与成果格式 `reference/`；三层的优先级与归属规则见 `README.md` |
| [docs/agent-eval.md](docs/agent-eval.md) | Agent 评估：必须运行的时机、命令、场景与通过线、评分与校准、报告格式与历次结果；工具在 `scripts/agent-eval/`，报告在 `docs/agent-eval/reports/` |
| [scripts/agent-eval/template-design/](scripts/agent-eval/template-design/README.md) | 模板设计评估集：12 个用例（样图、项目说明、专家数据定义与数据集、压测、版面检查、用例文档）、图片素材与来源核对 |
| [web/](web/review.html) | `agent review` 的本地审核页（单个 HTML，由 `src/agent/review-server.ts` 提供） |
| [docs/prototypes/desktop-workbench/](docs/prototypes/desktop-workbench/README.md) | 阶段 5 桌面工作台原型：从 claude.ai 设计画布导出的 21 张画板源文件、素材与逐张截图，P1 票据按画板编号引用 |
| [docs/agents/](docs/agents/) | 技能读取的 issue 记录方式、triage 标签与领域文档规则 |
| [.scratch/render-pipeline/](.scratch/render-pipeline/spec.md) | 首期规格与 14 张票据 |
| [.scratch/local-production-output/](.scratch/local-production-output/README.md) | 第二阶段 PRD 与 13 张 tracer-bullet 票据 |
| [.scratch/agent-template-authoring/](.scratch/agent-template-authoring/README.md) | 第三阶段 PRD（Agent 代建模板的本地闭环，v0.3）与票据，含外围工具复核与同图复跑后续的票据 16–38 |
| [.scratch/dsl-graphic-capabilities/](.scratch/dsl-graphic-capabilities/README.md) | DSL 1.x 平面设计能力的规格与 7 张票据 |
| [.scratch/render-service-v1/](.scratch/render-service-v1/README.md) | 第四阶段 PRD（出图服务第一版）与 15 张票据 |
| [.scratch/agent-harness-hardening/](.scratch/agent-harness-hardening/README.md) | Agent 可靠执行与可信验收 PRD 与 26 张票据，含公交留出材料与核准记录 |
| [.scratch/template-design-eval/](.scratch/template-design-eval/README.md) | 模板设计评估集的规格与 5 张票据 |
| [.scratch/authoring-api-and-pages/](.scratch/authoring-api-and-pages/README.md) | 阶段 5.0 P1 PRD（代建接口与人类页面）与 13 张票据 |

## 关键决定摘要

- **数据**：数据定义可修改，发布为不可变的静态数据定义（名称加自增版本号）；数据集与模板都依赖确切版本，渲染时必须一致（ADR-0008）。以编译出的 JSON Schema 为数据集校验权威（ADR-0006）。数据集自成一体，不设跨数据集共享实体（ADR-0010）。
- **模板**：模板是出图函数，所有模板地位平等，沿数据定义引用组合为子模板与循环模板，作用域不继承（ADR-0007）。模板变量分数据字段、模板参数（对外、内部）、派生变量；派生变量是单步运算按名组合，不引入文本表达式（ADR-0004）。模板没有版本，可直接修改与升级基准版本。
- **呈现**：画板以毫米为单位并声明适用尺寸范围；13 种元素；一块线路牌上站名字号一致，默认 10 mm；站数增加先收窄列间留白，列内不足才统一缩字，最小可读字号 5 mm；长站名仅沿竖排方向压缩字形（最低 60%）。366 参考图的 59 列已验证，见 M135–M136。
- **引擎**：TypeScript（Node 22），不依赖框架；ajv 校验、CanvasKit 合成、resvg WASM 栅格化 SVG、自研布局（ADR-0011、ADR-0012）。资源清单先写内容、后提交清单（ADR-0014）；出图记录自成一体，可脱离工作区重放（ADR-0013）。
- **服务**：渲染在 worker 进程里隔离，带单项超时与内存上限（ADR-0017）；租户共享库、行级安全隔离，存储经接口抽象（ADR-0018）；出图记录按内容哈希存进对象存储，仍自足可重放（ADR-0019）；按自然月额度计出图张数与 token，批量交付先预占（ADR-0020）。开放 API 1.x 只做加法（M246）。
- **Agent**：工具提供读取、校验、草稿预览与识别（ADR-0001、ADR-0003）；Agent 与人类共用一套代建写入，缺省直发，租户可要求发布前批准，风险靠不可变版本、修订、审计与回退控制（ADR-0022，修订了只读 MCP 与"写入只经提案"的旧边界）；有严重问题的成果不能批准或应用（ADR-0021）。产品中的业务 Agent 由服务端进程内的 Tool Runner 驱动，不依赖 Claude Code（M340，ADR-0027，取代 ADR-0015 的执行方式）；本机 `agent run` 在过渡期仍缺省以受限模式的 Claude Code 无头运行，只连 MCP 服务。OCR 用阿里云百炼 Qwen-OCR，固定带日期的模型版本。
- **界面与终端**：网页与桌面是同一份控制台页面，桌面端是 Electron 薄壳，Agent 循环与正式出图只在服务端（M341）；每页左栏的模块上下文对话第一版只读（M342）；不做自由拖拽画布（M205）。

## 开发

```bash
npm ci
npm run fetch-fonts     # 下载并核对思源黑体；npm test 之前也会自动执行
npm run build
npm test
npm run typecheck
npm run render -- render --workspace fixtures/workspaces/single-text --resources fixtures/resources --request fixtures/workspaces/single-text/render-request-greeting.json --out out
npm run render -- publish --definition <数据定义.json> --workspace <工作区目录> --out <输出目录>

# 出图服务（service/ 是单独的 npm 包，npm test 之前会自动装它的依赖）
npm run typecheck:service                 # 服务与控制台的类型检查
npx vitest run --project service          # 服务的快速测试（内存后端）
node service/scripts/up.mjs               # 本机 Docker Compose 起整套服务
node service/scripts/test-docker.mjs      # PostgreSQL 加 S3 的 Docker 后端测试，含控制台浏览器用例
```

- 开发票据在 `git worktree add` 出来的独立工作区里做：主检出常有 Agent 评估在跑，评估固定 `dist/`、`package-lock.json` 与评估脚本的字节（[开发环境与接续](docs/dev-setup.md)「已知的坑」）。
- 引擎组里 `agent-*` 的重型集成用例在全并行时容易超时或抢 `fixtures/resources` 的写锁（`local.storeBusy`）；全量跑时减少 worker（`--maxWorkers=4`）或逐文件串行（`--no-file-parallelism`）。

- 字体由 `scripts/fetch-fonts.mjs` 按 `scripts/fonts.json` 下载到 `fixtures/resources/fonts/`（不进版本库）。图片夹具由 `scripts/make-image-fixtures.ts` 生成并提交，来源见 `fixtures/resources/images/README.md`。
- 各票据的验收脚本是 `scripts/accept-*.mjs`，成果写到 `out/`（不进版本库）。快照与 golden 的更新方法见 [CODING_STANDARDS.md](CODING_STANDARDS.md)。
- 真实运行 Agent 之后、提交之前，用 `node scripts/scan-keys.mjs <轮次目录> docs src scripts test` 确认产物中没有 key（A05）。Linux 全量测试与评估门槛的做法见[开发环境与接续](docs/dev-setup.md)。

## 尚待实测

- OCR 首选模型：用线路牌样图对比 qwen3.5-ocr 与 qwen-vl-ocr-2025-11-20。
- Agent 的推广：线路牌（M402、366）与超市商品价签已测；资产标识卡、地铁导乘图、诊室门牌、物流面单、候车信息屏、危化品库位卡、杯贴、登机牌已写约定包并进了模板设计评估集，模板辅助设计已在 main 的 Agent 上用 Haiku 5.5 跑过（11/12；06 地铁导乘图补约定后重跑达线）；这些领域的数据定义提取还没测。
- 真人代建用时（A11）：第三阶段的端到端代建由 Claude 代操作，真人审核与写说明要花多久还没测。

## 外部来源

四个外部项目的源码快照（2026-10-12，对应主仓库 58fc181）放在 `outside_context/`，不进版本库，默认搜索也不覆盖，查阅时要把路径写明。其他设备上由维护者自行拷贝交接包并解压到仓库根的 `outside_context/`；没有它时，只是涉及旧实现的事实无法核对，其余工作不受影响。旧文档引用的是历史绝对路径，把前缀换成快照目录即可找到。各项目的来源提交、脱敏文件清单与逐文件 SHA-256 见 `outside_context/manifest.json`。

| 来源 | 快照目录 | 历史路径前缀 | 用途 |
|---|---|---|---|
| 旧 RenderWeave 草稿项目 | `outside_context/legacy-renderweave/` | `D:\Yiwer\code\RenderWeave` | 概念参照，全部重写 |
| rid-rs 模板模块 | `outside_context/rid-rs/` | `E:\MiLu\code\route-info-board\rid-rs` | 线路牌业务与数据源设计的来源 |
| design-layout-draw | `outside_context/design-layout-draw/` | `D:\Yiwer\code\design-layout-draw` | 布局引擎、渲染器、编辑器参照 |
| CloudKiln | `outside_context/CloudKiln/` | `F:\GenCode\CloudKiln` | 原定 Agent 执行环境，已不可用（M189），仅作参照 |
