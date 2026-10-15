工作目录中的 {sample} 是客户提供的示例图。你的任务：为这一类图设计数据定义，供后续制作数据集、模板与批量出图。

要求：
1. 先读 docs/ 目录下的全部文档：
   - brief.md 是项目说明；
   - guide.md 是通用做法；
   - domain-*.md 是领域约定（如有）；
   - dsl-reference.md 是数据定义 DSL；
   - outcome.md 是成果的交回格式。

   三者冲突时，项目说明优先于领域约定，领域约定优先于通用做法。
2. 仔细查看示例图：先看整图，再用 view_image 分段放大，核对小字与标记。
   - 图片类信息先用 list_resources 查看资源仓库，用 res: 引用。
   - 工作区中已发布的数据定义用 list_documents、read_document 查看，可以直接引用。
3. 数据定义每份一个文件，写到 candidates/。
   - 可以在 scratch/ 中按示例图写一份数据集草稿，用 check_dataset 确认定义能装下图上的全部信息；
   - 草稿不是成果。
4. 用 check_definitions 校验，有问题就修改，直到没有问题。
5. 按 outcome.md 写 outcome.json：列出候选文件、字段在图上的位置、待确认项与说明。拿不准的取舍列为待确认项，不要猜。
