# 11: Agent 用 view_image 查看资源仓库中的图片

**What to build:** Agent 用 `view_image` 的 `res:<资源ID>` 查看资源仓库中图片资源的当前版本，与示例图对照后再引用，不再按资源 ID 推测图片内容。

**Blocked by:** 10

**Status:** resolved

**Trace:** 第三阶段 PRD 第 5、7 条（只读工具、识别能力的边界）；[第三阶段验收](../../../docs/stage3-acceptance.md) Spec 审查第 2 项、「后续」第 3 条；验收 A04、A10。

- [x] `view_image` 的 `path` 接受 `res:<资源ID>`：
  - 经工作区的资源仓库接口读图片资源，版本仓库取服务启动时的当前版本；
  - `region`、放大与输出和工作目录内的图片相同；PNG、JPEG、WebP、SVG 都能看；
  - 不开放资源仓库目录里的任意路径：`res:` 后面只能是资源 ID。
- [x] 未知资源 ID、字体资源、写法不对的 `res:` 作为工具错误返回，提示怎么改。
- [x] 资料：数据定义提取、数据集提取与模板辅助设计的提示词，以及通用指南的图标规则，写明用 `view_image` 看 `res:` 图片，与示例图对照后再引用。
- [x] 合同升到 0.5.0；工具清单快照只有 `view_image` 的说明与 `path` 描述变化；[MCP 工具服务](../../../docs/mcp.md)、需求记录 M234、`CONTEXT.md` 同步。
- [x] 全量测试、类型检查、构建通过。改了合同与资料，按 M230 跑评估门槛（Haiku 5.5），连续两次达线；366 转录的地标待确认项不再写"没能看图核对"。
- [x] key 扫描命中 0。

**测试接缝：** `test/mcp.test.ts` 经 `startMcp` 驱动 `renderweave mcp`；版本仓库经公开入口 `initializeResourceStore`、`importResources`、`checkResourceReplacement`、`applyResourceReplacement` 构造。

## Answer

2026-10-18 完成。决定见 M234。

**成果**

- `view_image`（`src/mcp/tools.ts`）：`path` 以 `res:` 开头时，经 `workspace.resources` 按资源 ID 读；`parseResourceRef` 只认资源 ID 的写法，其余一律报工具错误。
  - 解码用从 `ImageStore` 提出的 `loadResourceImage`（`src/images.ts`），未知 ID、字体资源与格式不受支持的报错与出图一致；
  - SVG 按放大后的尺寸栅格化，单边 8000、总数 1,600 万像素封顶。
- 合同 0.5.0；工具清单快照只变了 `view_image` 的说明与 `path` 描述。
- 资料：`agent/tasks/` 中数据定义提取、数据集提取与模板辅助设计三个提示词，`agent/guide.md` 第 6 条，`agent/domains/route-sign.md` 第 3 条。
- 文档：
  - [MCP 工具服务](../../../docs/mcp.md#查看资源图片)：新增「查看资源图片」，改了路径限制与合同版本，已知限制去掉"局部放大的范围"；
  - [业务 Agent 任务](../../../docs/agent-tasks.md) 的 `--resources`；
  - [Agent 评估](../../../docs/agent-eval.md#历次评估)；
  - [开发环境与接续](../../../docs/dev-setup.md) 的期望测试数；
  - [第三阶段验收](../../../docs/stage3-acceptance.md)「验收后的变更」；
  - 需求记录 M234。

**验证**

- **先写失败的测试**：`test/mcp.test.ts` 新增 3 项，连同版本号断言共 4 项先变红，实现后转绿。
  - `res:test-quadrants-png` 与工作目录里的同一张图，区域、放大倍数与输出 PNG 逐字节相同；地标 96 × 96 放大 4 倍；SVG 按原始尺寸 80 × 40 给区域，输出 320 × 160。
  - 未知 ID 报"资源仓库中没有图片资源"并提示 `list_resources`；字体资源报"是字体资源"；`res:../resources.json`、`res:images/…`、`res:` 都报写法不对。
  - 版本仓库：导入后替换为新内容（v2），服务读到的是 v2；内容不是图片时报格式不受支持。
- **目测**：SVG 整图与局部、地标 ② 的放大结果清晰，裁切位置正确。
- **Windows**：`npm run typecheck`、`npm run build` 退出码 0；`npm test` 39 个文件、752 项通过（输出在 `out/t11-windows-test.txt`）。
- **评估门槛**（Haiku 5.5，Claude Code 2.1.296，合同 0.5.0）通过，[2026-10-18-view-resource](../../../docs/agent-eval/reports/2026-10-18-view-resource.json)：
  - M402 数据定义 2/2（专家字段 14、15，约定 6、6）；M402 模板 2/2（压测 10、10，地标底线 0、0 mm）；366 2/2（站名 57、59，地标 15/15、15/15，设施 17/18、18/18）。
  - 8 轮都用 `res:` 看了资源图片，每轮 5–7 次，没有出错。
  - 366 两次数据集轮都没有地标待确认项，唯一的待确认项是"宝安北路南"。说明里写的是"带圈数字按资源图片对应""已用 view_image 与数字对照"；第 1 次还核对出资源仓库中的 M402 艺术字不是 366 的，第 2 次指出示例图的地铁图标与 `icon-metro` 不同。对照：票据 10 的四次 366 数据集轮中，三次写着"按资源 ID 推断，未见资源图片"。
- **key 扫描**：评估目录、评估日志加 `docs src scripts test agent .scratch`，600 个文件，命中 0。

**偏差**

- **Linux** 没有复跑。新增的 3 项不分平台，推断 Linux 上同样通过。
- **Gemini 4 Argon** 没有在 0.5.0 上复跑，用它之前要先跑一遍。
- **366 站名的余量**仍薄：第 1 次 57 正好在通过线上，与本票无关，是长站名看错字与"宝安北路南"的候选值。
- **`list_resources`** 的说明按快照约束没改，已知限制里"资源列表很简略"保留，只补一句"图片内容要逐个用 `view_image` 看"。
