---
status: superseded by ADR-0015
---

# 业务 Agent 任务在 CloudKiln 云沙箱执行，经只读 MCP 使用能力，成果以文件交回

业务 Agent 任务的每一轮作为一个 CloudKiln Task 在云沙箱中执行，RenderWeave 是它的调用方。执行 agent 通过 RenderWeave 构建的 MCP 服务使用读取、校验、草稿预览与识别四类只读工具，凭据按轮签发、只覆盖本任务相关的对象、随任务结束失效；OCR 也经识别工具调用，结果作为识别结果记录并复用。一轮的成果以 CloudKiln 产物文件（`outcome.json` 与说明）交回，由 RenderWeave 校验结构、重新渲染修改前后预览，经人审核后才应用到数据定义、数据集或模板。多轮交互拆成多个批处理 Task，轮与轮之间由 RenderWeave 保存状态。

这样落实了 ADR-0001"渲染由系统提供、agent 可调用"：沙箱中不放第二份渲染器，校验与渲染只有一处权威实现；CloudKiln 只保证执行与文件交付、业务验收归调用方，正好由 RenderWeave 承担；agent 除只读工具外无法触达 RenderWeave，"不能保存、发布、删除、正式出图"的边界由工具清单与网络隔离直接保证；执行 agent 的选择留在 CloudKiln 配置中，延续 ADR-0003 的可替换要求。备选的"把渲染器装进环境镜像"需要两边保持同一构建、逐个传入资源文件，未被采用。代价是依赖 CloudKiln 尚未实现的 MCP 支持，沙箱需放行 RenderWeave 的 MCP 地址；素材会经过阿里云百炼、CloudKiln 云沙箱与 DeepSeek 模型服务；执行模型能否看图尚未验证，若不能，agent 只能依据问题清单而非预览图自查版式。

依据：2026-10-08 建模草稿讨论 M42–M59，见[需求探索记录](../discovery/requirements.md)；CloudKiln 与 Qwen-OCR 核查见同文档"已核查事实"。
