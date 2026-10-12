# RenderWeave 项目上下文

2026-10-12 工作快照。**需求探索与业务实体建模已完成，M402 DSL 草稿通过一致性检查；首期规格"渲染流水线"已拆成 14 张票据，票据 01（渲染骨架）、02（竖排站名）、03（数据把关）、04（布局与图形）、05（图片）、06（文字片段）、07（模板变量）、08（循环容器与子模板调用）、09（合并相邻同值项与道路带）、10（缩字组与密集站点适配）、11（缺字替代）、12（草稿预览与正式出图）与 13（SVG 图片）已完成：数据定义可以发布为静态数据定义并编译出 JSON Schema，数据集按全部字段类型与约束校验；容器的自由、堆叠、网格三种布局，横排与竖排文字（片段单独设样式、插槽展示格式、倾斜），五种图形，PNG、JPEG、WebP、SVG 图片的三种适配方式；模板参数、派生变量、检查项、绑定、条件显示与状态样式，出图前做模板静态检查。循环容器按等分、内容或固定宽度排列，子模板按独立作用域求值、按调用框重新排布。合并循环按原始站点列跨宽，横排按墨迹分布并先压缩再缩字，道路名采用两侧与字间等留白的同间隔分布。缩字组跨循环与子模板两轮统一字号，摘要标明所属组。M402 完整草稿直接渲染，35 个站点列、15 段道路、标识行、15 个班次时刻及顶栏底栏能正确出图。**

## 一句话

RenderWeave 围绕数据定义、模板与数据集出图：先设计数据结构及其出图方式，再用符合定义的数据批量生成 PNG/JPG。首个业务场景是公交线路牌。业务 Agent（在 CloudKiln 云沙箱中运行）负责数据定义提取、数据集提取、模板辅助设计与修改，经 RenderWeave 的只读 MCP 服务使用校验、预览与识别能力，成果经人审核后应用。

## 当前状态

- 需求访谈第 1–3 轮全部回答；建模讨论确定 M1–M104，实施中的决定从 M105 起（目前到 M145），逐条记录在 [需求探索记录](docs/discovery/requirements.md)。
- 已接受 ADR-0001–0004、ADR-0006–0012；ADR-0005 已被 ADR-0008 取代。
- 技术栈：TypeScript（Node 22），引擎不依赖框架；ajv 校验、CanvasKit 合成、resvg WASM 栅格化 SVG（字体全部显式加载）、自研布局（ADR-0011）。busbox-render-engine 只作算法参考。
- 首期规格 [渲染流水线](.scratch/render-pipeline/spec.md)（ready-for-agent）：先不接 agent，跑通 M402 从数据集校验到 PNG；主接缝为渲染入口，输出图片、问题清单与布局摘要；次接缝为发布静态数据定义。
- 以真实设计稿 [M402 线路牌](docs/examples/materials/m402-route-sign.jpg)（740 × 165 mm，120 DPI，35 站）核对了模型，并写出 [DSL 草稿](docs/examples/m402-dsl/README.md)：11 个 JSON 文件合法，M402 数据集按编译产物 JSON Schema 校验 0 错误，5 个模板的引用全部能对上。票据 09 已实际渲染 15 段道路带并与 35 个站点列逐段核对边界（`test/golden/m402-roads.png`）；票据 10 已实现缩字组，完整草稿直接出图 0 个问题；端到端验收仍在票据 14。
- 渲染引擎（`src/`）：TypeScript，不依赖框架；渲染入口 `render(workspace, request)` 返回图片、问题清单与布局摘要，命令行 `renderweave render` 把三者写到输出目录。目前支持画板与容器（自由、堆叠、网格布局，填充、描边、四角圆角、透明度、旋转、裁剪）、横排与竖排文本（片段可单独设字体、字号、颜色与倾斜，插槽按展示格式输出，含描边）、图片、矩形、椭圆、线条、多边形与路径；模板参数、派生变量（条件分支、取项、长度、加减）、检查项、绑定、条件显示与状态样式都已支持，出图前检查变量引用与类型；循环容器与子模板调用已支持，包含七种基本字段类型的单值包装、独立作用域、实例路径及调用图静态检查；合并相邻同值项、原始列跨宽、横排墨迹两端/同间隔分布与先压缩再缩字已支持；竖排缩字组跨循环与子模板两轮统一字号已支持；缺字按 OS/2 字重逐字替代为思源黑体，摘要保留原字体与实际字体，成功记提示、仍缺字记严重问题；独立检查汇总后判断能否展开；草稿显示缺值占位与问题边框，正式严重问题不出图，两种模式的问题清单一致；SVG 按实际尺寸和 DPI 栅格化，清理脚本与外部引用，只用资源字体；Windows/Linux 四份 PNG/JPEG 样例字节一致。剩余票据 14 为完整 M402 验收。
- 测试（`test/`）：vitest，16 个文件、330 个用例通过，以渲染入口为接缝；布局摘要做文件快照（`test/snapshots/`），图片与 golden 比对（`test/golden/`，失败时在 `test-output/golden/` 生成三联图）。

## 文档地图

| 文档 | 职责 |
|---|---|
| [AGENTS.md](AGENTS.md) | agent 工作方式与技能配置（`CLAUDE.md` 只是加载入口） |
| [GLOSSARY.md](GLOSSARY.md) | 领域术语表，唯一的术语事实源 |
| [docs/discovery/requirements.md](docs/discovery/requirements.md) | 需求访谈、已核查事实（旧系统、CloudKiln、Qwen-OCR）、M1–M145 逐条决定 |
| [docs/model/business-entities.md](docs/model/business-entities.md) | 业务实体、关系与规则，含两张关系图与 G 系列待定事项 |
| [docs/model/template-elements.md](docs/model/template-elements.md) | 13 种模板元素、共有属性、位置与尺寸、可绑定范围、排布与适配 |
| [docs/examples/route-sign.md](docs/examples/route-sign.md) | 线路牌走查：演示 A–D（同名站点、站数与长站名、素材不完整、辅助修改） |
| [docs/examples/m402-design-analysis.md](docs/examples/m402-design-analysis.md) | 真实设计稿对照模型 |
| [docs/examples/m402-dsl/](docs/examples/m402-dsl/README.md) | 数据定义 DSL、编译产物、数据集、模板 DSL、渲染请求草稿 |
| [docs/adr/](docs/adr/) | 难以逆转、需要解释的决定 |
| [docs/render-modes.md](docs/render-modes.md) | 检查顺序、阻止展开、草稿占位与问题边框 |
| [docs/render-svg.md](docs/render-svg.md) | SVG 资源、字体、加载边界与跨平台复现 |
| [docs/render-fonts.md](docs/render-fonts.md) | 字体加载、缺字替代、引擎后备字体配置与问题摘要 |
| [docs/agents/](docs/agents/) | 技能读取的 issue 记录方式与领域文档规则 |
| [.scratch/render-pipeline/](.scratch/render-pipeline/spec.md) | 首期规格与 14 张票据 |

## 关键决定摘要

- **数据**：数据定义可修改，发布为不可变的静态数据定义（名称加自增版本号）；数据集与模板都依赖确切版本，渲染时必须一致（ADR-0008）。以编译出的 JSON Schema 为数据集校验权威（ADR-0006）。数据集自成一体，不设跨数据集共享实体（ADR-0010）。
- **模板**：模板是出图函数，所有模板地位平等，沿数据定义引用组合为子模板与循环模板，作用域不继承（ADR-0007）。模板变量分数据字段、模板参数（对外、内部）、派生变量；派生变量是单步运算按名组合，不引入文本表达式（ADR-0004）。模板没有版本，可直接修改与升级基准版本。
- **呈现**：画板以毫米为单位并声明适用尺寸范围；13 种元素；一块线路牌上站名字号一致，默认 10 mm；站数增加先收窄列间留白，列内不足才统一缩字，最小可读字号 5 mm；长站名仅沿竖排方向压缩字形（最低 60%）。366 参考图的 59 列已验证，见 M135–M136。
- **Agent**：每轮一个 CloudKiln Task；只读 MCP 服务提供读取、校验、草稿预览、识别；成果以文件交回，经人审核应用（ADR-0001、ADR-0003、ADR-0009）。OCR 用阿里云百炼 Qwen-OCR，固定带日期的模型版本。

## 开发

```bash
npm install
npm test                # 先由准备脚本下载并核对思源黑体，再运行全部测试
npm run typecheck
npm run render -- render --workspace fixtures/workspaces/single-text --resources fixtures/resources --request fixtures/workspaces/single-text/render-request-greeting.json --out out
npm run render -- publish --definition <数据定义.json> --workspace <工作区目录> --out <输出目录>
```

- 字体由 `scripts/fetch-fonts.mjs` 按 `scripts/fonts.json` 下载到 `fixtures/resources/fonts/`（不进版本库）；图片夹具由 `scripts/make-image-fixtures.ts` 生成并提交，来源见 `fixtures/resources/images/README.md`；更新 golden 图片用 `UPDATE_GOLDEN=1 npm test`。
- CanvasKit 用 full 构建，默认构建不能编码 JPEG。

## 尚待实测

- OCR 首选模型：用线路牌样图对比 qwen3.5-ocr 与 qwen-vl-ocr-2025-11-20。
- CloudKiln 的执行模型能否看图。

## 外部来源

| 来源 | 路径 | 用途 |
|---|---|---|
| 旧 RenderWeave 草稿项目 | `D:\Yiwer\code\RenderWeave` | 概念参照，全部重写 |
| rid-rs 模板模块 | `E:\MiLu\code\route-info-board\rid-rs` | 线路牌业务与数据源设计的来源 |
| design-layout-draw | `D:\Yiwer\code\design-layout-draw` | 布局引擎、渲染器、编辑器参照 |
| CloudKiln | `F:\GenCode\CloudKiln` | Agent 任务执行环境 |

## 下一步

按依赖顺序实施 [渲染流水线票据](.scratch/render-pipeline/issues/)：01 渲染骨架、02 竖排站名、03 数据把关、04 布局、05 图片、06 文字片段、07 模板变量、08 循环容器与子模板调用、09 合并相邻同值项与道路带、10 缩字组、11 缺字替代、12 草稿/正式出图、13 SVG 图片已完成；接下来做 14 M402 端到端验收。之后接 MCP 服务与 CloudKiln。
