# 10: 推送不再覆盖网页上保存的模板，代建工程师用 `renderweave pull` 取回最新内容

**What to build:** 推送清单给模板加可选的 `baseRevision`，服务端据此或据当前修订的来源判定冲突；新增 `renderweave pull` 把租户当前的模板、静态数据定义与编译产物写回本地工作区，并记下修订号供下次推送。

**Blocked by:** 07

**Status:** ready-for-agent

**Trace:** [P1 PRD](../spec.md)「推送与网页改动共存」；用户故事 30、31；验收 A09；M264、M265。

- [ ] 带 `baseRevision`：当前修订不等于它且内容不同，算冲突。不带：当前修订来自网页保存、指回或批准且内容不同，算冲突。只用推送的租户行为不变。
- [ ] 冲突照 M264 整体拒绝（409 `push.conflict`），说明当前修订由谁在何时、以哪种来源产生。
- [ ] `renderweave pull --server --tenant --workspace`：写入模板、静态数据定义与编译产物；本地已有且内容不同的文件先列出，`--overwrite` 才覆盖。
- [ ] 每次推送或拉取成功后在本地记下各模板的修订号，下次推送自动带上；这份记录不让本地读工作区与 `renderweave render` 报问题。
- [ ] 令牌只经环境变量传入，规则同 `push`；`pull` 记审计。
- [ ] [代建指南](../../../docs/agent-guide.md)与[出图服务](../../../docs/service.md#代建推送)补上拉取这一步与新的冲突规则；决定记 M 编号。

**测试接缝：** 命令行 `push`、`pull` 对进程内服务（内存后端）跑；网页一侧的保存与指回经开放 API 制造。
