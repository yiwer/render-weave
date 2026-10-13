# Issue tracker：本地 Markdown

本仓库的规格与票据是 `.scratch/` 下的 Markdown 文件。remote 虽在 GitHub，但不使用 GitHub Issues。

## 目录

- 一个功能一个目录：`.scratch/<feature-slug>/`。当前阶段对应哪个目录，看 `CONTEXT.md`「当前阶段与下一步」。
- 规格：`.scratch/<feature-slug>/spec.md`，开头两行是 `Status:` 与 `Category:`（`bug` / `enhancement`）。
- 票据：每张一个文件 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号；不把多张票合进一个文件。
- 索引：`.scratch/<feature-slug>/README.md` 只列标题、直接阻塞与验收映射，不写状态，也不写进度日志。

## 票据格式

```md
# NN: <用户可见的完整行为>

**What to build:** <一句话>

**Blocked by:** NN、NN（没有写"无"）

**Status:** ready-for-agent

**Trace:** <父规格>；用户故事 …；验收 A…。

- [ ] <可核对的验收条目>

**测试接缝：** <只写本票特有的入口；通用规则见 `CODING_STANDARDS.md`>
```

- `**Status:**` 的取值见 `triage-labels.md`。这是票据状态的唯一事实源。
- 讨论与用户确认追加在文件末尾的 `## Comments` 下。

## 领取票据

可领取的票据是 `**Status:** ready-for-agent`，且 `**Blocked by:**` 所列票据全部 `resolved`。有多张时取编号最小的一张。

## 关闭票据

按顺序：

1. 把验收条目勾为 `- [x]`。
2. 在 `## Comments` 之前追加 `## Answer`：完成日期、跑过的命令与结果、成果路径、对验收的偏差。
3. 把 `**Status:**` 改为 `resolved`。
4. 更新 `CONTEXT.md`「当前阶段与下一步」，能力有增减时再改「已实现能力」。索引页、规格和其他文档不写状态。

## 技能操作映射

- "publish to the issue tracker"：在 `.scratch/<feature-slug>/` 下新建文件，目录不存在则创建。
- "fetch the relevant ticket"：读对应路径。用户通常直接给路径或"票据 08"这样的编号；只给编号时，在当前阶段目录的 `issues/` 中查找。

## Wayfinding operations

供 `/wayfinder` 使用。**map** 是一个文件，每张 **child** 票据各一个文件。

- **Map**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog）。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题。`Type:` 行记票据类型（`research`/`prototype`/`grilling`/`task`），`Status:` 行记 `claimed`/`resolved`。
- **Blocking**：顶部一行 `Blocked by: NN, NN`。所列文件全部 `resolved` 即解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/`，取未完成、未阻塞、未认领的票据，编号最小者优先。
- **Claim**：开工前先设 `Status: claimed` 并保存。
- **Resolve**：在 `## Answer` 下写答案，设 `Status: resolved`，再把要点加链接追加到 `map.md` 的 Decisions-so-far。
