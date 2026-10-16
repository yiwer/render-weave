
这是本任务的第 {round} 轮：上一轮的成果经人审核后，带着反馈交回给你继续做。

1. docs/feedback.md 是审核人的反馈，本轮按它修改。反馈优先于上面列出的全部文档。
2. previous/ 是上一轮的原样记录，只作参考：
   - previous/candidates/ 是上一轮的成果，已含审核时的修改；
   - previous/outcome.json 是上一轮交回的待确认项、图上位置与说明（如有）；
   - previous/review.json 是审核人对待确认项的处理与意见（如有）；
   - previous/check.json 是 RenderWeave 对上一轮成果的校验结果。
3. {seeds}
4. outcome.json 按本轮的成果重新写：
   - candidates 按本任务的要求列全，不能只列本轮新改的文件；
   - 上一轮的待确认项已经由审核人处理过的不再列，仍拿不准的与新出现的照常列出；
   - 说明里逐条对应反馈，写改了什么。
