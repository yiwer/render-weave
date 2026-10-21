# 领域文档

工程类技能探索代码前如何读取本仓库的领域文档。本仓库是 single-context：一个根目录 `GLOSSARY.md` 加 `docs/adr/`，外加本仓库特有的 M 编号决定记录。

## 探索前先读

1. `GLOSSARY.md`：唯一的术语事实源。以中文术语为准，括号里的英文名供代码命名参考。
2. `docs/adr/`：读与本次改动相关的 ADR。状态看各文件 frontmatter 的 `status`；ADR-0005 已被 ADR-0008 取代，ADR-0009 已被 ADR-0015 取代；ADR-0015 的只读 MCP 边界与 M53、M205 的“Agent 不能发布/写入只经提案”已被 ADR-0022 修订。
3. `docs/discovery/requirements.md`：M 编号逐条决定，大部分决定都在这里，没写成 ADR。按主题词或编号 grep，不必通读。
4. 需要实体关系或元素属性时，读 `docs/model/business-entities.md` 与 `docs/model/template-elements.md`。这两份含未来设计；当前可执行的能力以 `CONTEXT.md`「已实现能力」为准。

## 术语表里没有的概念

`GLOSSARY.md` 没有收录的概念有两种可能：一是在发明项目不用的说法，应改用已有术语；二是确实存在缺口，交给 `/domain-modeling` 补上。

## 冲突时明说

产出与已有 ADR 或 M 编号决定矛盾时，明确指出，不要静默覆盖：

> _与 ADR-0007（模板地位平等）冲突，但值得重新讨论，因为……_
