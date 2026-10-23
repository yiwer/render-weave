# 可信反馈诊断与只读审核修复证据

严格修正范围没有放宽。评分器改为独立核对五个守卫，缺少证据以 `null` 和 `unchecked` 表示；已核对的失败仍为 `false`。缺目标路径不会替其他守卫制造失败。

公开 `readReview(roundDir, {persistArtifacts:false})` 保留候选、资源、内容身份与实际渲染校验，但不保存 checks 或 previews。有效缓存仍可返回图片；缺少缓存时内存渲染返回尺寸、问题和 assessment，省略不存在的 image 路径。默认交互审核不变。临时协调锁仍按正常过程取得并释放。

固定源码 `6d0ccc237cc37e56d8641cd0cf30ba1f6f1b5202`：Windows 4 文件 54 项通过（487.14 秒），Linux Node 22.23.3 同 54 项通过（320.9 秒），两平台 build/typecheck 通过；包括默认审核、资源身份和损坏缓存保护。完整命令、红绿日志、另存报告与哈希见 [证据索引](evidence.json)。

候选3的已封存首段只在新的独立恢复目录进行公开 CLI --rescore 和 8 次只读审核。原件与新恢复各 5,172 文件、977 目录的完整路径集合和 SHA 在读取前后相同。新评分身份另存报告，仍为 7 pass / 1 fail / 8 not-run；失败单元严格目标与非目标范围两项 false，未知保留、分页取证、终检身份三项 true。本次真实模型调用为 0，不将诊断当作候选4的观测，也不覆盖旧报告。

此前恢复证明只核对 manifest 已列文件，未发现默认审核额外创建的 checks/previews。最初 rescore 因旧恢复件已有额外 checks 被 seal 拒绝；mtime 证明额外文件早于该次 rescore，不能归因于它。旧失败日志及恢复目录保留，修正边界见 [历史恢复证明更正](../archive-restore-boundary-correction.md)。新的证明逐项枚举文件和目录，包含新增、缺失与修改三类变化。

`missing-red.log` 是夹具入口错误，不作产品红灯证据；修正公开 compiled CLI 接缝后的 `missing-red-02.log` 才复现诊断缺陷。
