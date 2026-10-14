# 13: 全新环境完成交付、重放与阶段验收

**What to build:** 在 Windows 与 Linux 全新环境重跑本阶段全部验收，新使用者按中文指南走通一次闭环，产出阶段验收记录并判断第二阶段能否结束。

**Blocked by:** 09：一批草稿展示问题并与正式交付清楚区分；10：停止长批次并辨认中断后的完整成果；11：千项交付节省重复素材且内存不随图片累积；12：码图模板正式交付，换素材后旧记录仍能重放

**Status:** resolved

**Trace:** 第二阶段 PRD；用户故事 14、47、48、49、50；验收 A01–A15（汇总）、A14、A15（本票实测）。2026-10-13 按 M188 收窄。

- [x] 开工前确认 M179 的 Windows 资源清单 EPERM 排查结论；仍会偶发时如实写入验收记录，不靠重跑掩盖。
- [x] Windows 与 Linux 各在空目录（Linux 用容器内 `npm ci`，不挂载宿主 `node_modules`）安装锁定依赖、下载固定字体、构建，跑全量测试、类型检查和全部 `scripts/accept-*.mjs`。
- [x] 比较两平台的 M402、码图与记录重放的图片及布局哈希，以及构建标识的一致性；时间与路径不参与比较。
- [x] 在临时工作区照中文指南完成资源导入、35 项批次、一次失败定位、一次资源替换和独立重放，记录实际命令、退出码与成果（A15）。
- [x] A01–A13 引用各票 `## Answer` 与上一条的脚本结果作证据，不逐项重新设计验收。
- [x] 完成 Standards 与 Spec 两轴代码审查并处理阻断项；阶段验收文档区分已验证能力、本地边界与后续服务隔离要求，更新"当前能力"，不把服务、Agent、动态模板或远程图片写成已支持。

**测试接缝：** 只运行既有测试与验收脚本、按指南操作 CLI；本票不新增引擎能力。

## Answer

2026-10-13 完成。阶段验收文档：[docs/stage2-acceptance.md](../../../docs/stage2-acceptance.md)，决定记为 M201–M203。结论：第二阶段验收通过，可以结束。

- **EPERM**：按 M200 修复。`scripts/stress-resource-commit.mjs` 跑 960 次初始化加首次导入，两个平台都是 0 失败（Windows 5.1 秒，Linux 3.9 秒）；Windows 全新环境全量测试无 EPERM。
- **全新环境**：同一工作树快照分别解包到空目录。
  - Windows：Node v24.21.0。Linux：Docker `node:22-alpine`，Node v22.23.3，容器内 `npm ci`，不挂载宿主 `node_modules`。
  - 两边的 `npm ci`、`fetch-fonts`、`build`、`typecheck` 退出码都是 0。
  - `CI=1 npm test`：Windows 31 个文件、622 项通过；Linux 619 项通过，3 项仅限 Windows 的 EPERM 重试用例跳过。
  - 新增 `scripts/accept-stage2.mjs` 依次运行全部 13 个 `accept-*` 脚本、`check-svg-platform` 与资源提交压测，15 步在两个平台都是退出码 0。
- **跨平台**：`node scripts/compare-platforms.mjs` 输出"PASS：441 个文件逐字节一致，构建标识相同"。
  - 比较范围：图片、布局摘要、问题清单、出图记录、批次、预览与重放清单。构建标识为 `sha256:b1232846…`。
  - M402 基准图片 `785e0aad…` 与布局 `d8b398bf…` 和首期记录相同。
  - 两个平台用各自的全新构建互相重放对方交付的 M402 第 35 项与码图牌记录，4 次均为退出码 0。
- **A12 复跑**：1,000 项 RSS 中位数增长 Windows 6.0 MiB、Linux 0.9 MiB；磁盘实际 612 MiB（独立复制需 33,251 MiB）；源输入不变。
- **A15**：新增中文[使用指南](../../../docs/guide.md)，README 已链接。两个平台在全新检出中逐条照做：导入、35 项交付、混合批次定位 4 个失败项、检查后替换 `icon-metro`、改名原工作区与仓库后重放。每条命令的退出码与指南一致，Windows 用时 57 秒，Linux 54 秒。
- **A01–A13**：按验收文档「A01–A15 汇总」引用各票 Answer 与本次复跑结果。
- **两轴审查**：无阻断项。
  - 已修正：英文注释、CLI 头注释缺退出码、README 与资源版本说明中的过期描述。
  - 两套资源引用遍历（Standards P2）已在验收后由 `8e8fe11` 处理，见下方 Comments 与验收文档「验收后的重构」。
  - 转后续任务：批量项缺数据集时报 `record.invalid`（Spec P2）；码图布局有重复代码（P3）。
- **偏差**：
  - 两个平台运行的快照只差 `scripts/accept-stage2.mjs` 的指纹收集部分。本票中修正了两处收集问题：把请求文件误认作批次清单，以及相对文档路径的分隔符不同。Windows 的成果用修正后的脚本 `--collect-only` 重新收集，未重跑验收；被测的引擎、测试与依赖完全相同。
  - 两个平台的长批次部分时段同时运行，同机还有另一个会话在跑测试，耗时只作参考。
  - A15 由实施者照文档执行，不是真实用户的可用性研究。
- **证据**：`out/stage2/fresh/`（不进版本库）。

## Comments

- 2026-10-13（M200）：第一条的 EPERM 已查明并修复。根因是初始化以硬链接发布清单，Windows 上偶发使首次导入无法替换清单。回归门槛 `node scripts/stress-resource-commit.mjs` 须在两个平台通过；修复后 Windows 全量连续 6 轮无 EPERM。
- 2026-10-13：Standards 轴 P2（Duplicated Code / Shotgun Surgery）已处理。出图记录收集资源种类与替换影响检查原先各自遍历模板和数据集中的资源引用，现共用 `src/resource-references.ts`；新增可写资源的元素只改这一处。纯重构，全量测试、类型检查、构建与 `accept-coded-sign`、`accept-resource-replacement` 均通过，三份替换检查报告的引用位置与重构前逐项相同。Linux 复核用 `node:22-alpine`（Node v22.23.3），容器内重新 `npm ci`，不挂载宿主依赖：619 项通过，3 项 Windows 专属 EPERM 用例跳过；两个验收脚本的 `hashes.json` 和 `evidence.json` 与 Windows（Node v24.21.0）逐项一致。
