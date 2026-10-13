# 09: 一批草稿展示问题并与正式交付清楚区分

**What to build:** 同一批渲染项可以先生成草稿核对，再以正式模式运行；草稿中的占位和问题边框可用，草稿成功不被误认成正式成品。

**Blocked by:** 08：35 个本站逐项正式交付，错误项不拖累整批

**Status:** resolved

**Trace:** 第二阶段 PRD；用户故事 23、24、28；验收 A06、A07。

- [x] 批次统一选择草稿模式，不能按项混用；合法内容、有严重问题但可展开、完全无法展开三类项都得到明确的逐项结果。
- [x] 可展开的严重问题项保留草稿图片、问题清单和实际草稿摘要；无法展开项失败，其余继续。
- [x] 同一输入分别运行草稿与正式批次，公共诊断一致；正式严重问题无交付图片，草稿有清楚模式标识。
- [x] 草稿不产生正式出图记录；全部预览成果完整可返回 0，但汇总保留严重问题数量，不能称为可交付成品。
- [x] API、CLI、用法示例和入口测试一起完成，沿用逐项释放、固定输入及目标保护。

**测试接缝：** 优先通过本票涉及的公开渲染、资源管理、交付或重放入口观察外部行为，CLI 验证参数、退出码与文件成果；不测试私有中间结构。需要的小范围预重构先做并保持已有测试通过，再完成本票行为。

## Answer

2026-10-13 完成。

- 批次 `mode` 可取 `draft`，整批统一；渲染项带 `mode` 或模式值非法时整批拒绝（M185）。草稿逐项沿用单次渲染规则，结果分三类：
  - 合法项：`previewed`。
  - 可展开的严重问题项（本站 36、某站缺站名）：`previewed`，保留草稿图片、问题清单和实际占位布局。
  - 无法展开项：`failed`。
- 草稿与正式成品分开（M186）：
  - 状态为 `previewed`，图片为 `draft.png`。
  - 最后发布 `preview.json`（`renderweave-preview/1`），不生成出图记录；`record-read`、`replay` 拒绝。
  - 记录读取另外要求批次模式为 final。
- summary 增加 `previewed`、`severe`、`hints`，返回值带 `mode`（M187）。CLI 草稿全部预览完整时返回 0，并另行提示含严重问题、不是可交付成品；有失败项时返回 1。
- `test/batch-draft.test.ts` 新增 3 项：
  - 同一输入草稿/正式两批的三类项、问题清单逐项一致、草稿文件与 preview 哈希、无记录。
  - 模式统一与目标保护。
  - CLI 退出码与提示。
  - 原批量测试按新的 summary 字段调整。
- 全量 `npm test`（无外部负载时）为 28 个文件、606 项通过；`npm run typecheck`、`npm run build` 通过。
- `node scripts/accept-batch.mjs out/stage2/batch-windows`（Windows，Node v24.21.0）新增草稿部分，结果如下：
  - 样例草稿批次退出码 1，本站 1、35、36 已预览，`wrong-schema` 失败。
  - 同一请求按 final 运行时，逐项 `problems.json` 与草稿相同，本站 36 无图片。
  - 本站 1 的草稿图与正式图哈希相同。
  - 去掉无法展开项后退出码 0，汇总 1 个严重问题，并有不可交付提示。
- Docker `node:22-alpine`（Linux，Node v22.23.3）用同一构建复跑同一脚本：35 项正式图、草稿图、问题清单和草稿布局摘要与 Windows 逐字节一致，各退出码相同。
- 用法与合同见[出图记录说明](../../../docs/output-records.md#草稿批次)，样例为 `docs/examples/output-record/m402-draft-batch-request.json`。

遗留：Docker 同时大量写盘时，全量测试两次偶发 Windows 资源清单 `rename` 的 EPERM，超出 M179 的有界重试。一次是 `versioned-resources.test.ts` 的短暂 EPERM 用例，一次是 `record-closure.test.ts` 的导入前置。本票未改资源版本代码，无负载时全量通过，外部占用者仍未知。
