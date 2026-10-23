为已发布的 {definition} 设计模板：使用已有数据集 {dataset}，主模板名 {template}，示例图 {sample}。按项目说明还原版式并覆盖约定的数据/尺寸范围。

1. 先读 docs/brief.md、docs/request.json、docs/core.md。用 read_document 读所选 StaticSchema 与数据集；按需查看示例图、资源与 docs/domain-*.md。
2. 需要 DSL 写法时读 docs/dsl-index.md，再取对应章节；需要 Schema 精确键时用 dsl_reference 的 schema/* pointer。
3. 在 candidates/ 写首个可读骨架，读 docs/outcome.md 保存 outcome.json 与 state.json，立即调用 check_outcome 建立检查点，再分区补全。
4. 用 inspect_layout 与图像对照核查物理尺寸和视觉层级，按核心要求验证范围；每次改完更新成果和 state.json。
5. 交回前用 check_outcome 核对并按 docs/outcome.md 的分支修正或交回受阻草稿，notes 列明未覆盖项。
