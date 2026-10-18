工作目录中的 {sample} 是客户提供的设计稿（示例图）。你的任务：为已发布的数据定义 {definition} 制作模板，使按出图请求出的图尽量还原示例图，并能服务项目说明中的目标范围。

要求：
1. 先读 docs/ 目录下的全部文档：
   - brief.md 是项目说明；
   - guide.md 是通用做法；
   - domain-*.md 是领域约定（如有）；
   - dsl-reference.md 是模板 DSL；
   - outcome.md 是成果的交回格式；
   - request.json 是示例图对应的出图请求：主模板名 {template}、对外参数与输出尺寸都以它为准，数据集是工作区中已保存的 {dataset}。

   三者冲突时，项目说明优先于领域约定，领域约定优先于通用做法。
2. 用 list_documents、read_document 读数据定义与数据集 {dataset}；查看示例图，细节用 view_image 放大；用 list_resources 查看可用的字体与图片资源，图片资源用 view_image 查看（path 写 res:资源ID）。
3. 写模板，每个模板一个文件，放到 candidates/：主模板名为 {template}，基准是 {definition}；被调模板自行命名，名称不与工作区已有的模板重复。
4. 先用 check_templates 做静态检查，再用 render_draft 出草稿：request 用 request.json 的内容，templates 列出你写的全部模板文件。
   - 对照示例图与问题清单修改；元素的位置、字号与压缩比用 inspect_layout 查。
   - 再按通用做法验证极端情况，可用内联数据集。
   - 直到没有严重问题、版面与示例图基本一致。
5. 按 outcome.md 写 outcome.json：列出全部模板文件、元素在图上的位置、待确认项与说明。与示例图仍有的差异写在说明里。
6. 交回前用 check_outcome 核对：它按 RenderWeave 收到成果后的同一套规则检查 outcome.json 与候选文件，包括待确认项与图上位置中的元素路径是否还在模板里。结论是 unqualified 时按问题修改，再核对，直到 qualified。
