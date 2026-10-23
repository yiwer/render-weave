# 按区域纠偏

有宿主核查计划时使用本页。以已有 StaticSchema 和数据集承载内容，示例图只给视觉目标。

1. 读 design-checks.json 已声明的检查。若有 reference.targets，先核对命名区域的构图、主要元素占比、相对位置和层级；proposed 是待核准目标，写入设计依据和未确认项。没有 targets 时用默认 worstRegions 定位；没有 reference 时只执行声明的样式与边界检查，不调用 designTarget。只有 styles 中的明确规则属于硬检查；文字墨迹高度用来比较视觉比例，实际字号另用 inspect_layout 核对。
2. 首个可读骨架保存成果和 state.json 后立即 check_outcome。把目标、当前判断、指标和待办记在 scratch/visual-review.md；state 只保留关键决定、未解决项、下一步及该文件指针。checkpoint 缺失或无效时先补进度。
3. 有参考图时，技术检查通过后仍看视觉。选择一处最影响信息层级的区域；有命名区域时用 check_outcome({"designTarget":"区域ID"}) 取得目标、原图像素框、候选毫米框和路径，否则取 worstRegions 的框和路径。分别 view_image 原图区域、render_draft 候选区域，inspect_layout 只读有关路径。
4. 每次只改一个明确问题，例如顶栏内容的占比、站名字号层级或底栏两行的大小。保存被改路径及原属性值，然后更新 state.json、重新核查，比较同一区域和全图分数，并目视确认其他区域及内容没有退步。分数和目视均退步时恢复该次属性。
5. 同一任务最多两次局部纠偏，跨 --from 接续累计；次数写入 state 和详细记录，接续不重置，记录不可用时先核对历轮再继续。达到本轮预算、两次均无改进或遇引擎能力阻塞时，交回当前候选，notes 列具体剩余差异与未核准目标。用最后一次 check_outcome 留下当前候选的检查点；qualified 表示技术通过，像素分数没有通用及格线。

scratch/visual-review.md 保持 16000 字节以内；它随有效检查点恢复，其他 scratch 文件不自动交接。接续时先读 handoff，再按当前目标回读记录；每轮重新核查，旧指标不是新候选的证据。
