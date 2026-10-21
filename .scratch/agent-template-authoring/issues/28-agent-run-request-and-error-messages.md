# 28: `agent run` 先校验出图请求再开始，用满轮数时不打印空的报错

**What to build:** 出图请求不合格（如缺 `mode`）时，`agent run` 在打印"开始……"之前就报用法错误；文档写明 `mode` 必填。轮次用满轮数结束时，标准错误流说明"用满了轮数上限"，不再打印内容为空的"模型服务报错："。

**Blocked by:** 无

**Status:** resolved

**Trace:** M226（发起与成果）；2026-10-20 阿拉伯文站牌试跑。

背景（2026-10-20，`out/arabic-board/`，不进版本库）：

- 出图请求没写 `mode` 时，命令先打印"开始模板辅助设计：轮次目录 …"，再报"出图请求不合格：模式只能是 draft（草稿预览）或 final（正式出图）"，退出码 2、没建轮次目录（`src/agent/run.ts:502`）。看起来像已经开始了。`docs/agent-tasks.md` 的选项表只写"主模板名、对外参数与输出尺寸"，没说 `mode` 必填。
- 第 5 轮用满 80 轮（`endedBy: error_max_turns`）时，标准错误流里有一行"模型服务报错："，冒号后为空。

**决定**：

- 读取与规范化出图请求放在打印"开始……"之前；仍是用法错误、退出码 2、不建轮次目录。
- `docs/agent-tasks.md` 的 `--request` 说明写明请求要有 `mode`（`draft` 或 `final`），与渲染请求相同。
- 只有确有错误文字时才打印"模型服务报错：…"；`endedBy` 为 `error_max_turns` 时打印"用满了轮数上限（N 轮）"，并提示可以用 `--from` 带反馈接着做。

- [x] 缺 `mode` 的请求：标准错误流第一行就是"出图请求不合格"，没有"开始……"，退出码 2，不建轮次目录。
- [x] 假 Claude Code 以 `error_max_turns` 结束：标准错误流有"用满了轮数上限"，没有空的"模型服务报错："。
- [x] 文档更新；全量 `npm test` 通过。

**测试接缝：** `test/agent-rounds.test.ts` 经 `runCli` 与 `test/support/fake-claude.mjs`，不调用模型、不读 key。

## Answer

2026-10-20 完成。

- **代码**：
  - `runAgentTask` 新增 `onStart`，在输入全部校验通过、建轮次目录之前调用；命令行在这里打印"开始……"（`src/agent/run.ts`、`src/cli.ts`）；
  - 结果消息 `is_error` 为真时，用满轮数写成"用满了轮数上限（N 轮）；没有交回成果时，可以用 --from 带反馈接着做"；没有报错文字时写"Claude Code 以 … 结束，没有给出原因"，不再是空的"模型服务报错："。
- **用例**：`test/agent-rounds.test.ts`「agent run 先校验出图请求再开始，用满轮数时说明原因（票据 28）」两项。缺 `mode` 时标准错误流以"出图请求不合格"开头、没有"开始"、不建目录；假执行器模拟 `error_max_turns`（`test/support/fake-claude.mjs` 的 `.max-turns`）。
- **文档**：`docs/agent-tasks.md` 的 `--request` 写明 `mode` 必填，退出码表补了这两种情况。
- **验证**：全量 `npm test` 951 项通过。
- **偏差**：评估脚本按 `run.error` 分类上游错误（票据 21）。新的文字里没有瞬时或额度字样，仍归"其他"，行为不变。
