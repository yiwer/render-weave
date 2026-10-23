工作目录中的 {sample} 是客户提供的设计稿（示例图）。你的任务：按修改要求修改工作区中已保存的模板 {template}。

要求：
1. 先读 docs/ 目录下的全部文档：
   - requirement.md 是本次的修改要求；写了元素路径的，指向已保存模板中的元素；
   - brief.md 是项目说明；
   - guide.md 是通用做法；
   - domain-*.md 是领域约定（如有）；
   - dsl-reference.md 是模板 DSL；
   - outcome.md 是成果的交回格式；
   - request.json 是示例图对应的出图请求：主模板 {template}，数据集是工作区中已保存的 {dataset}。

   冲突时，修改要求优先于项目说明，项目说明优先于领域约定，领域约定优先于通用做法。
2. candidates/ 中已放好可以修改的模板，都是已保存模板的原样复制：{templates}。直接在这些文件上修改。
   - 只改修改要求涉及的地方，其余保持原样；
   - 需要新的被调模板时另建文件，名称不与工作区已有的模板重复；
   - 不在上面列表里的模板不能改。
3. 改之前先用 render_draft 出一次修改前的草稿（request 用 request.json 的内容，不传 templates），对照示例图与修改要求，用 inspect_layout 找到问题所在的元素与实际尺寸。
   用 compare_reference（templates 列出预置工作副本）记录修改前的参考差异；notChecked 或 unknown 的部分列为未核实。
4. 修改后用 check_templates 做静态检查，再用 render_draft 出草稿：templates 列出 candidates/ 中的全部模板文件。
   - 用 inspect_layout 核对修改要求中的每一条；再用 compare_reference 比较改前改后的缺项、文字、尺寸、位置与颜色，沿 sourceLocation 修改源模板。新要求有意改变参考时，以修改要求为准并在 notes 解释差异；
   - 同一问题连续两次修正无进展时记录尝试与剩余差异，交回草稿；
   - 再按通用做法验证极端情况，可用内联数据集；与修改要求无关的既有问题只记入 notes，不顺手修复；
   - 以修改要求全部满足、本轮改动没有引入严重问题为目标；遇到能力阻塞时按 outcome.md 交回草稿。
5. 第一次写出修改后的候选就按 outcome.md 保存 outcome.json，并用 check_outcome 核对，之后每轮改完都更新它。outcome.json 的 candidates 只列改过的模板文件与新建的模板文件；locations 写改动的元素在图上的位置；拿不准的写成待确认项。说明里逐条对应修改要求，写改了什么、怎么核对的。
6. 交回前用 check_outcome 核对，按 outcome.md 中的评估分支决定修正或交回受阻草稿。qualified 只表示技术检查通过，修改范围仍需审核。
   - 逐项对照 revision 中的模板、元素路径与属性键，撤销无法对应修改要求的差异，再更新 outcome.json 并核对；
   - revision 截断时，用 read_document 读取已保存模板并与工作副本核对剩余差异，不能把未返回的部分当作没有改动。
