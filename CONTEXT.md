# RenderWeave 项目上下文

接续工作的入口：当前阶段、下一步、已实现能力与文档地图。本文只放结论和指针。票据状态以票据文件的 `**Status:**` 行为准；验收细节、测试数量与提交记录分别在票据 `## Answer`、对应的 `docs/*.md` 和 git log 里。

## 一句话

RenderWeave 围绕数据定义、模板与数据集出图：先设计数据结构及其出图方式，再用符合定义的数据批量生成 PNG/JPG。首个业务场景是公交线路牌。核心目的（M189）：用户在系统中给出示例图，业务 Agent 辅助完成数据定义与数据集设计，再完成模板设计；Agent 经只读工具使用校验、预览与识别能力，成果经人审核后应用。产品方向（M204–M207，见[产品路线图](docs/roadmap.md)）：对外 SaaS，Agent 是做模板的主入口，网页是看、改与出图的主界面；v1.0 出图服务化、模板由内部团队用 Agent 代建；交互参考 Claude Design（对话加画布、评论定位、实时旋钮），视觉为暖色中性风格（M208）。

## 当前阶段与下一步

- 需求探索与业务实体建模已完成。决定逐条记为 M 编号（[需求探索记录](docs/discovery/requirements.md)），难以逆转的写成 [ADR](docs/adr/)。
- 首期 [渲染流水线](.scratch/render-pipeline/spec.md)：14 张票据全部 resolved，M402 能从数据集校验一路出到 PNG。收尾审查见 [阶段验收](docs/stage1-acceptance.md)，参考图差异见 [M402 验收记录](docs/examples/m402-acceptance.md)。
- 第二阶段 [本地生产出图 PRD](.scratch/local-production-output/spec.md)：13 张票据全部 resolved。Windows/Linux 全新环境复跑、跨平台比对与两轴审查见 [第二阶段验收](docs/stage2-acceptance.md)，首次使用见[使用指南](docs/guide.md)。
- 产品路线图见 [docs/roadmap.md](docs/roadmap.md)：阶段 3 Agent 可行性 → 阶段 4 SaaS 第一版（v1.0）→ 阶段 5 客户自助做模板。
- 第三阶段 [Agent 代建模板的本地闭环 PRD](.scratch/agent-template-authoring/spec.md)（v0.3）：DSL 1.0 与 JSON Schema、`renderweave mcp` 只读工具、`renderweave agent` 任务闭环（提取、审核、应用、多轮、模板修改）、三层资料与评估门槛；9 张票据见[索引](.scratch/agent-template-authoring/README.md)。依据是 Agent 运行方式验证（[验证记录](docs/agent-validation.md)，M209–M217，ADR-0015）。
- **下一步**：第三阶段票据 01–04 已完成：
  - DSL 1.0 五种文档的参考、Schema、一致性测试与 ADR-0016；
  - `renderweave mcp` 只读工具服务（[说明](docs/mcp.md)，M225）；
  - `renderweave agent run` 发起数据定义提取并校验成果（[说明](docs/agent-tasks.md)，M226）。

  下一张是 05（审核数据定义候选并发布），之后为数据集与模板任务、多轮与评估。key 只经环境变量 `QWEN_TOKEN_PLAN_API_KEY`。审查转出的后续见 M203：批量项问题码与单次渲染对齐（Spec P2）。
- 接入服务前，须先补资源隔离、执行隔离与容量等验证，清单见[第二阶段验收](docs/stage2-acceptance.md#接入服务前必须补的验证)。

## 已实现能力

领域模型文档含未来设计，当前可执行的能力以本节为准。

- **DSL 1.0**：数据定义、数据集、模板、渲染请求与批次请求都有人读参考（[docs/dsl/](docs/dsl/README.md)）、JSON Schema（`schemas/`）与一致性测试，兼容策略见 ADR-0016；公开入口 `checkDslDocument`、`dslDocumentKind` 识别并检查单份文档。Agent 参考在 `agent/reference/`。
- **入口**：渲染入口 `render(workspace, request)` 返回图片、问题清单与布局摘要，这是主接缝；发布静态数据定义是次接缝。CLI `renderweave render` / `publish` 把成果写到输出目录，用法见 [README](README.md)。
- **数据**：数据定义发布为静态数据定义，并编译出 JSON Schema；数据集按全部字段类型与约束校验。
- **元素与布局**：画板与容器（自由、堆叠、网格）；横排与竖排文本（片段样式、插槽展示格式、倾斜、描边）；PNG/JPEG/WebP/SVG 图片（三种适配，SVG 见 [SVG 说明](docs/render-svg.md)）；矩形、椭圆、线条、多边形、路径。
- **模板**：模板参数、派生变量（条件分支、取项、长度、加减）、检查项、绑定、条件显示、状态样式，出图前做静态检查；循环容器（等分、内容、固定宽度）与子模板调用（独立作用域）。
- **线路牌适配**：合并相邻同值项与道路带；横排按墨迹分布，先压缩再缩字；竖排缩字组跨循环与子模板统一字号。
- **字体与模式**：缺字逐字替代为思源黑体（[字体说明](docs/render-fonts.md)）；草稿显示占位与问题边框，正式模式有严重问题时不出图（[模式说明](docs/render-modes.md)）。
- **第二阶段已完成**：二维码（[说明](docs/render-qrcode.md)）、CODE128（[说明](docs/render-barcode.md)）、EAN/UPC（[说明](docs/render-retail-barcodes.md)）、资源内容版本的导入与替换（[说明](docs/resources-versioning.md)）、1–1,000 项的批量正式交付、批量草稿预览、逐项记录重放、项间取消与中断后辨认、同批素材硬链接去重、码图模板交付与重放（[说明](docs/output-records.md)，[带码线路牌样例](docs/examples/coded-route-sign/README.md)）。
- **MCP 只读工具服务**：`renderweave mcp` 提供 10 个只读工具：读取工作区快照与资源、校验数据定义/数据集/模板工作副本、草稿预览（工作副本、数据集文件、局部预览）、元素检查、局部放大与 DSL 参考。工具合同 0.3.0 有快照测试，见 [MCP 工具服务](docs/mcp.md)。
- **业务 Agent 任务**：`renderweave agent run --task 数据定义提取` 在独占轮次目录中组装三层资料与工作区快照，按 ADR-0015 在空白环境里启动 Claude Code，只连 `renderweave mcp`。Agent 交回的成果先查结构、再经引擎校验，写出 `outcome.json`、`check.json` 与 `round.json`，见 [业务 Agent 任务](docs/agent-tasks.md)。资料在 `agent/`。
- **未实现**：URL 图片、跨批次去重、动态模板、HTTP 服务、审核页与应用、数据集提取与模板任务、多轮反馈、OCR 接入、在线编辑器。

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
| [docs/roadmap.md](docs/roadmap.md) | 产品定位、形态、v1.0 代建模式、阶段与稳定版本、待定的难逆转事项 |
| [docs/agent-validation.md](docs/agent-validation.md) | M190 Agent 运行方式验证与阶段 3 首测：看图、工具闭环、数据定义候选、领域约定复测、模板生成、模型取舍与复现 |
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
| [docs/dsl/](docs/dsl/README.md) | DSL 1.0 参考：五种文档的写法、Schema 与引擎的分工、Schema 之外的检查、已知限制 |
| [docs/mcp.md](docs/mcp.md) | `renderweave mcp`：启动、10 个只读工具、草稿预览与元素检查的输入、路径限制、合同版本 |
| [docs/agent-tasks.md](docs/agent-tasks.md) | `renderweave agent run`：选项、隔离、轮次目录、成果格式与校验、退出码 |
| [agent/](agent/guide.md) | 交给业务 Agent 的资料：通用做法 `guide.md`、领域约定 `domains/`、任务提示词 `tasks/`、DSL 参考与成果格式 `reference/`；项目说明模板与归属规则在票据 08 补齐 |
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
npm install
npm test                # 先由准备脚本下载并核对思源黑体，再运行全部测试
npm run typecheck
npm run render -- render --workspace fixtures/workspaces/single-text --resources fixtures/resources --request fixtures/workspaces/single-text/render-request-greeting.json --out out
npm run render -- publish --definition <数据定义.json> --workspace <工作区目录> --out <输出目录>
```

- 字体由 `scripts/fetch-fonts.mjs` 按 `scripts/fonts.json` 下载到 `fixtures/resources/fonts/`（不进版本库）。图片夹具由 `scripts/make-image-fixtures.ts` 生成并提交，来源见 `fixtures/resources/images/README.md`。
- 各票据的验收脚本是 `scripts/accept-*.mjs`，成果写到 `out/`（不进版本库）。快照与 golden 的更新方法见 [CODING_STANDARDS.md](CODING_STANDARDS.md)。

## 尚待实测

- OCR 首选模型：用线路牌样图对比 qwen3.5-ocr 与 qwen-vl-ocr-2025-11-20。
- Agent 的推广：只测了线路牌（M402、366）；其他领域需先写约定包。366 的模板生成未测（需先定数据集）。

## 外部来源

四个外部项目的源码快照（2026-10-12，对应主仓库 58fc181）放在 `outside_context/`，不进版本库，默认搜索也不覆盖，查阅时要把路径写明。旧文档引用的是历史绝对路径，把前缀换成快照目录即可找到。各项目的来源提交、脱敏文件清单与逐文件 SHA-256 见 `outside_context/manifest.json`。

| 来源 | 快照目录 | 历史路径前缀 | 用途 |
|---|---|---|---|
| 旧 RenderWeave 草稿项目 | `outside_context/legacy-renderweave/` | `D:\Yiwer\code\RenderWeave` | 概念参照，全部重写 |
| rid-rs 模板模块 | `outside_context/rid-rs/` | `E:\MiLu\code\route-info-board\rid-rs` | 线路牌业务与数据源设计的来源 |
| design-layout-draw | `outside_context/design-layout-draw/` | `D:\Yiwer\code\design-layout-draw` | 布局引擎、渲染器、编辑器参照 |
| CloudKiln | `outside_context/CloudKiln/` | `F:\GenCode\CloudKiln` | 原定 Agent 执行环境，已不可用（M189），仅作参照 |
