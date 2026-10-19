# 15: 还不是版本仓库的目录提示先 resources-init

**What to build:** `resources-import` 等命令遇到还不是资源版本仓库的目录时，问题说明要写明先执行哪条命令，不再只报 `ENOENT`。

**Blocked by:** 无

**Status:** resolved

**Trace:** [第三阶段验收](../../../docs/stage3-acceptance.md)「后续」第 3 条（第二阶段遗留）；需求记录 M166（资源版本仓库的准备与导入）；验收 A01。

背景（2026-10-19 实测，`node dist/bin.js resources-import --source fixtures/resources --resources <目录>`）：

- 目录不存在：`resource.writeFailed …：ENOENT: no such file or directory, realpath '…'`。
- 目录存在但为空：`input.unreadable …：资源清单无法读取：ENOENT: no such file or directory, lstat '…\resources.json'`。
- 两种都没有提示先执行 `resources-init`；同一个原因，导入报写入失败，打开报不可读。
- 第三阶段代建时，Agent 第一次 `deliver` 传的是旧版资源目录 `fixtures/resources`，报"需要 renderweave-resources/1 清单"，也没说怎么办（[第三阶段验收](../../../docs/stage3-acceptance.md)「返工点」）。

**决定**（实现时记 M 编号）：

- 只改说明，不让 `resources-import` 自动初始化：M166 把准备与导入分成两步，初始化绝不覆盖已有清单。导入时顺手建仓库，会把写错路径的导入变成静默新建。
- 打开已有仓库的入口统一先检查：`resources-import`、`resources-list`、`resources-get`、`resources-check`、`resources-apply`、`deliver`、`render --versions` 与对应的公开接口。
- 目录不存在、没有清单：都报 `input.unreadable`，说明写调用者给的路径和要执行的 `resources-init` 命令。
- 旧版资源目录当作版本仓库：说明写先新建仓库，再用 `resources-import --source <这个目录>` 导入。

- [x] 先写失败的测试：目录不存在、目录为空时，导入提示先 `resources-init`、不含 `ENOENT`、不留下文件；打开、列出、替换检查给同一条说明；旧版资源目录提示从它导入。
- [x] 已有用例不变；全量测试、类型检查、构建在 Windows 与 Linux 上通过。
- [x] 需求记录记 M 编号；[本地资源内容版本](../../../docs/resources-versioning.md) 写明；第三阶段验收「后续」与 `CONTEXT.md` 同步。

**测试接缝：** `test/versioned-resources.test.ts`，经 `runCli` 与公开接口 `openVersionedResourceStore`、`checkResourceReplacement` 进入。

**不在本票：** `render` 不带 `--versions` 时自动识别新旧仓库的行为（旧仓库照常可用于单次渲染）。

## Answer

2026-10-19 完成。决定见 M239。

**成果**

- `src/versioned-resources.ts` 新增 `storeRoot`：打开已有仓库前先取真实路径并检查清单。目录不存在或没有 `resources.json` 时报 `input.unreadable`，说明是"`<目录>` 还不是资源版本仓库（目录不存在 / 没有 resources.json）：先执行 renderweave resources-init --resources `<目录>`，再用 resources-import 导入资源"。`openVersionedResourceStore`、`checkResourceReplacement` 与写事务（导入、应用替换）都经它进入；初始化照旧先建目录。
- `loadManifest` 遇到旧版清单（没有 `format`、有 `resources` 列表）时，说明改为"是旧版资源目录，不是资源版本仓库：先用 renderweave resources-init 新建仓库，再执行 resources-import --source `<这个目录>` --resources <新仓库> 导入"。
- 文档：需求记录 M239；[本地资源内容版本](../../../docs/resources-versioning.md) 的 CLI 一节；[第三阶段验收](../../../docs/stage3-acceptance.md)「后续」与「验收后的变更」；[开发环境与接续](../../../docs/dev-setup.md) 的期望测试数。

**验证**

- **先写失败的测试**：`test/versioned-resources.test.ts` 新增「还不是版本仓库的目录提示先初始化（M239）」5 项，实现前全部变红（导入报 `resource.writeFailed`、说明不含 `resources-init`），实现后转绿。
- **实测**（`node dist/bin.js`）：
  - 不存在的目录：`[严重] input.unreadable …\missing\resources.json：…/missing 还不是资源版本仓库（目录不存在）：先执行 renderweave resources-init --resources …/missing，再用 resources-import 导入资源`，退出码 1；
  - 空目录：同样的说明，原因是"没有 resources.json"，目录里没有留下写锁或内容目录；
  - `resources-list --resources fixtures/resources`：提示是旧版资源目录，给出 `resources-import --source E:\GenCode\render-weave\fixtures\resources`。
- **Windows**：`npm run typecheck`、`npm run build` 退出码 0；`npm test` 39 个文件、789 项通过（原 784 项加新增 5 项）。
- **Linux**（`node:22-alpine`，从 tar 空目录安装）：785 项通过，4 项 Windows 专用用例跳过。
