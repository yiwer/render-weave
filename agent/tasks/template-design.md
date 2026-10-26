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
3. 写模板，每个模板一个文件，放到 candidates/：主模板名为 {template}，基准是 {definition}；被调模板自行命名，名称不与工作区已有的模板重复。分段写：
   - 先写主模板的骨架（画板与几大区块），用 check_templates 做静态检查，再用 render_draft 出草稿：request 用 request.json 的内容，templates 列出你写的全部模板文件；
   - 再一段一段加内容，内容多的区块拆成被调模板；每加一段就检查、出草稿，并用 compare_reference 检查当前候选（templates 列出全部候选）；
   - 问题很多时，结果只列前面一部分，另有按问题代码的计数（problemsTruncated）：先按问题代码成批修改。
4. 写出可读骨架后就按 outcome.md 保存 outcome.json，并用 check_outcome 核对；每轮改完都更新它。
5. 对照示例图与问题清单修改：
   - compare_reference 返回核准范围内的缺项、文字、毫米位置与尺寸、颜色差异，以及参考/候选/叠图。优先处理缺项，再修尺寸和位置；沿 sourceLocation 找源模板，path 指向本次展开的实例；
   - 修改后重查，核对 changes 的已消除、新增、仍存在问题；同一问题连续两次修正仍无进展时，在 notes 留下尝试与剩余差异；
   - notChecked 表示没有可用参考或尺度未对齐；unknown 和未覆盖区域保留待审核。骨架零渲染错误只表示能出草稿；
   - 元素的位置、字号与压缩比用 inspect_layout 查；
   - 再按 guide.md 第14条构造保留项内内容的边界输入，验证极端情况与内容有无分支；
   - 以没有严重问题、版面与示例图基本一致为目标；遇到已知能力阻塞时按 outcome.md 交回草稿。
6. outcome.json 列出全部模板文件、元素在图上的位置、待确认项与说明。与示例图仍有的差异写在说明里。
7. 交回前用 check_outcome 核对，按 outcome.md 中的评估分支决定修正或交回受阻草稿；在 notes 中如实列出仍未核实的内容与样式。
