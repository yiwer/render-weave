---
status: accepted
---

# 业务 Agent 以 Claude Code 无头运行，经兼容端点调用可替换模型，经只读 MCP 使用能力

业务 Agent 任务的每一轮是一次 Claude Code 无头运行（`claude -p`），由 RenderWeave 启动，轮与轮之间由 RenderWeave 保存状态。运行以受限模式进行：没有执行代码的工具，文件工具只能读写本轮的工作目录，只连接 RenderWeave 提供的 MCP 服务。工具仍是读取、校验、草稿预览、识别四类只读工具，草稿预览以图片内容块返回给模型。模型经 Anthropic 兼容端点调用，当前为千问 token plan 的 qwen3.8-max。凭据只经运行进程的环境变量注入；进程环境从空白开始，配置目录按轮独立，不继承宿主的凭据与配置。一轮的成果以工作目录中的文件交回，RenderWeave 校验结构、重新渲染前后预览，经人审核后才应用（ADR-0001）。

本 ADR 取代 ADR-0009，因为 CloudKiln 已不可用（M189）。ADR-0009 的核心不变：校验与渲染只有 RenderWeave 一处权威实现；agent 只能经只读工具触达 RenderWeave；成果以文件交回，经人审核。变的只是执行环境。

选 Claude Code 而不是自写 agent 循环，是因为它已经提供了工具调用循环、上下文管理、读图、MCP 客户端与受限模式。M190 实测这些能力经兼容端点对 Qwen 可用：示例图与工具返回的预览图都能读，渲染工具闭环可用（M209）。模型由端点与模型名决定，可以替换，延续 ADR-0003。

代价：

- 依赖 Claude Code 对非 Anthropic 模型的兼容行为，例如它的费用统计不认识模型名。升级 Claude Code 或换模型后，要复跑 `scripts/m190/run.mjs`（票据 08 起改为评估工具 `scripts/agent-eval/run.ts`，连续两次达线才算可用，见 [Agent 评估](../agent-eval.md)）。
- Claude Code 只是运行时，不是对外入口，也不以它的名义对外（M205）。
- 素材经过的外部服务变为千问 token plan 的模型服务，以及识别用的阿里云百炼。对外说明要同步更新。

尚未验证，须在阶段 4 前补上：

- 云上每轮一个独立容器，网络只放行模型端点与 MCP 地址。
- 本地验证用的 MCP 服务是同机子进程；服务化后，容器要经网络连接 RenderWeave 的 MCP 服务，否则就回到 ADR-0009 否决的"在沙箱里放第二份渲染器"。
- 凭据按轮签发与失效（M53、M54）。
- 并发与额度。

依据：M189、M190、M205、M209–M212；验证记录见 [Agent 运行方式验证](../agent-validation.md)。

## 修订（2026-10-16，M232）

模型改为经 OpenCode Go 调用：缺省 Claude Haiku 5.5（Anthropic 兼容端点），可选 Gemini 4 Argon；千问不再使用。本 ADR 的核心不变：仍是 Claude Code 无头运行、受限模式、只读 MCP、成果经人审核，换的只是端点与模型名，延续"模型可以替换"。

- **Gemini 只有 Google 接口**：`agent run` 在本进程里起一个转换代理，只绑定 127.0.0.1，随本轮结束关闭。Claude Code 连代理，环境变量里只有本轮随机令牌；上游 key 留在 RenderWeave 进程内。这比直接把 key 交给 Claude Code 更收紧。
- **素材经过的外部服务**改为 OpenCode，以及其后的模型提供方：Haiku 是 Anthropic，Gemini 是 Google。上文"代价"中千问 token plan 那一条由此取代，对外说明要同步更新。
- **两个模型都已在当前资料上通过评估门槛**，见[第三阶段验收](../stage3-acceptance.md#模型对比)。
