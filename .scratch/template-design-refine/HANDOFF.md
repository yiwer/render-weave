# 模板设计页第三轮交接

2026-11-11。换设备或换人接着做第三轮票据时，先读本页；进度以各票据的 `**Status:**` 行为准，决定以 M 编号为准。

## 一句话

第三轮 01–07 已完成并合入 main，下一步从 08 开始。13、14 已按 [Pixso 对照](pixso-reference.md)补两条（M397）：`Shift+A` 是"包进容器并排"，舞台有焦点时 `Tab` / `Shift+Tab` 选同级。

## 位置与同步

| 项 | 值 |
|---|---|
| 分支 | `worktree-template-design-page` |
| 原设备 worktree | `E:\GenCode\render-weave\.claude\worktrees\template-design-page` |
| 基点 | `origin/main` `e64aae4`（2026-11-11 fetch；当时远端没有新提交可合） |
| 合入 | 分支已合入 main 并推送；新设备直接拉 main 即可 |
| 票据 | 01–07 `resolved`；08–16 `ready-for-agent` |
| 决定 | M395 第三轮方案、M396 拆票据、M397 Pixso 两条 |

## 这次交接改了什么

- **票据 13**：选中条的"包进容器"给"并排"与"上下"两个方向；`Shift+A` 等于并排。右键菜单原有的"包进容器"仍是纵排。三者调用 `wrapInContainer` 的同一份写回，方向只作参数。
- **票据 14**：快捷操作里收进同样的两个方向；加 `Tab` / `Shift+Tab` 选同级。焦点在舞台或页面空白时切换同级，焦点在输入框、按钮、选中条或面板里时 `Tab` 仍是正常焦点导航（票据 13 的选中条要能用 `Tab` 进入）。
- **[pixso-reference.md](pixso-reference.md)**：把两条标为已采纳（M397），其余候选保持原样。
- **[需求记录](../../docs/discovery/requirements.md) M397**：记下采纳依据、边界与不采纳项。
- **CONTEXT.md**：第三轮 01–07 记为已合入 main，下一步指向 08，文档地图加入本页。

## 验证

2026-11-11 在 worktree 的最终提交上跑：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，无输出 |
| `npm run typecheck:service` | 通过（`service` 与 `service/console` 两份配置） |
| `npm test -- --maxWorkers=4` | 126 个文件：117 通过、5 失败、4 跳过；1,922 项：1,852 通过、9 失败、61 跳过；用时 1,283 秒 |

9 项失败都在 `agent-*` 重型用例，原因与本轮改动无关：

- `test/agent-candidate-freeze.test.ts`：`EPERM` 建符号链接，Windows 没开开发者模式，见[开发环境](../../docs/dev-setup.md)「已知的坑」。
- `test/agent-budgets.test.ts`、`test/agent-eval-transcription.test.ts`、`test/agent-orders.test.ts`、`test/agent-stagnation.test.ts`：并行争用与超时（`local.storeBusy`、60 秒超时、`taskkill` 退出码 255）。按文档用 `--no-file-parallelism` 串行复跑的结果见下。

串行复跑（`--no-file-parallelism --maxWorkers=1`）：

```bash
npx vitest run test/agent-budgets.test.ts test/agent-eval-transcription.test.ts \
  test/agent-orders.test.ts test/agent-stagnation.test.ts \
  --no-file-parallelism --maxWorkers=1
```

- 4 个文件全过：83 通过、1 跳过（84），用时 890.62 秒。全量里这 4 个文件的 8 项并行争用 / 超时失败全部恢复，确认是并行争用而非代码问题。
- `agent-candidate-freeze` 未复跑：`EPERM` 是 Windows 符号链接权限，串行仍会失败，需开开发者模式后再跑。

没有跑的部分：

- **Docker 后端测试**：`node service/scripts/test-docker.mjs` 本轮没跑；它需要独立的 Compose 项目名与端口，见[开发环境](../../docs/dev-setup.md)「已知的坑」的 M386 一条。
- **浏览器用例**：没设 `RW_BROWSER`，`console.browser.test.ts` 52 项、`agent-jobs.browser.test.ts` 1 项、`deliver-parameters.browser.test.ts` 1 项跳过。做 13、14 时必须跑，先构建控制台并指向本机 Chromium。
- **真人走查与操作数**：票据 16 的 R10、R11 还没做。

主检出检查：合并前查过 `E:\GenCode\render-weave` 没有 `agent-eval`、`agent run` 或 `vitest` 进程；当时唯一的评估与测试子进程都在本 worktree，属于这次全量用例。

## 新设备怎么接

```bash
git pull
git worktree add ../render-weave-refine -b <新分支> main
cd ../render-weave-refine
npm ci
npm run fetch-fonts          # 新 worktree 没有字体
npm run build
npm run typecheck
npm run typecheck:service
npm test -- --maxWorkers=4
```

- 全量失败时先看是不是 `agent-*` 的并行争用，按上面的文件用 `--no-file-parallelism` 复跑；`EPERM` 是 Windows 符号链接权限，不是代码问题。
- 浏览器用例：构建控制台后设 `RW_BROWSER=<Chromium 可执行文件>`，跑 `service/test/console.browser.test.ts`。
- Docker 后端测试：`node service/scripts/test-docker.mjs`；同机别的检出在跑 Compose 时设 `COMPOSE_PROJECT_NAME` 与端口，别让两边互相 `down -v`。

## 接着做哪张

- **可以直接开**：08（一键建调用方传的参数）、09（一个弹层建参数 / 派生变量）、10（按字段是否为空显示）、11（新元素按父布局给尺寸）、12（运算数下拉）、15（样例带收起）。13 也已解除阻塞（07 已 resolved）。
- **13 完成后**：14（快捷操作与同级切换）。
- **最后**：16（第三轮验收，操作数 ≤ 70、真人走查与原型逐张对照）。
- 01–05 改检查器的同一组文件，06、07 改左面板；同一组文件建议一张合入再开下一张。
- 13、14 的键位边界照票据写，不扩成通用键位系统：`Shift+A` 只在舞台 / 页面空白生效；`Tab` 在同级切换与焦点导航之间按焦点位置分开。

## 已知限制与注意

- 主检出里未入库的 `service/console/src/prototype/`、`service/console/public/prototype/` 与 `service/console/prototype.html` 是旧原型材料，按规格明确"不复用也不删除"，不要提交。
- 原设备主检出里旧的第三轮文档改动（第三轮拆票前的版本）已被分支取代，合并前用 stash 留在原设备；新设备不需要它。
- `outside_context/` 不进版本库，本轮不需要；要核对旧实现的事实时再按 [CONTEXT](../../CONTEXT.md)「外部来源」准备。
- Agent 页这一轮只占位，P2 接入前不显示（M396）。
