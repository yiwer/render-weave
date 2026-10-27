# RenderWeave 平台化：产品形态、架构与技术选型的一手资料研究

研究日期：2026-10-26。本文是外部依据与建议，不是已采纳决定；推荐项要经用户拍板、记成 M 编号或 ADR 之后才算数。本轮没有改代码，只在暂存目录做了一次本机渲染计时。

**判断：能用 Claude 的 SDK 去掉本地无头 Claude Code，推荐用 Messages API + Tool Runner（`@anthropic-ai/sdk` 的 `client.beta.messages.toolRunner`）在服务端自建 Agent 循环，工具全部由 RenderWeave 定义。不选 Claude Agent SDK 来做这件事：官方把它定义为运行 Claude Code 二进制的库，每个 agent session 起一个 `claude` 子进程（S1、S2），换上它只是不用另装 CLI，Claude Code 运行时还在。Managed Agents 暂不选：只接 Claude 4.5 及以后的模型和 Anthropic 的 key，不能用 ZDR，workspace 数据目前只存美国（S5、S6），与 M232 的 OpenCode/Gemini 路线、与大陆部署都冲突。切换条件：Tool Runner 执行器在同一套评估门槛（M230）上连续两次不达线、Claude Code 执行器达线，且差距能归到 Claude Code 自带的上下文管理时，退回 Agent SDK，按 ADR-0015 原计划每轮一个容器。**

平台形态上，收费主体仍是出图 API 加出图控制台，按正式交付张数计；同类产品都按成功生成的张数计、预览免费（S10–S13），与 ADR-0020 一致。Agent 工作台放在服务端，是 5.1 的上手工具，对客户用"Agent 额度"表达 token。桌面端不承载 Agent 循环；仓库里找不到桌面端的硬需求，v1.x 不做，真要做选 Electron，因为引擎要 Node 运行时（S26、S27）。架构按"单 VM + 托管 PostgreSQL + 托管对象存储 → 托管容器服务 → Kubernetes"演进。托管 Agent 只给领域工具、不给代码执行和通用文件工具，就不需要路线图设想的每轮独立容器（`docs/roadmap.md:39`），5.0/5.1 的基础设施因此能省掉一整层。对外上线前先补四件事：备份与恢复、登录限频、生产用的按量模型渠道（OpenCode Go 是单人包月、面向编码 Agent，S7）、交互预览延迟（服务端到端中位 1.2 秒，进程内 50 DPI 约 0.1 秒）。

## 范围与证据口径

仓库部分读了 `AGENTS.md`、`CONTEXT.md`、`GLOSSARY.md`、`docs/roadmap.md`、ADR-0015、0017–0025，`docs/discovery/requirements.md` 的 M204–M208、M232、M240–M247、M259–M267、M297–M304，`docs/service.md`、`docs/api.md`、`docs/stage4-acceptance.md`、`docs/agent-tasks.md`、`docs/agent-trust-boundary.md`，以及 `service/`、`src/agent/`、`src/mcp/` 的相关代码。仓库事实标 `路径:行号`，这些都是已有能力，不写成"待建设"。

外部部分只采信 2026-10-26 当天打开的官方文档、定价页、源码与法规原文；搜索结果只用来找页面。页面上看不到日期的写"未见日期"。价格和限额都可能改，以打开当天为准。引文只做概括。

本轮实测一次：用本机现有 `dist/` 构建（未重建，HEAD `92583af`，Node v24.21.0），进程内连续 8 次渲染 M402 单边线路牌（本站 5，草稿）。50 DPI 首次 187 ms、预热后中位 102 ms；120 DPI 首次 325 ms、中位 314 ms；0 问题。脚本在暂存目录，不进仓库。

措辞：**已验证**指读过代码、文档、官方页面或跑过；**推断**指据此推出、没有实测；**未知**指没查到。

## 一、Agent 运行时（主问题）

### S1. Claude Agent SDK 是"嵌入 Claude Code"的库，带品牌与登录限制

- **来源与日期**：[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)，未见日期。
- **来源主张**：官方对比表把 Agent SDK 写成 "A library that runs the Claude Code binary"，带 Claude Code 的内置工具、权限、sessions 与 hooks；Client SDK 才是直接调 API、自己写或用 Tool Runner 驱动循环；Managed Agents 由 Anthropic 托管循环。第三方产品未经批准不得提供 claude.ai 登录；对外不得称"Claude Code"或"Claude Code Agent"；使用受 Anthropic 商业条款约束。
- **适用边界**：这是产品定位页，不给性能数据。经第三方端点（OpenCode）调用时条款怎样适用，页面没写，**未知**。
- **仓库启发**：路线图已定"不以 Claude Code 的名义对外"（`docs/roadmap.md:35`），与品牌条款一致。用户要的是"不再依赖本地无头 Claude Code"，Agent SDK 只换掉启动方式，不换运行时。

### S2. Agent SDK 的托管模型：每个 session 一个子进程，状态在本地盘

- **来源与日期**：[Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting)，未见日期；选项表见 [TypeScript 参考](https://code.claude.com/docs/en/agent-sdk/typescript)，未见日期。
- **来源主张**：`query()` 起一个 `claude` CLI 子进程、经 stdio 通信；一个 session 对应一个子进程，转录、记忆文件和工作目录都在本地盘，换节点就丢，跨主机要配 `SessionStore`。SDK 捆绑与包版本固定的原生二进制。起步资源每个 agent 1 GiB 内存、5 GiB 磁盘、1 个 CPU；token 成本通常比容器成本高一个数量级以上。多租户共用容器时要逐项关掉设置加载、自动记忆，分开配置目录、工作目录和出站规则。没有顶层的 session 超时，只能靠 `maxTurns`；`maxBudgetUsd` 是客户端估算，可能超。模型调用可经 `ANTHROPIC_BASE_URL` 走注入凭据的代理。
- **适用边界**：这些是起步建议，不是本项目的实测；内存随 session 长度增长。
- **仓库启发**：现有执行方式就是这个模型的 CLI 版：`claude -p --output-format stream-json --restricted --tools … --strict-mcp-config --allowedTools mcp__rw --permission-mode acceptEdits --no-session-persistence`（`src/agent/run.ts:492`–`494`），模型经 `ANTHROPIC_BASE_URL` 指向本轮本机代理（`src/agent/run.ts:484`–`488`）。换成 Agent SDK，选项一一对应，迁移面最小（推断）；但多租户托管仍要每轮一个隔离单位，即 ADR-0015 列的四项未验证工作（`docs/adr/0015-agent-runs-as-headless-claude-code-via-read-only-mcp.md:19`–`24`）。

### S3. Agent SDK 能只留自定义工具，但"允许列表"不是"可用列表"

- **来源与日期**：[Custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)、[Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)，均未见日期。
- **来源主张**：`createSdkMcpServer` 在应用进程内跑 MCP 工具，工具可返回 base64 图片；`tools: []` 去掉全部内置工具，只剩 MCP 工具。`allowedTools` 只是免批准，不限制可用；要锁死用 `permissionMode: "dontAsk"` 或 `disallowedTools`。工具注解只是提示，不强制。
- **适用边界**：权限求值顺序随 Claude Code 版本变（页面列了多个版本门槛）。
- **仓库启发**：现有四种任务都开着 `Read,Write,Edit,Glob`（`src/agent/tasks.ts:30`、`36`、`42`、`49`）。Agent 用 `Write`/`Edit` 写候选与 `outcome.json`（`agent/reference/outcome.md:3`），用原生 `Read` 看示例图（`docs/agent-trust-boundary.md:21`）。不论选哪条路，都要先把这些通用文件动作换成领域工具，这一步是去掉沙箱需求的前提。

### S4. Tool Runner：循环在自己进程里，工具全由自己定义，端点可换

- **来源与日期**：[Tool runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner)，未见日期；[TypeScript SDK](https://platform.claude.com/docs/en/api/sdks/typescript)，未见日期；[helpers.md](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md) 与 [src/client.ts](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)（main 分支，2026-10-26 读取）。
- **来源主张**：Tool Runner 是 beta，TS 用 `client.beta.messages.toolRunner`，工具用 `betaZodTool`、`betaTool`（JSON Schema）或 Standard Schema 定义；工具结果可以是图片块；`max_iterations` 缺省不限；可流式，可逐条消息检查、中途接管。TS 的客户端压缩已弃用，改用服务端压缩（`context_management`），也有按需压缩的辅助方法。客户端 `baseURL` 缺省取 `ANTHROPIC_BASE_URL`（源码），可传自定义 `fetch`；缺省重试 2 次、超时 10 分钟；注册 OpenTelemetry 后每个请求出一个 span；浏览器里缺省禁用，以免暴露 key。
- **适用边界**：Tool Runner 不带 Claude Code 的系统提示、上下文管理、超长工具结果转存与自动提示缓存；这些要自己做。服务端压缩和 Anthropic 定义的工具类型（如文本编辑工具 `str_replace_based_edit_tool`，见[文本编辑工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)）经 OpenCode 兼容端点是否可用，**未知**。
- **仓库启发**：现有 13 个只读工具的 Schema 与处理器都在 `src/mcp/tools.ts`（807 行），协议层另在 `src/mcp/server.ts`（141 行，stdio JSON-RPC），可以原样包成 `betaTool`。`model-proxy.ts` 的 Anthropic⇄Google 转换可以改作自定义 `fetch`，不再起本机端口（推断）。

### S5. Managed Agents：Anthropic 托管循环，只接 Claude 模型

- **来源与日期**：[Overview](https://platform.claude.com/docs/en/managed-agents/overview)、[Define your agent](https://platform.claude.com/docs/en/managed-agents/agent-setup)、[Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)、[Reference](https://platform.claude.com/docs/en/managed-agents/reference)，均未见日期，beta 头 `managed-agents-2026-04-01`；[Pricing](https://platform.claude.com/docs/en/about-claude/pricing) 的 Managed Agents 一节，未见日期。
- **来源主张**：四个概念：agent、environment、session、events；状态在服务端持久，不能用 ZDR 与 HIPAA BAA。`model` 只接 Claude 4.5 及以后的模型。工具有内置 bash/文件/网页、远程 MCP（streamable HTTP 或隧道）与自定义工具（agent 发 `agent.custom_tool_use`，由应用回 `user.custom_tool_result`）。自托管沙箱只把工具执行搬到自己机器，工具输入输出仍经 Anthropic 控制面。计价是 token 加 0.08 美元每 session 运行小时；创建类接口每分钟 300 次、读取类 1,200 次。品牌限制同 S1。
- **适用边界**：beta，行为会调整；正式版时间**未知**。
- **仓库启发**：RenderWeave 的工具可以全部做成自定义工具，在我们的服务里执行，技术上走得通；卡住的是模型与数据：M232 的模型经 OpenCode（`docs/discovery/requirements.md:562`），Gemini 用不了；workspace 只在美国（S6）。

### S6. Claude API 的数据驻留：推理地区只有 us/global，存储只有 us

- **来源与日期**：[Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)，未见日期；[Pricing](https://platform.claude.com/docs/en/about-claude/pricing)，未见日期。
- **来源主张**：`inference_geo` 只有 `"us"` 与 `"global"`，`"us"` 加价 1.1 倍；workspace geo 目前只有 `"us"`，建后不能改。Claude Haiku 5.5 在提示不超过 10 万 token 时为输入 0.10、输出 0.50 美元每百万 token，超过时为 0.50 与 2.50。
- **适用边界**：只覆盖 Anthropic 第一方与其托管渠道；Bedrock、Google 托管渠道另有地区规则。
- **仓库启发**：直连 Anthropic 时，客户数据的存储与推理不能落在欧洲或中国；需要地区承诺的客户要走云厂商渠道或换模型（M232 已有"资料不能出境改用国内模型"的切换条件）。

### S7. OpenCode Go 是单人包月，不适合当多客户生产渠道

- **来源与日期**：[OpenCode Go](https://opencode.ai/docs/go/)，未见日期；[opencode.ai/docs/zen/](https://opencode.ai/docs/zen/)（打开后内容为 OpenCode Console 按量计费），未见日期。
- **来源主张**：Go 每月 10 美元（Go Plus 40 美元），按模型设美元额度，5 小时 20%、每周 50%；Go 上 Claude Haiku 5.5 每月 15 美元、Gemini 4 Argon 每月 30 美元。开了 Go 的 workspace 只能一个成员；服务面向 OpenCode 与其他编码 Agent，流量会被监控。Haiku 5.5 数据保留 30 天，Gemini 4 Argon 为 0 天；缺省允许地区为欧洲与美国。Console 按次扣预充额度，支持团队、成员与预算，Haiku 5.5 单价与 Anthropic 同为 0.10/0.50。
- **适用边界**：页面没写能否用于商用 SaaS 后端或转售，**未知**；需读完整服务条款。
- **仓库启发**：现在只有一个 `OPEN_CODE_API_KEY`（`CONTEXT.md:39`），适合维护者代建；对外开放 Agent 时，每月 15 美元的额度撑不住多个客户，单成员限制也不适合团队。生产要换按量渠道（OpenCode Console 或直连 Anthropic/Google），并重写对外的数据流说明（Haiku 经 OpenCode 保留 30 天）。

### S8. 隔离技术的强弱与代价

- **来源与日期**：[Securely deploying AI agents](https://code.claude.com/docs/en/agent-sdk/secure-deployment)，未见日期。
- **来源主张**：官方对比四类：sandbox-runtime（隔离较好、开销很低）、Docker（取决于配置）、gVisor（配置正确时很强，CPU 密集几乎无开销，频繁开关文件的 I/O 可慢 10–200 倍）、Firecracker/QEMU 虚拟机（很强，Firecracker 启动不到 125 ms、内存开销不到 5 MiB）。推荐凭据代理模式：凭据留在边界外，由代理注入并记录请求。
- **适用边界**：这些是给"会执行代码的 Agent"的建议；数字是厂商与上游项目的说法。
- **仓库启发**：ADR-0025 已把上游 key 留在宿主、执行器只拿本轮令牌（`docs/adr/0025-agent-credential-and-input-boundary.md:14`），同时写明这不是给托管租户的操作系统沙箱（同文件 `:22`）。服务端 Tool Runner 循环里，模型 key 本来就只在宿主进程内，这层代理可以省掉。

### S9. 托管沙箱与 Kubernetes 方案（备选，只在要给 Agent 执行代码时才用）

- **来源与日期**：[E2B 定价](https://e2b.dev/pricing)、[Modal Sandboxes](https://modal.com/docs/guide/sandboxes)、[Daytona 文档](https://www.daytona.io/docs/en/)（v0.226）、[Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)（2026-09-30 更新）、[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)（安装示例用 v1.0.2），其余未见日期。
- **来源主张**：E2B 按秒计 vCPU 与内存，免费层单次最长 1 小时、Pro 24 小时，自带云要企业版；定价页没写隔离技术。Modal 缺省 gVisor，也可选独立内核的 VM 运行时，单个沙箱最长 24 小时。Daytona 宣称不到 90 ms 启动、独立内核，有自带算力的部署页。Cloudflare Sandbox 的容器是独立内核的 microVM，只在 Cloudflare 上跑。agent-sandbox 提供 Sandbox、模板、认领与预热池几种 CRD，隔离交给 RuntimeClass（gVisor、Kata）。Managed Agents 的自托管 worker 有 Cloudflare、Daytona、E2B、Modal、GKE Agent Sandbox 等平台指南（S5）。
- **适用边界**：启动时间多为厂商自述，没有统一测法；价格未含出站流量。
- **仓库启发**：推荐路线不需要这一层。将来要让 Agent 跑脚本（例如自己写数据转换）时再引入：要自托管选 agent-sandbox + gVisor，要省运维选 E2B 或 Modal。

## 二、产品形态参照

### S10. Bannerbear：按 API 点数计，AI 点数单列，企业版卖 SSO、审计与 ZDR

- **来源与日期**：[Bannerbear Pricing](https://www.bannerbear.com/pricing/)，未见日期。
- **来源主张**：三档每月 49、149、299 美元，API 点数 1,000 起；渲染一张图 1 点，格式与倍率增加时点数翻倍。另有 AI 点数（200/600/1,250）。点数用完就拒绝，不透支。试用 30 点、不要信用卡。MCP 与 REST API 在最低档就有；团队成员、自定义 S3 在中档；SSO、审计日志、ZDR 在企业档。
- **适用边界**：页面没写超额价格与席位数。
- **仓库启发**：同类产品把 AI 用量单独成池、与出图点数分开；"用完即拒"与 ADR-0020 的整批拒绝同向。

### S11. Placid：一张图 1 点，预览免费，不收超额费

- **来源与日期**：[Placid Pricing](https://placid.app/pricing)，未见日期（页脚 2026）。
- **来源主张**：四档每月 500、2,500、25,000、100,000 点；图片 1 点、PDF 每页 2 点、视频每 10 秒 10 点；预览免费；不收超额费，用完只能升级；未用点数可结转到月额度的两倍。集成里有 REST、URL API、MCP 与编辑器 SDK。
- **适用边界**：页面正文没有标价。
- **仓库启发**：预览免费与 ADR-0020"草稿不计数"一致；结转与 M242"不结转"不同，是可调的商业参数。

### S12. APITemplate.io：按月张数，免费层 50 张，企业版可自带 S3

- **来源与日期**：[APITemplate.io Pricing](https://apitemplate.io/pricing/)，未见日期（页脚 2026）。
- **来源主张**：免费层每月 50 张、3 个模板；图片加 PDF 档位每月 1,500 至 40,000 张；企业版可上传到客户自己的 S3、按量计费月底结算；提供 DPA；数据托管在 AWS，不可选地区。
- **适用边界**：每档两个价格没有标注是否年付。
- **仓库启发**：企业客户关心"图存在哪"与 DPA，出图记录可离线重放（ADR-0019）是可讲的合规卖点。

### S13. Templated.io：点数加成员数分档，内嵌编辑器从中档起

- **来源与日期**：[Templated Pricing](https://templated.io/pricing/)，未见日期（页面内容为 2026 年）。
- **来源主张**：年付每月 29、79、179 美元，对应 1,000、5,000、25,000 点；图片 1 点、PDF 每页 1 点；成员数 2、5、20；可嵌入客户应用的白标编辑器从中档开始；所有档都有拖拽编辑器与"文字生成模板"的 AI 功能；试用 50 点。
- **适用边界**：月付价未显示。
- **仓库启发**：席位是档位上限，不是计价单位；竞品都有拖拽编辑器，RenderWeave 已决定不做自由拖拽（`docs/roadmap.md:34`），差异要靠约束式模板与 Agent 代建讲清楚。

### S14. Canva Connect Autofill：品牌模板加数据字段，异步任务

- **来源与日期**：[Autofill guide](https://www.canva.dev/docs/connect/autofill-guide/)、[Connect API](https://www.canva.dev/docs/connect/)，均未见日期。
- **来源主张**：先读品牌模板的数据集（可填字段与类型），上传图片资源，再建 autofill 任务、轮询结果、另起导出任务。要 Canva Pro、Teams 或 Enterprise 且开 MFA；页面记载的字段是文字与图片，图片只能引用已上传资源；用量限制"以后会加"。预览阶段的 API 过不了公开应用审核。
- **适用边界**：没读导出与限流细节。
- **仓库启发**：结构与"数据定义 + 模板 + 批次"相同；RenderWeave 的差异在线路牌一类的约束规则（统一缩字、合并相邻同值项，`CONTEXT.md:70`）。这条对比是推断，没有逐项核 Canva 的排版能力。

### S15. Figma：REST 只渲染已有节点，填数要靠编辑器里的插件

- **来源与日期**：[File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)，未见日期；[Rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)，2025-11-17 生效；[How plugins run](https://developers.figma.com/docs/plugins/how-plugins-run/)，未见日期。
- **来源主张**：`GET /v1/images/:key` 按节点 ID 渲染 jpg/png/svg/pdf，倍率 0.01–4，最大 3,200 万像素，链接 30 天失效；属 Tier 1，Dev/Full 席位每分钟 10–20 次，View/Collab 席位每月最多 20 次。插件在 Figma 编辑器的沙箱里跑，结束要调用关闭。
- **适用边界**：没读插件编辑节点的 API 页。
- **仓库启发**：Figma 不适合当批量出图后端；它的位置是"设计稿来源"，v2 可以考虑从 Figma 文件导入示例图与素材（推断）。

### S16. Claude Design：评论定位、直接改字、按需生成调节旋钮

- **来源与日期**：[Introducing Claude Design by Anthropic Labs](https://www.anthropic.com/news/claude-design-anthropic-labs)，2026-04-17。
- **来源主张**：研究预览；先由描述生成初稿，再用对话、元素上的行内评论、直接改文字与 Claude 生成的滑块调整间距、颜色、布局；可按团队设计系统生成；可导出 PDF、PPTX、HTML 或交给 Canva；用量计入 Claude 付费计划的额度。
- **适用边界**：发布文没有用"左对话右画面"命名布局，那是本仓库原型 D 的设计（`docs/roadmap.md:44`）。
- **仓库启发**：M208 的旋钮对应模板参数、由引擎渲染（`docs/discovery/requirements.md:498`），比 Claude Design 的旋钮更受约束；旋钮的价值取决于拖动时的预览延迟，见综合建议第 4 节。

## 三、架构与基础设施

### S17. 队列与工作流：pg-boss、Graphile Worker、Temporal

- **来源与日期**：[pg-boss](https://github.com/timgit/pg-boss)、[Graphile Worker](https://worker.graphile.org/)、[Understanding Temporal](https://docs.temporal.io/evaluate/understanding-temporal)，均未见日期。
- **来源主张**：pg-boss 基于 `SKIP LOCKED`，有重试、cron、优先级、死信与限流，要求 Node 22.12+ 与 PostgreSQL 13+，MIT。Graphile Worker 用 LISTEN/NOTIFY 让任务毫秒级开始，自称每秒最多 1 万个任务。Temporal 做持久执行：工作流代码须确定性，外部动作放进 activity；可自托管（含 PostgreSQL 持久层）或用 Temporal Cloud，worker 总在自己机器上。
- **适用边界**：吞吐数字是项目自述。
- **仓库启发**：现有队列已用 `FOR UPDATE SKIP LOCKED`（`service/migrations/0004_render_tasks.sql:31`），还带构建亲和、租约、项内取消与额度预占，换 pg-boss 省不了多少代码（推断）。可借的是 LISTEN/NOTIFY：worker 空闲时每 100 ms 轮询（`service/src/config.ts:83`），接口进程每 25 ms 查预览结果（`service/src/api/previews.ts:120`–`131`）。

### S18. 多租户：池化、独立、混合三种模型

- **来源与日期**：[AWS SaaS Lens：Silo, Pool, and Bridge Models](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html)，未见日期。
- **来源主张**：silo 给租户独立资源（独立栈或独立库），pool 共享资源，bridge 按服务混用；监管要求与吵闹邻居推向 silo，成本与敏捷推向 pool；silo 仍共用身份、开通与运维。
- **适用边界**：框架性指南，不给阈值。
- **仓库启发**：现状是 pool：每表 `tenant_id` 加行级安全、非属主应用账号（`docs/adr/0018-tenants-and-storage-abstraction.md:52`–`53`，`service/migrations/0002_auth_and_isolation.sql:81`–`96`）。企业客户要物理隔离时，用同一镜像给它独立部署（bridge），不改成每租户一个 schema。

### S19. Compose 可以上单机生产

- **来源与日期**：[Use Compose in production](https://docs.docker.com/compose/how-tos/production/)，未见日期。
- **来源主张**：最简单的做法是单机运行；生产差异放进叠加文件（去掉代码挂载、改端口、加重启策略与日志收集）；扩展到多机用 Swarm。
- **适用边界**：不谈高可用。
- **仓库启发**：现有 `compose.yaml` 已按镜像与环境变量配置、worker 有内存与 CPU 上限（`compose.yaml:96`–`111`），第一个生产环境加一份叠加文件即可（推断）。

### S20. 可观测：OpenTelemetry JS 的追踪与指标已稳定

- **来源与日期**：[OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/)，未见日期。
- **来源主张**：追踪与指标为 Stable，日志为 Development；支持所有在维护的 Node LTS。
- **适用边界**：日志信号仍会变。
- **仓库启发**：现在有每行一个 JSON 的日志、`/healthz`、`/readyz` 与积压日志（`docs/service.md:121`–`127`），没有指标后端和告警。追踪与指标上 OTel，日志继续用 pino 输出；Anthropic TS SDK 能为每个模型请求出 span（S4）。

### S21. 计费：Stripe 的用量计费与可用地区

- **来源与日期**：[Usage-based billing](https://docs.stripe.com/billing/subscriptions/usage-based)、[Stripe global](https://stripe.com/global)，均未见日期。
- **来源主张**：新接入的用量计费推荐 Metronome，基于 Meters API 的基础版仍完整支持，有预付点数。Stripe 支持香港主体，不支持中国大陆主体。
- **适用边界**：国内支付渠道（微信支付、支付宝）本轮没查官方文档，**未知**。
- **仓库启发**：套餐由管理员手工设、不接在线支付（`docs/discovery/requirements.md:598`），用量事件只追加（ADR-0020）。自助付费前不必接计费平台；接的时候以 `usage_events` 为账，按期汇总上报。

## 四、部署地区的硬约束

### S22. 中国大陆服务器需 ICP 备案

- **来源与日期**：[阿里云：什么是 ICP 备案](https://help.aliyun.com/zh/icp-filing/basic-icp-service/product-overview/what-is-an-icp-filing)，未见日期；[阿里云帮助检索结果](https://help.aliyun.com/zh/icp-filing/new-website-process)。
- **来源主张**：依据《互联网信息服务管理办法》与《非经营性互联网信息服务备案管理办法》，解析到中国内地服务器的网站与 App 须先备案，未备案会被阻断访问；经营性互联网信息服务实行许可制；香港与海外节点不需要备案（帮助文档其他页说明）。
- **适用边界**：这是云厂商页面，不是管局原文；对外收费的 SaaS 需要哪类经营许可，**未知**，需要法务。
- **仓库启发**：M240 说地点不限、手续由用户办（`docs/discovery/requirements.md:596`），大陆部署要把备案周期排进上线计划。

### S23. 数据出境：2024 年规定的阈值

- **来源与日期**：[国家网信办《促进和规范数据跨境流动规定》](https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm)，2024-03-22 公布施行。
- **来源主张**：非关键信息基础设施运营者当年累计向境外提供不满 10 万人个人信息（不含敏感个人信息）的免予安全评估、标准合同与认证；10 万至 100 万人（或敏感个人信息不满 1 万人）须订标准合同或认证；100 万人以上或敏感个人信息 1 万人以上须申报安全评估；不含个人信息与重要数据的数据可直接出境。
- **适用边界**：示例图与数据集是否含个人信息或重要数据，取决于客户业务，**未知**。
- **仓库启发**：大陆部署而 Agent 调境外模型时，示例图、项目说明与预览图会出境（M232 的数据流，`docs/discovery/requirements.md:562`）。线路牌与价签一般不含个人信息（推断），但要在客户协议里写明。

### S24. 生成式 AI 服务办法

- **来源与日期**：[国家网信办等《生成式人工智能服务管理暂行办法》](https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm)，2023-07-10 发布、2023-08-15 施行。
- **来源主张**：适用于向境内公众提供生成式 AI 服务；有舆论属性或社会动员能力的服务要做安全评估与算法备案；只研发应用、不向境内公众提供服务的不适用；境外向境内提供的不合规服务可被处置。
- **适用边界**：面向企业的模板设计工具算不算"向公众提供"，**未知**，需要法务。
- **仓库启发**：5.1 向客户开放 Agent 前，大陆部署要先问清这一条。

### S25. Anthropic 不对中国大陆与香港提供服务

- **来源与日期**：[Supported countries and regions](https://www.anthropic.com/supported-countries)，页面写明 2026-11-12 生效。
- **来源主张**：中国大陆与香港不在支持列表，未列出的地区一律不支持。
- **适用边界**：经第三方网关（如 OpenCode）在这些地区调用是否合规，**未知**。
- **仓库启发**：大陆部署的 Agent 模型路线要按 M232 的切换条件换国内模型，并重跑评估门槛。

## 五、桌面端

### S26. Electron：自带 Chromium 与 Node

- **来源与日期**：[Electron 文档首页](https://www.electronjs.org/docs/latest/)、[进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[安全清单](https://www.electronjs.org/docs/latest/tutorial/security)，均未见日期。
- **来源主张**：把 Chromium 与 Node 嵌进二进制，跨 Windows、macOS、Linux；主进程有完整 Node API，渲染进程缺省没有；utility process 适合 CPU 密集或不受信任的服务；安全清单 20 条，含上下文隔离、进程沙箱、校验 IPC 发送方。
- **适用边界**：页面不谈包体大小。
- **仓库启发**：引擎是 Node + WASM（ADR-0011、ADR-0012），可以直接在 utility process 里跑；控制台的 React 页面可以复用。

### S27. Tauri：系统 WebView，Node 要做成外挂进程

- **来源与日期**：[What is Tauri](https://v2.tauri.app/start/)，2026-07-22 更新；[Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)，2026-09-21 更新。
- **来源主张**：用系统 WebView 而不捆浏览器，最小应用可不到 600 KB；Node 程序要先用 `pkg` 打成单文件，作为 sidecar 注册、授权、按目标三元组改名，每次调用起一个进程。
- **适用边界**：只覆盖桌面平台。
- **仓库启发**：引擎资产本身就大：`canvaskit.wasm` 7.3 MB、`resvg` WASM 2.5 MB、缺省字体 33 MB（本机实测文件大小），Tauri 的体积优势在本项目不成立，还要多一套 Node 打包。

### S28. 浏览器写本地目录的能力有限

- **来源与日期**：[MDN showDirectoryPicker()](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)，2026-09-11 修改。
- **来源主张**：标为实验性、有限可用，不属于 Baseline；只在 HTTPS 下、且要用户操作触发。
- **适用边界**：没有逐浏览器核兼容表。
- **仓库启发**："整批导出到本地目录"在网页上只能部分做到，是桌面端少数实在的增量之一；但同样的需求，下载压缩包或现有命令行 `renderweave` 也能满足。

## 综合建议

### 1. 产品形态

| 卖什么 | 角色与入口 | 现状 | 计价 | 阶段 |
|---|---|---|---|---|
| 出图 API 与 webhook | 开发者：API 密钥、OpenAPI 3.1 | 已有（`CONTEXT.md:88`） | 正式交付张数，预览不计（ADR-0020） | v1.0 |
| 出图控制台 | 操作员与客户管理员：表单、Excel 导入、批量交付、记录 | 已有（`CONTEXT.md:89`–`90`） | 同上；成员数作套餐上限，不单独计价（推断，参照 S13） | v1.0 |
| 代建服务 | 我们的代建工程师 | 本机命令行流程（ADR-0017:49–52） | 按模板收一次性费用（推断，无外部来源） | v1.0 |
| 远程 MCP（开发者自己的 Agent 用） | 开发者：API 密钥鉴权的 HTTP MCP，工具与开放 API 一一对应 | 只有本机 stdio 只读 MCP（`src/mcp/server.ts:2`） | 计入出图张数与预览频率 | 5.1（同类产品已把 MCP 放进基础档，S10、S11） |
| 人类编辑页 | 模板作者：数据定义、模板、发布 | 已定（M299） | 不单独计价 | 5.0 |
| Agent 工作台 | 模板作者：示例图或数据集到模板 | 本机 CLI 已验收（第三阶段） | "Agent 额度"，内部按四种 token 记（ADR-0020:16）；AI 用量单独成池有先例（S10） | 5.1 |
| 组件库 / 模板市场 | — | 未开始 | 未定 | v2 |

- **免费层**：等 5.1 能自助做模板再开。v1.0 没有模板就出不了图，免费层没有意义。M274 已写"阶段 5 自助注册时改为试用套餐"（`docs/discovery/requirements.md:633`）。试用给少量张数（同类为 30–50，S10、S12、S13）与少量 Agent 额度。
- **超额**：保持整批拒绝、不透支（ADR-0020），同类产品也是用完即拒或提醒升级（S10、S11、S13）。
- **v1.0 → 5.0 → 5.1 的切分合理**（模板每月几个，M204；代建已验收），但要调整三处：
  1. 在 v1.0 对外收费前插入"4.x 生产化"。第四阶段只在本机 Compose 上验收，真实云上部署不在合格声明内（`docs/stage4-acceptance.md:19`）。
  2. 把服务端 Agent 执行内核提到 5.0，先给内部代建用，替掉本机 Claude Code；5.1 只加客户界面与额度拦截。风险前移，也复用 ADR-0022 的同一套代建 API。
  3. 交互预览通道放在 5.0 末，作为 5.1 旋钮的前置。

### 2. Agent 运行时：三条路对比与迁移面

| 维度 | 现状：本机无头 Claude Code | (a) Claude Agent SDK | (b) Messages API + Tool Runner（推荐） | (c) Managed Agents |
|---|---|---|---|---|
| 还跑 Claude Code 吗 | 是（`src/agent/run.ts:492`） | 是，捆绑二进制、每个 session 一个子进程（S2） | 否，SDK 只发 HTTP（S4） | 否，循环在 Anthropic（S5） |
| 模型渠道 | 本机代理转 OpenCode 的 Haiku/Gemini（`run.ts:484`–`488`，M232） | 同现状（S2） | 任一 Anthropic 兼容端点；Gemini 走转换层（S4） | 只有 Claude 4.5+ 与 Anthropic key（S5） |
| 工具 | 内置 `Read,Write,Edit,Glob` 加 MCP（`tasks.ts:30`） | `tools: []` 后只留进程内 MCP 工具（S3） | 全部自定义 | 内置工具、远程 MCP、自定义工具（S5） |
| 托管时的隔离单位 | 不支持托管（`docs/agent-trust-boundary.md:13`） | 子进程有工作目录与文件状态，要按租户隔离或每轮容器（S2、S8） | 进程内函数；隔离靠租户存储句柄与渲染 worker（推断） | Anthropic 沙箱或自托管 worker，工具数据经 Anthropic（S5） |
| 时限与费用控制 | 监督器 60 分钟墙钟与轮数上限，硬 token 上限做不到（ADR-0024:40） | `maxTurns`；预算是可能超的客户端估算（S2） | `max_iterations`，每次响应后按 usage 截停，超量不超过一次响应（推断） | session 预算与用量事件（S5） |
| 断点恢复 | 宿主检查点，新轮次接续（ADR-0024） | 同左，或 `SessionStore` | 同左，检查点改存 PostgreSQL 加 S3 | 服务端持久的 session |
| 数据驻留 | 随 OpenCode，缺省欧美（S7） | 同左 | 随所选端点 | 推理 us/global，存储只有 us，不能 ZDR（S5、S6） |
| 迁移面 | — | 小（推断） | 中，见下 | 大：模型、工具、评估全部重来 |

**迁移面（文件清单已验证，规模为推断）**：

- **必须重写**：`src/agent/run.ts` 的执行段（`:470`–`:505` 组装受管 MCP、代理与参数；`:735` 起的 `execute()` 管子进程与流解析；`:802`–`:822` 的 `readUsage` 读 `system/init` 与 `result`）；`src/agent/usage.ts`（34 行，按 `result`、`assistant` 事件累计用量，`:18`–`:19`）；`src/agent/stagnation.ts`（131 行，按 Claude Code 事件形状和 `Write`/`Edit` 工具名判断修复循环，`:52`、`:76`、`:106`）；`round-metrics.ts`、`stopped-round.ts`（读 `logs/stream.jsonl`）。
- **可删或降级**：`checkpoint-host.ts` 与 `mcp-forward.ts`（共 81 行，stdio MCP 桥）；`anthropic-proxy.ts`（41 行，执行器外的凭据代理）。`supervision.ts` 与 `run-worker.ts`（共 177 行）按进程树终止本轮，是为同步渲染会挡住定时器而设（ADR-0024:36）；服务端版把渲染都放进渲染 worker 后，可改为取消信号加任务取消（推断），CLI 执行器保留原样。
- **改合同与资料**：`tasks.ts` 四处 `tools` 改为领域工具；`agent/tasks/*.md` 与 `agent/reference/outcome.md:3` 的"写 outcome.json"改为调用提交工具；MCP 合同升版。ADR-0022 本来就要求加写工具并复跑评估（`docs/adr/0022-agent-human-capability-parity.md:15`）。
- **评估与测试**：`scripts/agent-eval/identity.ts:52` 绑定 Claude Code 可执行文件，`eval.ts:671` 报告 Claude Code 版本；`test/` 下 25 个文件用 `test/support/` 里模拟 stream-json 的假执行器（`fake-claude.mjs` 等）。评分器 `score.ts` 按成果评分，不读事件流。
- **原样复用**：`src/mcp/tools.ts` 的工具 Schema 与处理器；检查点、成果检查、审核、应用、内容身份等宿主逻辑（`src/agent/` 共约 6,300 行，大部分不动）；`model-proxy.ts`（431 行）的协议转换。
- **规模**：改动集中在约 12 个文件、1,300 行上下，另加 25 个测试文件改走新接缝（推断）。

**落地方式**：

1. **先加执行器接缝**：定义"执行一轮"的接口和归一化事件（工具调用、工具结果、用量、结束原因）。现有 Claude Code 执行器先改成输出归一化事件，停滞控制、用量与测试都读归一化事件。这一步不改行为，现有测试与评估应全过。
2. **Tool Runner 执行器**：工具清单 = 现有只读工具 + `write_candidate`（整份写入）+ `edit_candidate`（按旧串换新串，与 `Edit` 同语义）+ `submit_outcome` + `list_candidates`；示例图经 `view_image` 读取。候选写入宿主管理的工作副本，不给通用文件系统。缓存控制用 `cache_control` 显式设置（S4 的工具辅助函数支持透传）。
3. **服务端形态**：新增 agent worker 进程，与接口进程、渲染 worker 并列，按 PostgreSQL 任务表领取轮次（租约加心跳，沿用 ADR-0024 给出的方向，`docs/adr/0024-durable-agent-rounds-and-checkpoints.md:42`）。工具处理器只拿本租户的存储句柄；凡是渲染（`render_draft`、`compare_reference`、`check_outcome` 的实际渲染）都经渲染 worker 队列，保持 ADR-0017 的进程隔离，因为同步 WASM 在进程内打断不了；写工具调用代建 API 的同一实现，按代建令牌角色授权（`docs/adr/0022-agent-human-capability-parity.md:13`–`14`）。
4. **不再需要每轮容器**：Agent 没有代码执行、没有通用文件读写、出站只有模型端点，攻击面就是领域工具本身；风险靠角色授权、审计、不可变版本与回退控制（ADR-0022:17、:28）。这条结论要先做一次威胁建模复核，再记成 ADR（推断）。
5. **对照与切换**：同一资料、同一模型，两种执行器各跑 M230 四场景门槛；新执行器连续两次达线即改为缺省，CLI 执行器保留一个版本作对照。

### 3. 现状 → 目标差距表

| 层 | 现状与仓库证据（已验证） | 缺口 | 建议 | 优先级 |
|---|---|---|---|---|
| 部署 | 本机 Compose，四类容器加 `setup`（`compose.yaml:31`–`139`）；真实云上部署不在验收范围（`docs/stage4-acceptance.md:19`） | 没有生产叠加文件、TLS、域名、镜像仓库、密钥管理 | 单 VM + 生产叠加文件（S19），托管 PostgreSQL 与托管对象存储 | P0 |
| 对象存储 | 本机用 RustFS 1.0.3（`compose.yaml:46`–`47`），长期负载内存持续上涨（`docs/stage4-acceptance.md:218`） | 生产选型 | 云厂商 S3 兼容服务，只用基础操作（ADR-0017:57） | P0 |
| 备份与灾备 | `docs/service.md` 与 ADR 里没有备份与恢复 | RPO/RTO 未定，从没演练 | PostgreSQL 时间点恢复 + 对象存储版本化；用 `accept-stage4.mjs` 与离线 `replay` 验恢复 | P0 |
| 认证 | 邮箱加密码，不做自助注册与第三方登录（`docs/discovery/requirements.md:608`）；登录限频与锁定没做（同文件 `:620`） | 对外上线的暴力破解面；企业 SSO | 上线前补限频与锁定；企业档再加 OIDC（同类把 SSO 放企业档，S10） | 限频 P0，OIDC P2 |
| 模型渠道 | 单个 `OPEN_CODE_API_KEY`（`CONTEXT.md:39`） | Go 是单人包月、Haiku 每月 15 美元额度（S7） | 生产换按量渠道，按租户记 token | P0（开放 Agent 前） |
| Agent 运行时 | 本机 CLI；v1.0 服务端不托管（`docs/adr/0017-service-shape-and-render-isolation.md:49`–`52`） | 服务端执行、轮次存储、并发与额度 | 第 2 节的 Tool Runner 执行器 + agent worker | P0（5.0） |
| Agent 写入与审计 | ADR-0022 已定同能力写入；现有 MCP 只读（`CONTEXT.md:73`） | 写工具、Agent 主体的审计字段（ADR-0022:32） | 5.0 实现 | P1 |
| 交互预览 | 端到端草稿预览中位 1,195 ms（`docs/stage4-acceptance.md:78`）；每次预览从 PostgreSQL 与 S3 重新组装工作区（`service/src/preview.ts:35`–`36`、`service/src/worker/render-child.ts:31`–`34`）；进程内 50 DPI 中位 102 ms（本轮实测） | 旋钮实时预览（`docs/roadmap.md:44`–`46`）达不到；差距各部分占多少**未知** | 按内容哈希缓存工作区与字体、LISTEN/NOTIFY 派发、50 DPI 加丢弃过期请求；先测再定目标 | P1（5.1 前） |
| 队列 | PostgreSQL `SKIP LOCKED`（`service/migrations/0004_render_tasks.sql:31`） | Agent 轮次的长任务、租约与心跳 | 同模式加轮次表；不引入 Temporal | P1 |
| 租户隔离 | 共享库 + 行级安全 + 非属主应用账号（`docs/discovery/requirements.md:621`） | 没有独立部署选项；v1.0 不删除数据（ADR-0018:66） | 保持 pool；企业客户用独立部署；补租户注销与数据删除 | P2 |
| 可观测 | JSON 日志、健康检查、积压日志（`docs/service.md:121`–`127`） | 没有指标、追踪与告警 | OTel 追踪与指标（S20），告警盯积压、预览 p95、超额拒绝、轮次成本 | P1 |
| 计费 | 手工套餐，不接在线支付（`docs/discovery/requirements.md:598`） | 自助付费 | 5.1 自助注册时再接：境外主体用 Stripe（S21），大陆主体渠道未核 | P2 |
| 导出体积 | 千项 M402 整批导出约 33 GB（`docs/stage4-acceptance.md:212`） | 生产磁盘与带宽 | 先定取舍（阶段 4 后续第 1 项） | P1 |

### 4. 分层选型与切换条件

| 层 | 推荐 | 不选 | 切换条件 |
|---|---|---|---|
| 引擎 | 不变：TypeScript/Node、CanvasKit、resvg WASM（ADR-0011、0012） | — | — |
| HTTP 与数据 | 不变：Fastify 5、PostgreSQL 17、node-postgres、手写迁移（`docs/discovery/requirements.md:618`） | ORM 与迁移框架 | 迁移出现分支合并冲突时再议 |
| Agent 循环 | Tool Runner（S4） | Agent SDK、Managed Agents | 见判断段 |
| 模型渠道 | 按量渠道：OpenCode Console 或直连 Anthropic/Google | OpenCode Go 包月 | 客户资料不能出境时换国内模型（M232） |
| 沙箱 | 不需要 | E2B、Modal、agent-sandbox | 要给 Agent 执行代码时：自托管用 agent-sandbox + gVisor，托管用 E2B 或 Modal（S9） |
| 队列 | 现有 PostgreSQL 队列，加 LISTEN/NOTIFY | pg-boss、Graphile Worker、Temporal | 领取延迟或数据库负载成瓶颈（ADR-0017:62）；出现跨服务、带人工等待的长流程时考虑 Temporal |
| 部署 | 单 VM + Compose；数据库与对象存储用托管服务 | 一开始就上 Kubernetes | 渲染 worker 要多机自动扩缩或零停机发布时上托管容器服务；要多个 worker 池、按构建保留 worker、企业独立部署时上 Kubernetes。托管容器服务先核对能否关交换分区、读 cgroup `memory.events`（M266 依赖，`docs/discovery/requirements.md:625`），**未知** |
| 多租户 | pool：共享库 + 行级安全（已有） | 每租户一个 schema | 合同要求物理隔离或指定地区时，给该客户独立部署 |
| 认证 | 现有令牌体系 + 限频与锁定；企业档 OIDC | 自研 SAML | 企业客户要 SSO 时加 OIDC |
| 计费 | 手工开票，以 `usage_events` 为账 | 一开始就接计费平台 | 自助注册上线时接 Stripe（境外主体），大陆主体另选 |
| 可观测 | OTel 追踪与指标 + pino 日志 | 自建指标系统 | — |
| 交互预览 | 服务端预览通道 + 缓存 | 浏览器端跑引擎 | 服务端通道优化后仍达不到目标时再议；浏览器端会让草稿与正式出图的构建标识分叉 |
| 桌面端 | v1.x 不做 | Tauri | 出现第 5 节的硬需求时做 Electron |

### 5. 桌面端：Agent 循环只放服务端

- **Agent 循环放服务端（已有依据）**：模型 key 不能下发到客户端，Anthropic TS SDK 在浏览器里缺省禁用就是为此（S4），ADR-0025 也规定凭据留在宿主；阶段 5 的 token 额度要在调用发生处拦截（ADR-0020:16）；Agent 写入要记主体审计（ADR-0022:16）；Agent 的写工具最终调用的就是服务端的代建 API。
- **正式交付也只在服务端**：计费与出图记录绑在同一事务（ADR-0019、ADR-0020），桌面端本地正式出图会绕过计量与记录。
- **桌面端相对网页多出的东西**：写本地目录（网页能力有限，S28）、离线草稿预览、读本机字体、监视文件夹或接打印机。仓库文档里没有这些需求的记录（检索 `docs/` 与 `.scratch/` 未见），所以判定为没有硬需求。下载压缩包与现有命令行 `renderweave`（离线 `deliver`、`replay`）已覆盖高级用户的本地流程。
- **真要做时选 Electron**：引擎能直接在 utility process 里跑（S26），控制台页面能复用；Tauri 要另外把 Node 打成 sidecar（S27），而引擎资产已有约 43 MB，体积优势不成立。
- **"SaaS + 桌面端"的切换条件**：客户提出离线出草稿、批量落到本地目录或接本地设备，且网页与命令行都满足不了。

### 6. 分阶段路线

| 阶段 | 做什么 | 验证什么 | 做完的标准 |
|---|---|---|---|
| 4.x 生产化（v1.0 收费前） | 单 VM 部署、托管数据库与对象存储、TLS、镜像按构建保留（ADR-0019）、登录限频与锁定、OTel 与告警、备份、整批导出取舍、初始密码字符（阶段 4 后续第 2 项） | 云上从空环境跑 `service/scripts/accept-stage4.mjs`；删库恢复演练后再跑一遍，并用 `replay` 重放恢复前导出的记录；`capacity.mjs soak` 跑 3 小时 | 两次全流程通过；恢复后记录哈希一致；RPO/RTO 达到拍板值 |
| 5.0a 服务端 Agent 内核（内部代建先用） | 执行器接缝；Tool Runner 执行器；领域工具替换通用文件工具；轮次任务表与 agent worker；轮次存储移到 PostgreSQL 加 S3；生产模型渠道；token 计量接用量事件 | M230 四场景门槛在新执行器上连续两次达线；与 CLI 执行器比 token 与墙钟；`docs/agent-trust-boundary.md` 的四类低可信来源配对重跑；假执行器测试改走接缝 | 代建工程师从服务端发起、审核、应用，不再需要本机 Claude Code；CLI 执行器保留一版作对照 |
| 5.0b 人类页面与写入（M299） | 数据定义、模板、发布三页；写工具；Agent 主体审计；可选审批策略 | ADR-0022 的回退、审计与审批策略；真人走查 | 人和 Agent 走同一套代建 API，回退与审计可查 |
| 5.0c 交互预览通道 | 工作区与字体缓存、通知派发、50 DPI、丢弃过期请求 | 在 `capacity.mjs profile` 里加"旋钮预览"一段，测 p50/p95 | p95 达到拍板值（建议 300 ms 级，推断） |
| 5.1 对客户开放 Agent | 对话加预览区、评论定位、旋钮、示例图向导；token 额度拦截；试用套餐与自助注册；远程 MCP | 非团队成员的真人从示例图到首批正式出图的用时与卡点；额度拦截与审计 | 客户能不靠我们做出第一张可交付的模板 |
| v2 | 组件库与模板市场、企业独立部署、OIDC、Kubernetes、桌面端（有硬需求才做） | 看真实需求 | — |

### 7. 需要用户拍板的事项（只列建议，未改 requirements.md 与 ADR）

1. **Agent 执行器改为自建 Tool Runner 循环，取消"每轮一个独立容器"的前提**（修订 ADR-0015、ADR-0017 的托管部分与 `docs/roadmap.md:39`）。写 ADR：工具合同、提示词与评估基线都跟着变，难以逆转。
2. **生产模型渠道与数据流**（OpenCode Go 换成按量渠道或直连；Haiku 经 OpenCode 保留 30 天；对外的数据说明）。记 M 编号修订 M232；写进客户合同时另写 ADR。
3. **部署地区与运营主体**（大陆或境外）。写 ADR：牵动 ICP 备案（S22）、模型可用性（S25）、数据出境（S23、S24）与支付（S21）。
4. **Agent 只在服务端运行，桌面端 v1.x 不做**。记 M 编号。
5. **客户看到的 Agent 计价单位**（token 折成"Agent 额度"，还是按轮次或按模板）。记 M 编号。
6. **数据保留与删除**（租户注销、导出、删除）。写 ADR，修订 ADR-0018、ADR-0019 的"v1.0 不删除"。
7. **RPO/RTO 与备份策略**。记 M 编号。
8. **交互预览要不要允许浏览器端引擎**。服务端通道达不到目标时再议；真要做就写 ADR，因为草稿与正式出图的构建标识会分叉。

## 本轮可信度与下一步

- **已验证**：仓库现状与证据行号；S1–S28 的页面内容（2026-10-26 打开）；Anthropic TS SDK 的 `baseURL` 读自源码；本机进程内 M402 渲染计时；引擎资产文件大小；四种任务都依赖 `Read,Write,Edit,Glob`；用量、停滞、指标三处解析 Claude Code 的 stream-json；25 个测试文件用假执行器。
- **推断**：Tool Runner 迁移约 12 个文件、1,300 行；去掉通用文件工具后不需要每轮容器（要做威胁建模复核）；单 VM 的容量够首批客户（按每个 worker 每分钟约 60 张 M402，`CONTEXT.md:37`）；代建一次性收费；交互预览 p95 300 ms 级的目标。
- **未知**：Tool Runner 执行器在 M230 门槛上的质量（这是最关键的实验）；OpenCode 是否允许商用 SaaS 后端，其兼容端点是否支持服务端压缩与 Anthropic 定义的工具类型；端到端预览 1.2 秒里各部分的占比；托管容器平台能否满足 M266 的内存与 OOM 判别；大陆 B2B SaaS 的经营许可类别，以及是否适用生成式 AI 办法；国内支付渠道；Managed Agents 正式版的时间与条款。
- **下一步**：在 `src/agent/` 加执行器接缝，用 Tool Runner 包 `src/mcp/tools.ts` 跑一次 M402 模板辅助设计，对比 CLI 执行器的 token、墙钟与评分；同时给 `capacity.mjs profile` 加端到端预览的分段计时，拆出排队、组装工作区与渲染各占多少。
