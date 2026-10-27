---
status: accepted
---

# 业务 Agent 由 RenderWeave 在进程内用 Tool Runner 驱动，不再依赖 Claude Code

2026-10-26，M340。取代 [ADR-0015](0015-agent-runs-as-headless-claude-code-via-read-only-mcp.md) 的执行方式。依据见[平台化研究](../research/2026-10-26-platform-architecture.md)第 2 节与 [Tool Runner 执行器原型](../agent-eval/tool-runner-prototype.md)。

## 问题

产品要做成 SaaS 加桌面端，用户不希望再依赖本地无头 Claude Code。ADR-0015 让每一轮都启动一次受限的 `claude -p`。这样做有三个问题：

- 服务端要安装 Claude Code，每轮一个子进程和一个工作目录；
- 循环里的每一步只能经命令行参数、环境变量和事件日志间接控制；
- 对外不能用 Claude Code 的名义（M205）。

Claude Agent SDK 不解决这个问题：官方托管文档写明它为每个 session 启动一个 `claude` 子进程，运行时仍是 Claude Code。Managed Agents 由 Anthropic 托管循环与沙箱，但只接 Anthropic 的模型与 key，数据存储目前只在美国，与 M232 的模型渠道不合。

## 决定

1. **执行方式**：产品中的业务 Agent，每一轮由 RenderWeave 进程内的执行器驱动，执行器用 Anthropic Client SDK（`@anthropic-ai/sdk`）的 Tool Runner 完成"调模型、执行工具、回传结果"的循环。不用无头 Claude Code、Agent SDK 或 Managed Agents。
2. **工具**：工具全部由 RenderWeave 定义。
   - 领域工具沿用 MCP 工具合同；
   - 文件读写只在本轮工作目录内，服务化时换成工作副本存储；
   - 不提供命令行、通用代码执行、联网与本机环境操作，需要的能力做成领域工具。
3. **在哪里运行**：循环只在服务端运行，模型 key 只在宿主（ADR-0025）。桌面端与网页订阅事件流，展示轮次的执行过程（模型消息、思考摘要、工具调用、业务事件），不运行循环，也不持有 key。
4. **执行器接缝**：两种执行器按同一种事件形状记录。用量、停滞控制、额度停止与评估不区分执行器。
5. **过渡**：
   - 本机 `renderweave agent run` 的缺省执行器仍是 Claude Code，直到 Tool Runner 执行器在一次评估里跑满 M230 四个场景并通过门槛（空闲机器，全量测试通过），再把缺省改为 Tool Runner；
   - 之后 Claude Code 执行器保留一个版本作对照。

## 不变

- 模型可以替换（ADR-0003、M232）。
- 校验与渲染只有 RenderWeave 一处权威实现，Agent 只能经工具触达。
- 成果先校验再应用。
- 写入按角色授权，Agent 与人同能力（ADR-0022）。
- 渲染在 worker 进程里隔离（ADR-0017）。

## 取舍

得到的：

- 不依赖 Claude Code 的安装与子进程；
- 循环的每一步都在自己代码里，计量、停止、审计与过程展示都直接；
- 只要 Agent 没有代码执行与通用文件系统，就不必为每轮起容器；
- 对外品牌不受 Claude Code 名义的限制。

代价：

- **Claude Code 外壳里的隐含能力要自己补，并长期维护**：
  - 系统提示词（Claude Code 自带约 6,500 字符，原型自写短版）；
  - 上下文压缩（未做）；
  - 超长工具结果转存（靠 MCP 的 40,000 字符上限兜住）；
  - 读大图缩放（已补，Claude Code 缩到 1999 像素，原型缩到 2000 以内）；
  - OpenCode Go 要求的 `x-opencode-session` 请求头（已补）。
- **换运行时**：评估门槛要按新执行器重跑。
- **新增依赖**：`node_modules` 增大约 19 MB，候选冻结的一个用例因此超时。
- **接口稳定性**：Tool Runner 目前是 beta，接口可能变。

原型对照（同一构建，Claude Haiku 5.5）：
- 修好读图缩放后，M230 四个场景两边各 2/2 达线。
- 四个场景合计，Tool Runner 用时多 4%，输出 token 少 12%，缓存读少 6%。
- 四个场景分两次评估跑，所以还不算正式门槛结论。

## 切换条件

- **改用 Agent SDK**：正式门槛在 Tool Runner 上没过、在 Claude Code 上过了，且差距能归到 Claude Code 的外壳（提示词、上下文管理）时，产品改用 Agent SDK，每轮在一个隔离容器里运行。
- **加代码执行**：产品需要开放式代码执行（领域工具覆盖不了的数据处理）时，加一个在沙箱里执行的工具，另写 ADR。
- **改手写循环**：Tool Runner 的 beta 接口变动成本过高时，改为用同一 SDK 手写循环，接缝与事件形状不变。

## 托管给客户之前要补

- 威胁建模复核"去掉通用工具后不需要每轮容器"这一结论。
- 生产模型渠道：OpenCode Go 是单成员包月，不适合多客户，另行决定。
- 评估身份按执行器区分：现在 Tool Runner 的轮次也要求本机装有 Claude Code。
- 上下文压缩，长任务需要时加。
- 候选冻结用例超时。
