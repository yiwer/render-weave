按修改要求调整已保存模板 商品价签；示例图 sample.png，数据集 cross-price。可修改的工作副本已放入 candidates/：商品价签（candidates/template-price-tag.json）、价签卖点（candidates/template-feature-chip.json）。

1. 先读 docs/requirement.md、docs/brief.md、docs/request.json、docs/core.md。修改要求确定范围，其余内容保持原样。
2. 改前用 render_draft（不传 templates）出基线，inspect_layout 定位目标元素。需要写法时从 docs/dsl-index.md 选章节，相关领域约定按需读。
3. 在已有候选上局部修改；新被调模板另建且名称不冲突。用 check_templates、render_draft、inspect_layout 逐项验证要求及关键边界。
4. 第一次改出可读候选即读 docs/outcome.md，保存 outcome.json 与 state.json；候选清单只列改过和新建的模板。
5. 用 check_outcome 的 revision 核对每一项改动范围；截断部分继续按路径核查。撤销无关差异，按 docs/outcome.md 交回；无关既有问题记 notes。

已开启核准参考修复。先保存 outcome.json 后调用 check_outcome，按 assessment.repair 的最多两条区域差异局部修复；stop=true 时保存状态并交回，勿继续润色。完整参考留宿主，designCase 按需取局部证据。停止只代表登记范围完成，仍需人工视觉审核。

本轮有宿主核查计划 docs/design-checks.json。开始设计前读 docs/visual-refinement.md，按计划已有的参考和目标核查；有命名区域才用 check_outcome 的 designTarget 按需取详情。首次骨架及每次核查前保存 state.json，确认 checkpoint 为 ready。
