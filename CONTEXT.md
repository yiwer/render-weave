# RenderWeave 项目上下文

接续工作的入口：当前阶段、下一步、已实现能力与文档地图。本文只放结论和指针。换设备或首次接手时，先照[开发环境与接续](docs/dev-setup.md)准备软件、key 与不进版本库的材料。票据状态以票据文件的 `**Status:**` 行为准；验收细节、测试数量与提交记录分别在票据 `## Answer`、对应的 `docs/*.md` 和 git log 里。

## 一句话

RenderWeave 围绕数据定义、模板与数据集出图：先设计数据结构及其出图方式，再用符合定义的数据批量生成 PNG/JPG。首个业务场景是公交线路牌。核心目的（M189）：用户在系统中给出示例图，业务 Agent 辅助完成数据定义与数据集设计，再完成模板设计；Agent 经只读工具使用校验、预览与识别能力，成果经人审核后应用。产品方向（M204–M207，见[产品路线图](docs/roadmap.md)）：对外 SaaS，Agent 是做模板的主入口，网页是看、改与出图的主界面；v1.0 出图服务化、模板由内部团队用 Agent 代建；交互参考 Claude Design（对话加画布、评论定位、实时旋钮），视觉为暖色中性风格（M208）。

## 当前阶段与下一步

- 需求探索与业务实体建模已完成。决定逐条记为 M 编号（[需求探索记录](docs/discovery/requirements.md)），难以逆转的写成 [ADR](docs/adr/)。
- 首期 [渲染流水线](.scratch/render-pipeline/spec.md)：14 张票据全部 resolved，M402 能从数据集校验一路出到 PNG。收尾审查见 [阶段验收](docs/stage1-acceptance.md)，参考图差异见 [M402 验收记录](docs/examples/m402-acceptance.md)。
- 第二阶段 [本地生产出图 PRD](.scratch/local-production-output/spec.md)：13 张票据全部 resolved。Windows/Linux 全新环境复跑、跨平台比对与两轴审查见 [第二阶段验收](docs/stage2-acceptance.md)，首次使用见[使用指南](docs/guide.md)。
- 产品路线图见 [docs/roadmap.md](docs/roadmap.md)：阶段 3 Agent 可行性 → 阶段 4 SaaS 第一版（v1.0）→ 阶段 5 客户自助做模板。
- 第三阶段 [Agent 代建模板的本地闭环 PRD](.scratch/agent-template-authoring/spec.md)（v0.3）：DSL 1.0 与 JSON Schema、`renderweave mcp` 只读工具、`renderweave agent` 任务闭环（提取、审核、应用、多轮、模板修改）、三层资料与评估门槛；9 张票据见[索引](.scratch/agent-template-authoring/README.md)。依据是 Agent 运行方式验证（[验证记录](docs/agent-validation.md)，M209–M217，ADR-0015）。
- **第三阶段 15 张票据全部完成，阶段验收通过**（[第三阶段验收](docs/stage3-acceptance.md)，M231、M235）：
  - DSL 1.0 与 JSON Schema（M223、M224）；
  - `renderweave mcp` 只读工具（M225）；
  - `renderweave agent` 的提取、审核、应用、多轮与模板修改（M226–M229）；
  - 三层资料与评估门槛（M230）；
  - 价签与 366 两张新示例图按[代建指南](docs/agent-guide.md)走完全流程，代建模式可行；A11 由用户本人用 M162 竖版线路牌补测，人工约 30 分钟，到正式出图为止；
  - 验收后补了交回前核对成果的只读工具 `check_outcome`（票据 10，M233），并让 `view_image` 能看资源仓库中的图片（`res:资源ID`，票据 11，M234）；MCP 合同 0.5.0。
  - 真人走查之后补了纵向循环（票据 12，M236）：`itemLayout.direction: "column"` 与 `heights`，竖排列表不再靠旋转 90°。这是 DSL 1.x 的第一笔加法。
  - 修了网格中元素静默重叠的三种情形（票据 13，M237），ADR-0016 补了布局缺陷修正的口径。
  - 模板在画板上声明缩字下限（票据 14，M238），价签一类小标签可以缩到 5 mm 以下。
  - 资源命令遇到还不是版本仓库的目录时，提示先 `resources-init` 或从旧目录导入（票据 15，M239）。
- **DSL 1.x 平面设计能力演进（P1/P2）**（[规格](.scratch/dsl-graphic-capabilities/spec.md)，[索引](.scratch/dsl-graphic-capabilities/README.md)）：7 张票据全部完成（M251–M257），已变基到阶段 4 之上、跑通全量测试（M249），并在更新后的 `agent/reference/template.md` 上复跑通过 Haiku 5.5 评估门槛（[2026-10-19-dsl-graphic-capabilities](docs/agent-eval/reports/2026-10-19-dsl-graphic-capabilities.json)，A08）：
  - 票据 01（M251）：派生变量支持 `multiply`、`divide`、`mod`、`splitPart`（含 `format` 格式化后拆字）与 `branch` 条件中的 `all` / `any` 复合条件。
  - 票据 02（M252）：循环容器支持 `reverse`（反序）、`slice`（1-based 闭区间切片）与纵向循环 `mergeBy` / `spanBy: "groupSize"`（`heights: "equal"`）。
  - 票据 03（M253）：堆叠布局与循环容器 `itemLayout` 支持 `wrap` 自动流式换行与交叉方向行/列间距 `crossGap`（含交叉方向 `"hug"` 自适应撑高/撑宽）。
  - 票据 04（M254）：矢量图形（`path`、`polygon`、`line`）支持可选 `viewBox` 与 `fit`（`fill` / `contain` / `cover`）随元素框缩放，通过变换路径几何顶点保持描边宽度与虚线不变形。
  - 票据 05（M255）：文本支持常态字间距 `letterSpacing`（正负毫米数或数值变量）与横排 `fit.steps` 中的 `"tightenSpacing"`（在压缩字形前先将正字距线性收紧至 0）。
  - 票据 06（M256）：竖排文本的文本片段与变量插槽支持独立设置 `font` 与 `fontSize`（缩字组按比例同步缩放各片段字号），且竖排常见方向性标点自动绕字格中心顺时针旋转 90°。
  - 票据 07（M257）：图片元素支持可选 `tint` 单色重染（`#RRGGBB`、`#RRGGBBAA` 或颜色变量，支持状态样式覆盖），以 `srcIn` 滤镜替换像素 RGB 并保留原图透明度。
- **第四阶段 15 张票据全部完成，阶段验收通过**（[第四阶段验收](docs/stage4-acceptance.md)，M302–M304）：出图服务第一版在本机 Docker Compose 上从空环境走完 PRD 的完成标准；真人走查从登录到导出记录，动手约 5 分半钟；容量基线是每个 worker 1 个 CPU、2 GB 内存、单项超时 60 秒，M402 线路牌每个 worker 每分钟约 60 张，按物理核数起 worker；OpenAPI 1.0.0 基线定稿。开工前的 ADR：ADR-0017–0020（服务形态与渲染隔离、租户与存储抽象、对象存储中的出图记录、计量与额度，M243）；阶段 4 PRD 见 [出图服务第一版](.scratch/render-service-v1/spec.md)（M244–M249），15 张票据见[索引](.scratch/render-service-v1/README.md)。票据 01（存储接口，M250）、02（批量交付的问题清单与单次渲染对齐，M258）、03（服务骨架，M259、M260）、04（租户、账号与鉴权，M261–M263）、05（代建推送，M264、M265）、06（渲染 worker 与草稿预览，M266、M267）、07（批量正式交付，M268、M269）、10（数据集与资源接口，M270、M271）、08（出图记录的查询、导出与重放，M272、M273）、09（计量与额度，M274、M275）、11（API 合同与 webhook，M276、M277）、12（出图控制台的表单、预览与交付，M278–M282）、13（Excel 导入，M283–M286）、14（控制台的记录、用量、资源与管理，M300、M301）与 15（容量基线与阶段验收，M302–M304）已完成；控制台的结构先做了一轮原型，用户选定方案一（以数据集为中心），原型存档在分支 `prototype/console-v1`。阶段 5 的前置决定已定（[ADR-0022](docs/adr/0022-agent-human-capability-parity.md)、M297–M299）：人类页面与 Agent 同能力写入，Agent 可从示例图或数据集提取数据定义并直接发布；按 5.0、5.1 拆票。部署、字体与计费由用户定下（M240–M242），开发时在本机 Docker 上模拟，对象存储用 S3 协议。第三阶段的后续都已了结；M402 数据定义的评分余量（资料相同的 16 次里 14 次达线）按用户决定不再跟进，资料没变时门槛再因它没过才重新处理（[第三阶段验收](docs/stage3-acceptance.md#后续)）。

  模型改用 OpenCode Go（M232）：缺省 Claude Haiku 5.5，质量要求高的单子用 Gemini 4 Argon；千问不再使用。Haiku 已在合同 0.7.0 与票据 17 的修改任务提示词上通过四场景评估门槛（2026-10-20-ticket17 的三份报告，见 [Agent 评估](docs/agent-eval.md)），Gemini 已在合同 0.5.0 与票据 14 的 Agent 参考上过评估门槛（[Agent 评估](docs/agent-eval.md)）。key 只有 `OPEN_CODE_API_KEY` 一个，只经环境变量传入，由维护者在各设备上自行设置，不进仓库。
- **Agent 外围工具复核（2026-10-19）**：首轮只读复核开了票据 16–21（[外围工具复核](docs/agent-tooling-review.md)）；同日的[二次复核与实测](docs/agent-tooling-evaluation.md)改了排序与方案，新开 22–24。
  - 已完成：票据 16（`agent run` 按任务校验 `--definition`/`--dataset`）、21（评估区分上游瞬时错误与模型失败）、19 与 22（合同 0.6.0：看图缺省最多 2 倍，工具输出不超过 40,000 字符）、23（推理力度 `--effort`，缺省不改，M291）与 30（提取类单独用 low 也不改：数据定义提取输出降约四成，数据集提取几乎不降，两个提取场景合计只降 24.8%，没到 30%）。
  - 票据 18 的判据会误伤被调模板，已改写。
  - 票据 24 已完成：模板辅助修改加入评估，票据 17 的改前基线已存档（M292）。
  - 票据 17 已完成：`check_outcome` 返回模板修改的差异范围，修改任务在交回前按差异核对范围；合同 0.7.0（M293）。
  - 还没做：18、20（原计划与 19、22 同批，以后另升合同版本、另跑评估）。阶段 4 的票据顺序不变，这些排在阶段 4 票据的间隙。
- **阿拉伯文站牌试跑（2026-10-20）**：用一张阿拉伯文公交站牌走完四步（Haiku 做数据定义与数据集，Gemini 做模板），正式出图 0 问题，但阿拉伯文不连写、顺序颠倒：引擎逐字从左往右排，不做塑形与双向排版。用户决定阿拉伯文属于特殊需求，暂不做排版。由此做了：
  - 票据 26：这类文字报严重问题 `text.unshapedScript`（M288），不再静默画错；
  - 票据 27：资料补领域约定的适用条件、必填判断、模板分段写法、不按数据取值写分支、文字能力边界、尽早交回成果；不加 MCP 写工具（M290）；
  - 票据 28：`agent run` 先校验出图请求再打印"开始"，用满轮数时说明原因；
  - 票据 29：`list_resources` 给字体的字重与覆盖的文字。
  - **同图复跑（2026-10-20–21）**：[复跑报告](docs/agent-arabic-retest.md)。后续见[票据 31–38](.scratch/agent-template-authoring/README.md#同图复跑后续2026-10-21按执行优先级)。成果评估、受阻草稿与硬额度停止沿用 M294–M296、ADR-0021。2026-10-22 复核远端 33、34 后，按用户批准的 M306 实施可信参考、多维局部反馈与普通轮次来源留存；原错误关闭记录已更正，当前能力及未覆盖边界见[复核报告](docs/agent-33-34-review.md)与[视觉反馈](docs/agent-visual-feedback.md)。原图已补 86 区域独立标注，并完成中文受控样例的真实模型纠偏（[实测](docs/agent-visual-live-acceptance.md)）。合同 0.10.1 补齐区域分页与总输出预算，并已完成同一中文样例的独立真实模型纠偏；用户现已要求聚焦中文、英文（M307），阿文新模板试跑已停止，已有结果只保留为历史诊断。下一步按 38 收齐新版四场景门槛，再补英文真实模型纠偏和中文、英文独立样式/状态审核；中文两次真实纠偏与双语受控验证见[提交结果](docs/agent-visual-feedback-results.md)。两版门槛分别固定构建，未完成项不计通过。
- **Gemini 长调用（2026-10-20）**：用 Gemini 4 Argon 实跑阿拉伯文站牌时，模板轮 5 次在约 300 秒处失败，根因是转换代理自己用的全局 fetch 有固定 300 秒超时。票据 25 已完成（M287）：代理改走流式 `streamGenerateContent`、连上游改用 `node:http(s)`，失败日志分连接、状态码、流中三个阶段并带底层原因。Gemini 评估门槛没有重跑，按 M232 的先例用真实模型跑一轮数据定义提取核对链路，下一次 Gemini 评估一并覆盖。
- **Agent harness 实施（2026-10-23）**：[可靠执行与可信验收 PRD](.scratch/agent-harness-hardening/spec.md)及 [26 张实施票](.scratch/agent-harness-hardening/README.md)已获用户批准实施，集成分支为 `codex/agent-harness-hardening`，规格基线 `40d14f1`。01–20 已合入：有序转录评分、模板业务行为、固定审核资源、并发提交与崩溃恢复、实验身份、不可覆盖尝试及完整成本、持久轮次状态、完整检查点、有限可见性及可信反馈校准；10 运行时限、15 订单成本与人工投入、16 信任边界均已完成集成；17 按需资料候选已合入，默认仍为全量资料；12 有证据的停滞控制已合入；18 的32次真实配对已完成，按需资料输入加缓存仅下降9.07%且质量守卫未全部通过，保留 full 默认；19 的十二例材料、36订单/96阶段计划与独立审核程序已获用户具体核准，后续实际成果仍需独立审核。决定见 M308–M326、M328、ADR-0023/0024/0025，研究依据见[工程评估](docs/research/2026-10-23-agent-dsl-harness-review.md)。20 已冻结持久候选2（72a5e749…b949f），原四场景与21分别绑定同一候选，验收证据见 docs/agent-eval/harness-acceptance-candidate.md，21 与原 38 承接各自真实模型证据，再做公交四类型留出与真人走查（v1.1、M317，用户已提供12张候选素材）。原 38 保留既有责任与共享观测唯一派发分工；新增能力是否已完成以各票据的验收记录为准。留出案例须登记真实模板家族、操作者核准和独立审核；同族多例不增加独立家族数，已知校准家族只作回归。
- **本轮验收进度**：用户已授权具体模型端点（M329）；21已完成固定候选2的16次真实观测，10通过、6次分页时序有效失败，原件与归档恢复证据已保全，门槛未通过。下一步先修通用反馈接续顺序，再冻结新候选并登记原四8次、21全部16次重验；不得覆盖旧失败，详见[完整结果](docs/agent-eval/trusted-feedback-acceptance/RESULTS.md)。原38首段4次达线、5个实际阶段已完成来源核对与归档恢复；因候选2需修订，第二段4次未派发，整体仍未完成。混合站牌负面评价保留并停止继续还原，中文首轮正式审核材料已准备、人工结论仍待记录，详见[原38进度](.scratch/agent-template-authoring/issues/38-retest-after-quota-recovery.md)。
- **下一步**：阶段 5（客户自助做模板）按 5.0、5.1 拆票（[路线图](docs/roadmap.md)，ADR-0022、M297–M299）。阶段 4 验收留下的后续见[第四阶段验收](docs/stage4-acceptance.md#后续)，其中整批导出包按项展开字体（千项 M402 约 33 GB）要先定取舍。
- [第二阶段验收](docs/stage2-acceptance.md#接入服务前必须补的验证)列的接入服务前必须补的验证（资源隔离、执行隔离、容量、存储替代）已在阶段 4 落实；不受信任的记录按 PRD 不接收。

## 已实现能力

- **可信反馈校准**：公开准备与评估计划入口提供中文/英文四任务共 8 场景、16 单元，可信基准随任务固定；目标修正、非目标保留及未知范围独立判断，待确认值使用审核有效候选，最后工具检查与宿主终检核对身份。24 区域样例含第二页必须处理的缺陷，兼容来源须核对完整实验与轮次身份；机制通过不计真实模型观测；该能力首发 MCP 合同 0.13.1，当前版本随集成升版。入口与边界见 [反馈校准](docs/agent-feedback-calibration.md)。

领域模型文档含未来设计，当前可执行的能力以本节为准。

- **DSL 1.0**：数据定义、数据集、模板、渲染请求与批次请求都有人读参考（[docs/dsl/](docs/dsl/README.md)）、JSON Schema（`schemas/`）与一致性测试，兼容策略见 ADR-0016；公开入口 `checkDslDocument`、`dslDocumentKind` 识别并检查单份文档。Agent 参考在 `agent/reference/`。
- **入口**：渲染入口 `render(workspace, request)` 返回图片、问题清单与布局摘要，这是主接缝；发布静态数据定义是次接缝。CLI `renderweave render` / `publish` 把成果写到输出目录，用法见 [README](README.md)。
- **数据**：数据定义发布为静态数据定义，并编译出 JSON Schema；数据集按全部字段类型与约束校验。
- **元素与布局**：画板与容器（自由、堆叠及 `wrap`/`crossGap` 自动流式换行、网格，M253）；横排与竖排文本（横竖排片段独立字体与字号、插槽展示格式、常态字间距 `letterSpacing`、横排倾斜、文字描边、竖排方向性标点顺时针旋转 90°，M255、M256）；PNG/JPEG/WebP/SVG 图片（三种适配、可选 `tint` 单色重染，M257，SVG 见 [SVG 说明](docs/render-svg.md)）；矩形、椭圆、线条、多边形、路径（线条、多边形、路径支持 `viewBox` 与 `fit` 随框缩放，M254）。
- **模板**：模板参数、派生变量（条件分支与 `all`/`any` 复合条件、取项、按分隔符拆取文本 `splitPart`、长度、加减乘除取模，M251）、检查项、绑定、条件显示、状态样式，出图前做静态检查；循环容器（横向或纵向排列，每项等分、随内容或固定尺寸，支持 `reverse` 反序、`slice` 区间切片与 `wrap`/`crossGap` 自动流式换行，M236、M252、M253）与子模板调用（独立作用域）。
- **线路牌适配**：横向或纵向合并相邻同值项与道路带（M252）；横排按墨迹分布，先收紧字距、再压缩字形、再缩字（M255）；竖排缩字组跨循环与子模板统一字号并按比例缩放片段字号（M256）。缩字下限由模板在画板上声明，缺省 5 mm，价签一类小标签可低到 1.5 mm（M238）。
- **字体与模式**：缺字逐字替代为思源黑体（[字体说明](docs/render-fonts.md)）；阿拉伯文、希伯来文、印度系文字等需要塑形或从右往左的文字报严重问题 `text.unshapedScript`（M288）；草稿显示占位与问题边框，正式模式有严重问题时不出图（[模式说明](docs/render-modes.md)）。
- **第二阶段已完成**：二维码（[说明](docs/render-qrcode.md)）、CODE128（[说明](docs/render-barcode.md)）、EAN/UPC（[说明](docs/render-retail-barcodes.md)）、资源内容版本的导入与替换（[说明](docs/resources-versioning.md)）、1–1,000 项的批量正式交付、批量草稿预览、逐项记录重放、项间取消与中断后辨认、同批素材硬链接去重、码图模板交付与重放（[说明](docs/output-records.md)，[带码线路牌样例](docs/examples/coded-route-sign/README.md)）。
- **MCP 只读工具服务**：`renderweave mcp` 提供 12 个只读工具：读取工作区快照与资源、校验数据定义/数据集/模板工作副本、草稿预览（工作副本、数据集文件、局部预览）、元素检查、局部放大（工作目录内的图片，或用 `res:资源ID` 看资源仓库中的图片，M234）、DSL 参考与交回前核对成果（`check_outcome`，M233）。工具合同 0.10.1 有快照测试：看图缺省最多 2 倍，文字结果不超过 40,000 字符（问题清单与元素检查有上限，大 Schema 返回目录、按 `pointer` 取一段），字体带字重与覆盖的文字（M289）；`check_outcome` 返回模板修改的状态、路径与属性键名，每候选最多 100 条、约 20,000 字符，截断给总数（M293），见 [MCP 工具服务](docs/mcp.md)。
- **业务 Agent 任务**：`renderweave agent run` 支持数据定义提取、数据集提取（`--definition`）、模板辅助设计（`--dataset`、`--request`）与模板辅助修改（`--requirement`，主模板调用树中的已保存模板预置为工作副本），带反馈的下一轮用 `--from`、`--feedback`，在独占轮次目录中组装三层资料与工作区快照，按 ADR-0015 在空白环境里启动 Claude Code，只连 `renderweave mcp`。Agent 交回前可用 `check_outcome` 按同一套规则自查；交回的成果先查结构、再经引擎校验，写出 `outcome.json`、`check.json` 与 `round.json`。`agent review` 在本机打开审核页：对照示例图、图上位置与 RenderWeave 重新渲染的草稿预览（M52；模板辅助修改另有修改前的预览与结构化差异），逐项处理待确认项、整体确认，结果存进 `review.json`，并列出轮次链；`agent apply` 只接受审核通过的轮次，工作区变化时列出差异并拒绝（`--overwrite` 覆盖，或带反馈重做），把数据定义发布为下一个版本，数据集与新模板保存为新文件，模板的工作副本替换已保存的模板。见 [业务 Agent 任务](docs/agent-tasks.md)，从示例图到出图与修改的整套操作见 [代建指南](docs/agent-guide.md)。模型缺省为 OpenCode Go 上的 Claude Haiku 5.5；选 Gemini 4 Argon 时 `agent run` 在本机起转换代理，Claude Code 只拿到本轮令牌（M232）。资料在 `agent/`，领域约定包有公交线路牌 `route-sign` 与超市商品价签 `price-tag`；审核页在 `web/`。
- **Agent 评估**：`npx tsx scripts/agent-eval/run.ts` 经产品路径跑 M402 数据定义、M402 模板、M402 模板辅助修改与 366 转录四个场景，按 M211–M217 的检查评分，每个场景连续两次达线门槛才通过；报告只存摘要，存档在 `docs/agent-eval/reports/`。升级 Claude Code、换模型、改资料、改工具合同后必须跑，不进 `npm test`；额度窗口装不下一整遍时可分段跑；上游 500 一类瞬时错误按轮次重试，额度窗口的 429 停止派发并打印续跑命令，结果作废的单元记 `invalid`，门槛可能是 `incomplete`（退出码 3）。模板辅助修改按版面、压测与已保存模板的修改范围评分，另记改动元素数（M292）。报告记思考 token、被转存的工具结果数与模板轮首次检查的问题数，`--effort` 透传给 `agent run`（M291）。Gemini 经 `agent run` 内置的转换代理评估。qwen3.8-max 与 OpenCode Go 上的 Claude Haiku 5.5、Gemini 4 Argon 门槛通过。见 [Agent 评估](docs/agent-eval.md)。
- **存储接口**：工作区文档、版本化资源仓库与出图记录都经接口读写，有本地与内存两种实现，同一组合同测试；批量交付拆成"固定"与"交付单项"两步，批次快照可序列化（[说明](docs/storage-interfaces.md)，ADR-0018，M250）。
- **出图服务骨架**：`service/` 单独成包，只经引擎的公开入口调用引擎。
  - `node service/scripts/up.mjs` 一条命令起 PostgreSQL、S3 兼容存储、接口进程与 worker；
  - 迁移按版本号执行、启动时检查，健康检查分存活与就绪，日志是结构化 JSON；
  - 工作区文档、资源仓库与出图记录有 PostgreSQL 加 S3 实现，与本地、内存实现跑同一组合同用例；
  - 租户、成员与五种身份的鉴权：会话、API 密钥与代建令牌只存哈希，权限按 M247 的矩阵；应用账号加行级安全、跨租户端点清单与审计（M261–M263）；
  - 代建推送：`renderweave push` 把本地工作区与资源版本仓库推送到客户的租户，先列差异，有冲突整体拒绝，没有冲突一次提交；令牌只经环境变量传入；模板记修订，`template-revisions` 可把当前修订指回旧修订（M264、M265）；
  - 渲染 worker 与草稿预览：PostgreSQL 任务队列，调度进程加渲染子进程，单项超时、容器内存上限与子进程换新；模板列表与查看，同步草稿预览，入队前用引擎的 `measureRender` 检查像素与展开规模，按租户限并发与频率（M266、M267）；数值按容量基线定：每个 worker 1 个 CPU、2 GB 内存、单项超时 60 秒、做满 500 项换新，并发数是 worker 个数 `RW_WORKERS`（M302）；
  - 批量正式交付：`POST /v1/batches` 固定批次、按项入队，worker 逐项交付出图记录、发布批次清单，可查进度、可取消（正在渲染的一项也能结束）、带幂等键重试；批次只由接受它的构建交付，worker 停止前做完已接受的项，中途退出的项过了租约由同构建重领（M268、M269）；
  - 数据集与资源接口：数据集的新建、读取、修改、复制、列出与只校验，按原始字节存，保存时由引擎的 `checkDataset` 校验，问题与渲染时相同；图片与字体资源的上传、列出与读回，替换先检查影响（引擎的 `resourceImpact`，与本地 `resources-check` 共用），再由管理员凭报告按预期版本应用，提交前在同一把锁里核对工作区指纹（M270、M271）；
  - 出图记录：按时间、模板与批次查询，下载单个文件与整批图片，按项或按批次导出（与本地 `deliver` 的成果逐字节相同，能用 `batch-read`、`record-read`、`replay` 离线核对），读取时逐文件核对哈希；重放按记录里的构建标识交给那个构建的 worker，worker 定期报到，没有那个构建的 worker 时拒绝；镜像按构建保留，Compose 的 `replay` 配置用旧镜像起 worker（M272、M273）；
  - 计量与额度：平台管理员设套餐（每月出图张数、单张最大像素、并发数）；提交批次在一个事务里锁当期计数行预占，额度不够整批拒绝（429 `quota.exceeded` 带剩余额度）；交付成功与登记同一事务计 1 张，失败与未执行退回预占，批次结束退回剩余；周期是 UTC+8 的自然月，不结转；接口进程定期对账，退回没人再交付的批次遗留的预占；`renderweave push --rounds` 把代建各轮的 token 记为用量事件，只记不拦；客户管理员与平台管理员查已用、预占、剩余与明细（M274、M275），合计操作员与 API 密钥也能查（M300）；
  - 开放 API 合同与 webhook：`GET /v1/openapi.json` 返回按路由生成的 OpenAPI 3.1 描述，快照在 `docs/api/openapi.json`，相对 1.0.0 基线只做加法；错误回答按类别映射状态，每个用例的回答都按描述核对；客户管理员与 API 密钥注册 webhook，批次结束时投递带 HMAC 签名与时间戳的事件，失败按指数退避重试，投递记录可查；签名密钥加密存放（[开放 API](docs/api.md)，M276、M277）；
  - 出图控制台：接口进程在 `/console/` 下提供 React 加 Vite 的网页，只调开放 API。客户的管理员与操作员以数据集为中心工作：按编译产物生成的表单填数据（九种字段类型，对象列表排成表格），边填边按服务端问题清单校验，草稿预览的问题叠加在图上；出图在侧栏里进行，能按一个整数参数的范围出多张、几份数据集一起出，逐项看进度、取消，下载单张与整批压缩包；模板只读，可调参预览。静态数据定义有只读端点（[出图服务](docs/service.md#出图控制台)，M278–M282）。另有出图记录（按日期、模板、批次查询，下载图片，按项或按批次导出）、资源（上传，管理员替换前看影响、确认后应用）、用量（合计两种角色都看，明细只给管理员，M300）与只给客户管理员的管理页（成员与角色、只显示一次的 API 密钥、webhook 与投递记录、审计日志，M301）；
  - Excel 导入：服务端解析 `.xlsx`（只用 MIT 的解压库，解开之前按登记的大小限量），一行一个渲染项，简单列表写在一格，引用列表另起一张表用关联值对应；答导入预览——逐行的数据集与问题（定位到工作表、行与列）和只含能提交的行的批量请求，确认后照常提交批次；按数据定义下载空白表；控制台在数据集页的侧栏里导入（[出图服务](docs/service.md#excel-导入)，M283–M286）；
  - 可观测与维护：worker 的就绪检查带队列积压、存活检查带渲染用时；接口进程队列不空时定期记一行积压，并删掉过了保留期的预览与重放任务行（M303）；
  - 验收与容量：`service/scripts/accept-stage4.mjs` 从空环境走完完成标准，`service/scripts/capacity.mjs` 测单项画像、千项长批次、多个 worker 与长期负载（M304）；
  - 开放 API 用例跑内存后端进 `npm test`，跑 PostgreSQL 加 S3 后端在 Docker 后端测试 `node service/scripts/test-docker.mjs`；控制台的浏览器用例在 Docker 后端测试里跑（[出图服务](docs/service.md)，M259–M286）。
- **成果与中断处理（M294、M295）**：MCP 合同 0.10.0 的 `check_outcome` 分开评估结构、候选、内容待审核及完整请求的实际渲染；已知能力受阻保留成果说明，严重问题继续阻止批准与应用。未交回有效 outcome 时，宿主另存带哈希的 `draft.json`，可查看但不能批准；`--from` 恢复候选。应用前在当前工作区重渲染。明确硬额度错误会封住 Google 代理后续请求并停止本轮执行器，记录 `run.stopped` 和续跑入口；直连仅在运行时明确报告同类错误时停止。普通限流与瞬时错误保持原处理。
- **参考比较（M306）**：`--reference` 固定人工核准区域、原图与画板尺寸；只读 `compare_reference` 返回真实内容的同尺度三联图、缺项/文字/字号/尺寸/位置/文字颜色差异及源模板/实例位置，和最终检查共用模块。报告绑定实际工作区、数据、资源字节、参考与构建。状态仅来自核准清单；最终遮挡、对比度、复杂变换及未标注部分保持未知，不输出整体分数。
- **提取覆盖核查（M306）**：`--content-baseline` 提供本次可信字段与数值事实，缺省为未核查；领域名、模型备注不能制造真值。明确严重不一致会阻止技术合格，pending 与预览使用同一有效候选但仍需审核；派生语义等未知项独立列出，总分为 null。
- **普通轮次来源留存**：与评估共用源码/资料清单生成逻辑，保存实际任务提示词、实际资料副本及哈希、工具合同、引擎标识与固定参考；下一轮检查参考字节再继承。复跑命令见[视觉反馈](docs/agent-visual-feedback.md)。
- **harness 已合入能力**：转录评分器 `/3` 按停靠位置核查站序、多报、重复及附属事实，评估配置 `/2` 明确独立真值与容错政策；`--behavior-policy` 从公开渲染入口离线核查六类反事实和修改范围，缺少事实继续未核查（[模板业务行为检查](docs/agent-template-behavior.md)）。MCP 合同已升至 **0.17.0**：审核使用私有固定资源与检查内容身份，相关资源改变使旧批准失效，`reopen` 重新固定资源并核准，覆盖选项不能绕过；历史缺身份记录须重审，损坏不覆盖原检查与预览证据（[Agent 任务](docs/agent-tasks.md)）。应用共享有序写锁并在提交前重核内容身份；读者取得完整工作区快照。评估冻结构建、资料、输入、资源实际字节、判据和运行参数，并对每个实际轮次封存。新轮次持久保留启动与执行状态，强退不会冒充完成；有限可见性核查支持透明、轴对齐裁剪、后绘制不透明矩形完全遮挡，其他情形保持未知。应用以持久提交意图和幂等回执恢复，操作系统拥有权与短锁避免并发恢复破坏新写入。评估每次派发保留独立尝试原件和兼容视图，重试与强退成本、未知用量、实际会话墙钟分别记录。受管 MCP 的完整检查由宿主固定字节后保存检查点，强退接续恢复完整集合，拥有权冲突和损坏副本明确拒绝。候选选择保留最新完整及有证据改善的较好候选；同核准依据下按完整问题、未知范围和核准改善比较，互有得失与不可比较明确区分，审核可看内容差异并按选择接续。可信反馈校准提供中英文四任务、16单元离线计划，固定核准事实和24区域参考，从真实公开入口核对后续页问题、目标修正、非目标保留及终检身份；机制结果不计真实模型观测。监督层可按整轮时限或取消终止本轮进程树并有界保存最后完整检查点；运行时限验收见票10。停滞只在核准必修问题经完整反馈和修复复测仍无进展、执行器继续修复时停止，正常确认、缺页与不足证据不计；阈值默认两周期，实际值进入轮次与实验身份，停止复用有界保存并可新轮次接续（[停滞控制](docs/agent-stagnation.md)）。订单入口固定业务范围，关联全部尝试、原始和人工修正质量、独立人工分钟及正式交付；单位成功订单成本纳入失败订单，未知不补零，分享只输出白名单摘要（[订单成本与人工投入](docs/agent-orders.md)）。Anthropic 与 Google 上游凭据留在宿主，执行器只持本轮代理令牌；已知凭据在进入响应、日志与诊断前脱敏，四类低可信来源的实际拒绝和正常交付分开验证，边界见 [本地信任边界](docs/agent-trust-boundary.md)。可显式选择 full/on-demand 资料策略，默认仍为 full；入口保留强制约束，七份公开参考与 Schema 由宿主固定字节。outcome_feedback 按同一检查身份完整续取问题、差异及未知范围，分页不重检，超长首响应保留状态、计数和续页入口；资料目录、合同与共享样例可自动核对，遗留指向问题继续归原20。候选机制与默认决策边界见[资料策略](docs/agent-context-policy.md)。已完成32次真实配对，输入加缓存下降9.07%，未达20%且质量守卫未全部通过，保留 full 默认；完整负结果、来源及归档恢复见[配对结果](docs/agent-eval/context-policy-trial/RESULTS.md)。本次校准不替代20冻结之后的模型与独立业务验收。共同待验候选已按实际源码、构建、审核页、资料、Schema及运行依赖实拷贝冻结，公开资料路径可定位；原四与可信反馈有独立计划绑定，派发前核对字节，新候选列出全部重验单元。人工审核链逐阶段固定实际工作区与上游应用凭据，保持人工review/apply边界。验证由双平台基线全量和明确责任修复回归组成，原失败保留；冻结不代表模型门槛或独立业务审核通过。
- **未实现**：URL 图片、动态模板、OCR 接入、在线编辑器；命令行没有跨批次去重（服务端按哈希去重）。

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
| [docs/dsl/](docs/dsl/README.md) | DSL 1.0 参考：五种文档的写法、Schema 与引擎的分工、Schema 之外的检查、已知限制 |
| [docs/mcp.md](docs/mcp.md) | `renderweave mcp`：启动、12 个只读工具、草稿预览与元素检查的输入、交回前核对、查看资源图片、路径限制、合同版本 |
| [docs/agent-guide.md](docs/agent-guide.md) | 代建指南：准备 key 与资料、写项目说明、发起各类任务、审核、应用、出图与修改，命令可以直接复制 |
| [docs/agent-tasks.md](docs/agent-tasks.md) | `renderweave agent run`、`review`、`apply`：四种任务的输入与工具、模板辅助修改、下一轮与轮次链、隔离、轮次目录、成果格式与校验、审核页、预览与 review.json、应用与冲突、退出码 |
| [agent/](agent/README.md) | 交给业务 Agent 的资料：通用做法 `guide.md`、领域约定 `domains/`（含模板）、项目说明模板 `briefs/`、任务提示词 `tasks/`、DSL 参考与成果格式 `reference/`；三层的优先级与归属规则见 `README.md` |
| [docs/agent-eval.md](docs/agent-eval.md) | Agent 评估：必须运行的时机、命令、场景与通过线、评分与校准、报告格式与历次结果；工具在 `scripts/agent-eval/`，报告在 `docs/agent-eval/reports/` |
| [web/](web/review.html) | `agent review` 的本地审核页（单个 HTML，由 `src/agent/review-server.ts` 提供） |
| [docs/agents/](docs/agents/) | 技能读取的 issue 记录方式、triage 标签与领域文档规则 |
| [.scratch/render-pipeline/](.scratch/render-pipeline/spec.md) | 首期规格与 14 张票据 |
| [.scratch/local-production-output/](.scratch/local-production-output/README.md) | 第二阶段 PRD 与 13 张 tracer-bullet 票据 |
| [.scratch/agent-template-authoring/](.scratch/agent-template-authoring/README.md) | 第三阶段 PRD（Agent 代建模板的本地闭环，v0.3）与 9 张票据 |

## 关键决定摘要

- **数据**：数据定义可修改，发布为不可变的静态数据定义（名称加自增版本号）；数据集与模板都依赖确切版本，渲染时必须一致（ADR-0008）。以编译出的 JSON Schema 为数据集校验权威（ADR-0006）。数据集自成一体，不设跨数据集共享实体（ADR-0010）。
- **模板**：模板是出图函数，所有模板地位平等，沿数据定义引用组合为子模板与循环模板，作用域不继承（ADR-0007）。模板变量分数据字段、模板参数（对外、内部）、派生变量；派生变量是单步运算按名组合，不引入文本表达式（ADR-0004）。模板没有版本，可直接修改与升级基准版本。
- **呈现**：画板以毫米为单位并声明适用尺寸范围；13 种元素；一块线路牌上站名字号一致，默认 10 mm；站数增加先收窄列间留白，列内不足才统一缩字，最小可读字号 5 mm；长站名仅沿竖排方向压缩字形（最低 60%）。366 参考图的 59 列已验证，见 M135–M136。
- **引擎**：TypeScript（Node 22），不依赖框架；ajv 校验、CanvasKit 合成、resvg WASM 栅格化 SVG、自研布局（ADR-0011、ADR-0012）。资源清单先写内容、后提交清单（ADR-0014）；出图记录自成一体，可脱离工作区重放（ADR-0013）。
- **Agent**：只读工具提供读取、校验、草稿预览、识别；成果经人审核应用（ADR-0001、ADR-0003）。业务 Agent 每轮是一次受限模式的 Claude Code 无头运行，经兼容端点调用 Qwen，只连只读 MCP 服务（ADR-0015，取代 CloudKiln 方案 ADR-0009）。OCR 用阿里云百炼 Qwen-OCR，固定带日期的模型版本。

## 开发

```bash
npm ci
npm run fetch-fonts     # 下载并核对思源黑体；npm test 之前也会自动执行
npm run build
npm test
npm run typecheck
npm run render -- render --workspace fixtures/workspaces/single-text --resources fixtures/resources --request fixtures/workspaces/single-text/render-request-greeting.json --out out
npm run render -- publish --definition <数据定义.json> --workspace <工作区目录> --out <输出目录>
```

- 字体由 `scripts/fetch-fonts.mjs` 按 `scripts/fonts.json` 下载到 `fixtures/resources/fonts/`（不进版本库）。图片夹具由 `scripts/make-image-fixtures.ts` 生成并提交，来源见 `fixtures/resources/images/README.md`。
- 各票据的验收脚本是 `scripts/accept-*.mjs`，成果写到 `out/`（不进版本库）。快照与 golden 的更新方法见 [CODING_STANDARDS.md](CODING_STANDARDS.md)。
- 真实运行 Agent 之后、提交之前，用 `node scripts/scan-keys.mjs <轮次目录> docs src scripts test` 确认产物中没有 key（A05）。Linux 全量测试与评估门槛的做法见[开发环境与接续](docs/dev-setup.md)。

## 尚待实测

- OCR 首选模型：用线路牌样图对比 qwen3.5-ocr 与 qwen-vl-ocr-2025-11-20。
- Agent 的推广：线路牌（M402、366）与超市商品价签已测；资产标签等其他领域要先写约定包再测。
- 真人代建用时（A11）：第三阶段的端到端代建由 Claude 代操作，真人审核与写说明要花多久还没测。

## 外部来源

四个外部项目的源码快照（2026-10-12，对应主仓库 58fc181）放在 `outside_context/`，不进版本库，默认搜索也不覆盖，查阅时要把路径写明。其他设备上由维护者自行拷贝交接包并解压到仓库根的 `outside_context/`；没有它时，只是涉及旧实现的事实无法核对，其余工作不受影响。旧文档引用的是历史绝对路径，把前缀换成快照目录即可找到。各项目的来源提交、脱敏文件清单与逐文件 SHA-256 见 `outside_context/manifest.json`。

| 来源 | 快照目录 | 历史路径前缀 | 用途 |
|---|---|---|---|
| 旧 RenderWeave 草稿项目 | `outside_context/legacy-renderweave/` | `D:\Yiwer\code\RenderWeave` | 概念参照，全部重写 |
| rid-rs 模板模块 | `outside_context/rid-rs/` | `E:\MiLu\code\route-info-board\rid-rs` | 线路牌业务与数据源设计的来源 |
| design-layout-draw | `outside_context/design-layout-draw/` | `D:\Yiwer\code\design-layout-draw` | 布局引擎、渲染器、编辑器参照 |
| CloudKiln | `outside_context/CloudKiln/` | `F:\GenCode\CloudKiln` | 原定 Agent 执行环境，已不可用（M189），仅作参照 |
