
这是本任务的第 {round} 轮：带着反馈，在上一轮的成果或宿主保存的完整检查点上继续做。以 previous/ 的记录识别来源，不假设上一轮已经人工批准。

1. docs/feedback.md 是审核人的反馈，本轮按它修改。反馈优先于上面列出的全部文档。
2. previous/ 是上一轮的原样记录，只作参考：
   - previous/candidates/ 是上一轮的成果，已含审核时的修改；
   - previous/outcome.json 是上一轮交回的待确认项、图上位置与说明（如有）；
   - previous/review.json 是审核人对待确认项的处理与意见（如有）；
   - previous/check.json 是 RenderWeave 对上一轮成果的校验结果。
   - previous/checkpoint.json 如存在，表示从宿主完整检查点接续，包含内容身份、被检查集合与问题；它不是正式交回或批准。
   - 检查点可能由操作者显式选择，未必是时间上最后一次；按其中 ID 和内容身份识别整套来源，不能把“有证据更好”解释为业务全部合格。
3. 模板任务已有预置工作副本时，先完成改前核对，再修改候选：
   - 列出 candidates/ 中的全部模板工作副本，调用 compare_reference 时用 templates 显式传入这份完整路径清单；本轮尚无 outcome.json 时同样这样调用。
   - 保持候选字节不变，从 regionOffset: 0 读取参考区域目录，沿每页的 nextRegionOffset 续取，直到返回 null；再用目录 ID 在 regions 中点查必修问题和被截断的详情。regions 与 regionOffset 分开调用；反馈点名区域的详情不能代替完整目录。
   - 取得完整改前目录和所需详情后再修正。没有核准参考而返回 notChecked 时，记录未核实范围，按反馈与本任务其余检查继续；目录中的 unknown 同样保留为未核实，不算通过。
4. 完成上述适用的改前核对后，反馈若只要求修正已有模板的局部，先按 guide.md 的“局部修改”规则确定授权属性，再继续：{seeds}
5. 模板修改后用全部当前工作副本重新 compare_reference，同样读完目录及所需详情，核对 resolved/new/remaining。
6. outcome.json 按本轮的成果重新写：
   - candidates 按本任务的交回规则列全；模板修改只列相对本轮已保存模板有改动的工作副本和新建模板；
   - 上一轮的待确认项已经由审核人处理过的不再列，仍拿不准的与新出现的照常列出；
   - 说明里逐条对应反馈，写改了什么。
   - 保存后用 check_outcome 终检，按本任务的交回规则处理剩余问题。
