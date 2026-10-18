工作目录中的 {sample} 是客户提供的示例图。你的任务：按已发布的数据定义 {definition}，把示例图上的业务数据转录为一份数据集，供模板出图。

要求：
1. 先读 docs/ 目录下的全部文档：
   - brief.md 是项目说明；
   - guide.md 是通用做法；
   - domain-*.md 是领域约定（如有）；
   - dsl-reference.md 是数据定义 DSL 与数据集格式；
   - outcome.md 是成果的交回格式；
   - request.json 是示例图对应的出图请求（如有，说明工作区中已有可用的模板）。

   三者冲突时，项目说明优先于领域约定，领域约定优先于通用做法。
2. 用 list_documents、read_document 读数据定义 {definition} 及它引用的定义，弄清每个字段的含义与约束。
3. 仔细查看示例图：先看整图，再用 view_image 分段放大，逐字核对；长列表逐项核对，不要跳读。
   - 图片类的值先用 list_resources 查看资源仓库，用 res: 引用。
4. 数据集写一份，放到 candidates/：dataset.staticSchema 写 {definition}；dataset.id 用英文或数字，不与工作区已有的数据集重复。
5. 用 check_dataset 校验，有问题就修改，直到没有问题；待确认的位置除外。
   - 有 request.json 时，用 render_draft 出草稿对照示例图：request 用 request.json 的内容，datasetPath 指向你的数据集。
6. 按 outcome.md 写 outcome.json：列出候选文件、值在图上的位置、待确认项与说明。看不清或推测的值都列为待确认项，候选值写在 candidate 里，不要当作确定的值。
7. 交回前用 check_outcome 核对：它按 RenderWeave 收到成果后的同一套规则检查 outcome.json 与候选文件。结论是 unqualified 时按问题修改，再核对，直到 qualified；deferred 中的问题落在待确认的位置上，留给审核，不用改。
