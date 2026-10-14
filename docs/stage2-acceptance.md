# 第二阶段验收：本地生产出图与可复现交付

结论：第二阶段验收通过，可以结束。

- **两个平台全新环境复跑**：Windows 与 Linux 各从同一份代码在空目录安装锁定依赖、下载固定字体并构建。类型检查、全量测试（31 个文件、622 项；Linux 跳过 3 项仅限 Windows 的用例）和全部 15 个验收步骤均通过。
- **跨平台一致**：
  - 两个平台的 441 个成果文件逐字节一致，构建标识相同。出图记录去掉文档路径后比较。
  - 两边各自的全新构建互相重放对方交付的出图记录，结果均一致。
- **使用指南**：在两个平台各照做一遍，每条命令的退出码都与指南写明的一致。
- **两轴审查**：没有阻断项，2 项 P2 转为后续任务。

## 范围与判定

- **规格与决定**：[第二阶段 PRD](../.scratch/local-production-output/spec.md)、[票据 01–13](../.scratch/local-production-output/issues/)；实施决定见需求记录 M150–M203。
- **审查范围**：
  - 基线 `09524f1`（PRD 与票据发布），终点为本票提交。
  - 命令 `git diff 09524f1...HEAD`：源码 26 个文件 +1,954/−34 行，测试与脚本 30 个文件 +3,221 行。
- **验证代码**：两个平台运行的是同一份引擎与测试，提交后可用 `git rev-parse HEAD:src` 等命令核对子树号。
  - `src`、`test` 子树分别为 `456419ff`、`a100f205`；`package.json`、`package-lock.json` 分别为 `7ecc9cee`、`4e6768b2`。
  - Windows 运行工作树快照 T2 `2b59069e`，Linux 运行 T4 `236da0ae`。两者只差 `scripts/accept-stage2.mjs` 的指纹收集部分，即下文两处收集修正；本票提交的 `scripts` 子树等于 T4（`ccb0d0ad`）。
  - Windows 的成果用 T4 的收集脚本以 `--collect-only` 重新收集，不重跑验收。
- **通过条件**：PRD 验收 A01–A15。A14、A15 在本票实测；A01–A13 引用各票 `## Answer`，并以本票在两个平台全新环境的重跑结果复核。
- **验收范围**：受控本地工作区与单进程串行交付。服务、多用户隔离、强制超时和容量认证不在合格声明内，见文末「本地边界与接入服务前的要求」。

## 全新环境复跑（A14）

做法（M201）：

- 用临时索引对工作树执行 `git write-tree`，再 `git archive` 成 tar，内容不含 `node_modules`、`dist`、字体等被忽略的文件。
- 两个平台各解包到一个空目录，依次执行：
  1. `npm ci`
  2. `npm run fetch-fonts`
  3. `npm run build`
  4. `npm run typecheck`
  5. `CI=1 npm test`
  6. `node scripts/accept-stage2.mjs out/acceptance 1000`
- Linux 在容器内安装依赖，不挂载宿主的 `node_modules`。
- 各平台的上级目录中都没有 `node_modules`，模块解析不会回退到其他安装。

| 步骤 | Windows | Linux |
|---|---|---|
| 环境 | Windows 11 IoT Enterprise LTSC 2024（10.0.26100），x64，Node v24.21.0，npm 11.19.0 | Docker `node:22-alpine`（`sha256:0a7108bf…`），Alpine 3.24.2，WSL2 内核 6.18.54.1，x64，Node v22.23.3，npm 10.9.9 |
| `npm ci` | 0，23 秒 | 0，9 秒 |
| `npm run fetch-fonts` | 0，13 秒，4 个字体 SHA-256 核对通过 | 0，12 秒 |
| `npm run build` / `typecheck` | 0 / 0 | 0 / 0 |
| `CI=1 npm test` | 0：31 个文件，622 项通过，62 秒 | 0：31 个文件，619 项通过、3 项跳过，67 秒 |
| 15 个验收步骤 | 全部退出码 0，共 1,725 秒 | 全部退出码 0，共 1,560 秒 |

- **Linux 跳过的 3 项**：都是 `it.runIf(process.platform === 'win32')` 的 Windows 清单替换 EPERM 重试用例（`test/resource-replacement.test.ts:183`、`test/versioned-resources.test.ts:221`、`:228`），重试逻辑只在 Windows 生效。
- **全量测试**：Windows 上无 EPERM。

逐步结果（同一脚本，两平台结论相同）：

| 步骤 | 验证内容 | Windows | Linux |
|---|---|---|---|
| `accept-stage1` | 5 次预热 + 30 次串行 + 4 次并发，拒绝 33 个异常请求，输入不变 | 通过；串行后 RSS 297 MiB | 通过；串行后 RSS 250 MiB |
| `accept-m402` | 7 个场景，原 11 份共享 JSON 未改写 | 通过 | 通过 |
| `check-svg-platform` | SVG 127/508 DPI × PNG/JPEG | 通过 | 通过 |
| `accept-qrcode` / `accept-barcode` / `accept-retail-barcodes` | 码图独立解码 | 16 / 8 / 24 份 | 16 / 8 / 24 份 |
| `accept-versioned-resources` | 15 个资源导入为 v1，旧仓库、当前版本、固定版本出图一致 | 通过 | 通过 |
| `accept-resource-replacement` | 图片与字体换为 v2 后当前出图改变，固定 v1 还原原图，过期报告被拒 | 通过 | 通过 |
| `accept-output-record` | 独立复制重放、真实进程中断、引擎或依赖改动被拒 | 通过 | 通过 |
| `accept-record-closure` | 完整 M402 及 PNG/JPEG/WebP/SVG、缺字替代独立重放 | 通过 | 通过 |
| `accept-batch` | 35 项交付、混合批次 4 项失败、重试不改原批次、草稿 | 35 项 44.9 秒 | 35 项 50.3 秒 |
| `accept-batch-cancel` | Ctrl+C 返回 130，3 处强杀点只认已发布项 | 通过 | 通过 |
| `accept-coded-sign` | 5 张码图牌交付与重放均独立解码，错误校验位单独失败，字体 v2 用于新批次，归档 v1 记录重放一致 | 通过 | 通过 |
| `stress-resource-commit` | 960 次初始化加首次导入（M200 回归门槛） | 0 失败，5.1 秒 | 0 失败，3.9 秒 |
| `accept-long-batch` | 预热 50 项后顺序交付 1,000 项（A12） | 1,365.6 秒；RSS 中位数 318.3 → 324.3 MiB（+6.0），峰值 343.1 | 1,251.9 秒；294.0 → 294.9 MiB（+0.9），峰值 310.2 |

- **长批次的其他结果**：两个平台的源输入均未改变，最后一项复制出来后可独立重放。实际磁盘占用都是 612 MiB；若逐项独立复制，会是 33,251 MiB，去重方式为硬链接。
- **耗时只作参考**：两个平台的长批次有一段时间同时运行，同机还有另一个会话在跑全量测试，各脚本耗时不作性能结论。RSS 增长与平台无关，两边都远低于 256 MiB 门槛。

收集脚本在本票中修正过两处，均不涉及被测代码：

1. 只把 `format` 为 `renderweave-batch/1` 的 `batch.json` 当作批次清单。`accept-output-record` 的请求文件也叫 `batch.json`，T2 的收集因此多记了一个空构建标识，Windows 的 `stage2` 步骤报出退出码 1；15 个验收步骤本身都是 0。
2. 文档路径不论绝对还是相对都替换为占位符。`accept-batch` 使用相对工作区路径，Windows 记录的 `source` 是 `docs\examples\...`，Linux 是 `docs/examples/...`。

修正前用 Linux 演练运行核对过：把 Windows 记录中 58 份 `input.json` 的分隔符换成 `/` 后，哈希与 Linux 完全相同，说明差异只在路径。

## 跨平台一致性（A14）

比较命令：

```powershell
node scripts/compare-platforms.mjs <Windows>/fingerprints.json <Linux>/fingerprints.json
```

结果：`PASS：441 个文件逐字节一致，构建标识相同`。两个平台的构建标识都是 `sha256:b1232846fde7935fcd6039bf3e535a46955fa93a9f11983872845fd518d64fe0`；双方文件集合相同，没有不一致项。

| 文件 | 个数 | 说明 |
|---|---|---|
| `image.png` / `image.jpg` / `draft.png` | 81 / 2 / 8 | M402、码图、资源版本、记录重放、批次与草稿的全部出图 |
| `layout.json` / `problems.json` | 94 / 99 | 布局摘要与问题清单 |
| `record.json` / `input.json` | 57 / 58 | 出图记录；`source` 文档路径换为占位符后比较 |
| `batch.json` / `preview.json` / `replay.json` | 12 / 6 / 11 | 批次清单、草稿预览清单、重放清单 |
| 各脚本的 `hashes.json` 等 | 13 | 码图解码记录、M402 摘要与输入哈希 |

覆盖了 PRD A14 列出的三类成果：

- **M402 基准**：两个平台的图片 SHA-256 都是 `785e0aad9beebf1203a6fd78284c69ab9606fa7d2323af94bd6bb50aabbfda72`，布局摘要都是 `d8b398bf8f14f983dc2eb8d08a4e027f2661fa48e9d6c11d2f79b70e81d84b2e`，与[首期验收](stage1-acceptance.md)记录的值相同（A01）。
- **码图**：码图牌、二维码、CODE128、EAN/UPC 的出图与布局一致。
- **出图记录重放**：各脚本的重放图、问题清单与布局一致。

跨平台互相重放：

- 每个平台取对方交付的 M402 第 35 项与码图牌第 1 项两份记录，用自己的全新构建执行 `replay`，4 次全部退出码 0。`replay` 会重新生成图片、问题清单和布局摘要，逐一与记录核对哈希。
- Windows 重放 Linux 记录时，M402 第 35 项的图片前缀为 `1fc485a6…`，码图牌为 `50b1e135…`，与记录中的图片相同。

记录中的时间与路径不参与比较：出图记录不保存时间；文档路径在 `input.json` 中替换为占位符，`record.json` 中 `input.json` 的哈希按同样规则替换（M201）。验收脚本把绝对目录写进 `evidence.json`，这类证据文件只看断言，不比字节。取消验收在随机时刻强杀进程，长批次已在自身脚本中逐项比对预热结果，这两步的目录不比较。

### 复现与证据位置

在任一平台的全新检出中执行：

```powershell
npm ci
npm run fetch-fonts
npm run build
npm run typecheck
npm test
node scripts/accept-stage2.mjs out/acceptance 1000
```

两个平台各自生成 `out/acceptance/fingerprints.json` 后，再用 `scripts/compare-platforms.mjs` 比较。Linux 容器写法：

```bash
docker run --rm -v <快照目录>:/fresh node:22-alpine sh /fresh/linux.sh <快照.tar> <结果目录> [对方记录目录]
```

本次的流水线日志、各步骤输出、指纹、比较结果、指南记录和所用脚本在 `out/stage2/fresh/`（不进版本库），快照对应关系见其中的 `SNAPSHOTS.txt`。

## 使用指南实测（A15）

两个平台的走法：

- 在全新环境的检出中（指南「准备」的三条命令已由上面的复跑完成），逐条照 [docs/guide.md](guide.md) 执行。
- Windows 用 PowerShell 写法，Linux 用 shell 写法。
- 命令原样照抄指南，脚本只负责记录命令、退出码和输出末尾几行。
- 不用工作区以外的知识，也不读代码。

| 指南步骤 | 命令 | Windows | Linux | 指南写明的预期 |
|---|---|---|---|---|
| 1 复制工作区 | `New-Item`+`Copy-Item` / `mkdir -p`+`cp -R` | 0 | 0 | — |
| 2 导入资源 | `resources-init`、`resources-import`、`resources-list` | 0、0、0 | 0、0、0 | 0；`icon-metro` 为 v1 |
| 3 交付 35 项 | `deliver … m402-batch-request.json --out out/guide/batch-35` | 0，`delivered: 35` | 0，`delivered: 35` | 0，35 项交付 |
| | `batch-read --batch out/guide/batch-35` | 0 | 0 | 0 |
| 4 失败定位 | `deliver … m402-mixed-batch-request.json` | 1，`delivered: 4, failed: 4` | 1，同左 | 1；4 项失败 |
| | 查看 `0002/problems.json` | `check.failed`，本站序号超过停靠站点数 | 同左 | 同指南表格 |
| | 对已存在目录再次交付 | 1，`delivery.writeFailed`（EEXIST） | 1 | 1，原批次不变 |
| 5 替换 | `resources-check` | 0，引用 1 处（"标识图标"的 `地铁` 状态） | 0 | 0 |
| | `resources-apply`、`resources-list` | 0、0，`icon-metro` 为 v2 | 0、0，v2 | v2 |
| | 同一报告再次应用 | 1，`resource.replacementStale` | 1 | 1 |
| | `render … render-request-m402.json --out out/guide/after-replace` | 0 | 0 | 0 |
| 6 独立重放 | 复制 `0005`，原工作区与仓库改名 | 0 | 0 | — |
| | `replay --record out/guide/archive-0005` | 0，"图片、问题清单和布局摘要均一致" | 0 | 0 |
| | 比较图片 | 归档 = 重放，≠ 替换后新图（`True`/`False`） | 前两项 `785e0aad…`，新图 `faf15410…` | 同指南 |
| | `record-read --record out/guide/archive-0005` | 0 | 0 | 0 |
| 清理 | `Remove-Item` / `rm -rf` | 0 | 0 | — |

- **耗时**：Windows 共 57 秒，Linux 54 秒。
- **记录本站 5 的图片**：两个平台均为 M402 基准 `785e0aad…`，替换前交付的历史图可脱离工作区与资源仓库重放。
- **不足**：这次是实施者照文档逐条执行，不是真实新用户的可用性研究。指南写成前，已先在主仓库按同一流程演练过一次，用来确认各步输出与退出码。

执行与记录脚本见 `out/stage2/fresh/guide-windows.ps1`、`guide-linux.sh`，逐条记录在 `out/stage2/fresh/{windows,linux}/guide-transcript.log`（不进版本库）。

## A01–A15 汇总

各票的 `## Answer` 是原始证据；"本票复核"指上面两个平台全新环境的重跑。

| 验收 | 内容 | 原始证据 | 本票复核 | 结论 |
|---|---|---|---|---|
| A01 | 首期兼容 | 各票全量测试；M402 11 份 JSON 未改 | 首期 golden/快照/M402 JSON 未改（Standards 节）；M402 基准哈希与首期相同 | 通过 |
| A02 | 二维码 | 票据 01、12 | 16 份独立解码，码图牌重放解码 | 通过 |
| A03 | 四种条形码 | 票据 02、03、12 | 8 + 24 份独立解码，码图牌四种格式 | 通过 |
| A04 | 码图失败与样式 | 票据 01–03 的定位、阻断、旋转与循环用例 | 全量测试通过；错误校验位单项失败 | 通过 |
| A05 | 35 张真实批次 | 票据 08 | 两平台 35 项与单次渲染一致，图片跨平台一致 | 通过 |
| A06 | 混合失败与外层拒绝 | 票据 08、09 | 混合批次只有 4 个坏项失败；Spec P2 记录问题码差异 | 通过 |
| A07 | 草稿与取消 | 票据 09、10 | 草稿 8 张跨平台一致；取消返回 130、强杀点只认已发布项 | 通过 |
| A08 | 资源版本与冲突 | 票据 04、05、12 | 替换与固定 v1、过期报告拒绝；M200 压测 0 失败 | 通过 |
| A09 | 自足重放 | 票据 06、07、11、12 | 独立复制重放；跨平台互相重放 4 次一致 | 通过 |
| A10 | 拒绝不完整记录 | 票据 06、07 的删除与篡改用例 | 引擎或依赖改动被拒；全量测试 | 通过 |
| A11 | 写入与进程故障 | 票据 04、06、08、10 | 进程强杀与中断辨认；全量测试 | 通过 |
| A12 | 长批次与输入不变 | 票据 11（M195–M197） | 两平台 1,000 项 RSS 增长 6.0 / 0.9 MiB，磁盘 612 MiB，输入不变 | 通过 |
| A13 | 运行中编辑 | 票据 08（M182）、12 | 全量测试中的 `test/batch-delivery.test.ts:137`（运行中替换资源、改写输入不混入本批，下一批用新内容） | 通过 |
| A14 | Windows/Linux | 本票 | 全新安装、构建、测试通过；441 个文件一致，构建标识相同 | 通过 |
| A15 | 使用指南 | 本票 | 两平台照指南完成，退出码与预期一致 | 通过 |

## Standards

审查依据：`CODING_STANDARDS.md`、`AGENTS.md`「项目约定」、`GLOSSARY.md` 的 _Avoid_ 用语、相关 ADR（0011–0014），以及 Fowler 代码异味基线（属判断性问题）。本次审查由实施者分两轮单独进行，没有使用独立审查代理。

| # | 级别 | 位置 | 发现 | 处理 |
|---|---|---|---|---|
| 1 | P2，判断：Duplicated Code / Shotgun Surgery | `src/record-input.ts:175-223`、`src/resource-impact.ts:83-128` | 两处各自遍历模板树与数据集编译产物，收集资源引用（图片来源、文字/条形码字体、片段字体、调用实参、状态样式、参数默认值、派生分支、数据集图片字段）。票据 12 加条形码字体时两处都要改（`record-input.ts:200`、`resource-impact.ts:87`）。逐分支核对后，两者目前等价，没有已知错误 | 转为后续重构任务，本阶段不改 |
| 2 | P3，判断：Duplicated Code | `src/layout/barcode.ts:41-55`、`src/layout/qrcode.ts:21-44` | 颜色不透明与不同色检查、拒绝随内容尺寸、按最终 DPI 向内取整像素边界三段逻辑重复 | 两处尚无分歧，暂不改 |
| 3 | P3，约定：中文注释与文档 | `src/renderer-build.ts:32` | 唯一一处英文注释 | 已改为中文 |
| 4 | P3，文档完整 | `src/cli.ts:1-14` | 文件头只写了 render、publish、deliver、batch-read 的退出码 | 已补 record-read、replay、resources-* |

已核对、无问题的项：

- 新增与修改的测试只从 `src/index.ts`、`src/cli.ts` 进入。
- 第二阶段没有修改或删除首期任何 golden、布局快照、M402 共享 JSON 与夹具：`git diff --diff-filter=MD 09524f1...HEAD -- test/golden test/snapshots docs/examples/m402-dsl fixtures` 只列出 M402 样例的 README（新增说明）。
- 新增的 5 张 golden 均为码图。
- 用语未出现 _Avoid_ 列出的说法。
- 码图走现有 CanvasKit 合成，字体只来自资源仓库（ADR-0011、0012）。

## Spec

| # | 级别 | 依据 | 发现 | 处理 |
|---|---|---|---|---|
| 1 | P2 | PRD 实施决定 13"每项仍调用同一渲染引擎，不复制检查" | 批量项的数据集或其静态定义找不到时，记录准备先行拒绝，报 `record.invalid`（位置 `outputRecord`），见 `src/record-input.ts:120`、`:132`。单次 `render` 对同一输入报 `input.datasetNotFound`、`input.staticSchemaNotFound` 与 `dataset.staticSchemaMismatch`（`src/preflight.ts:30-33`、`:62`）。只有该项失败，`message` 写明原因，A06 仍成立 | 转为后续任务；[使用指南](guide.md)第 4 节提示看 `message` |
| 2 | P3 | PRD 实施决定开头"没有实施的能力不得写入'当前支持'清单"（反向：已实现的能力也不能写成后置） | `README.md` 写"码图交付…仍后置"，`docs/resources-versioning.md:3` 写"批量和出图记录仍在后续票据中"，均已过期 | 已改 |
| 3 | — | 用户故事 50、PRD 实施决定 22 | 原先没有一份覆盖导入、批量、失败定位、替换与重放的中文指南，记录内容与交接范围散在 `output-records.md` | 新增 [docs/guide.md](guide.md)，README 链接 |

已核对、符合 PRD 的项：

- 构建标识覆盖实际引擎与依赖，构建不匹配时拒绝重放。
- 草稿不生成记录。
- 正式成功项必须同时有图片、问题清单、布局摘要和记录。
- 外层错误整批拒绝，不建目录。
- 取消只在项间生效。
- 资源种类不可变。
- 过期报告被拒绝。
- 同批去重时每份记录仍持有自己的文件入口。

两轴汇总：

- Standards 4 项，最高 P2，判断性；其中 2 项 P3 已修正，1 项 P2、1 项 P3 转后续。
- Spec 3 项，最高 P2；P3 与指南缺口已修正，P2 转后续。
- 没有剩余阻断项。

## 本地边界与接入服务前的要求

### 已验证能力

当前可执行能力以此为准，与 `CONTEXT.md`「已实现能力」一致。

- **码图**：二维码（UTF-8 字节模式，L/M/Q/H 纠错）、CODE128、EAN-13、EAN-8、UPC-A。
  - 最终 PNG/JPEG 能由独立解码器读回原文。
  - 内容、容量、尺寸、颜色问题可定位到元素；草稿显示问题位置，正式出图阻断。
- **资源内容版本**：
  - 导入为 v1，检查影响后替换，旧版本可读，可按固定版本出图。
  - 并发替换只有一个成功，过期报告被拒绝。
- **批量交付**：
  - 1–1,000 项串行，final 或 draft；逐项给出结果与进度，混合失败只影响出错项。
  - 外层错误整批拒绝，目标目录排他创建，写入失败后先探测存储再决定是否继续。
  - 项间取消（退出码 130），中断后用 `batch-read` 辨认已完成项。
- **出图记录**：
  - 自足保存模板调用闭包、数据、定义、配置与资源字节，整体复制后可脱离工作区重放；读取时核对完整性，重放时核对确切构建。
  - 同一批内相同素材硬链接去重；码图模板也可交付与重放。
  - 本票另验证：两个平台的全新构建能互相重放对方交付的记录。
- **长批次**：1,000 项的 RSS 不随项数增长，源输入不变（A12）。

### 本地边界

合格声明只覆盖以下条件：

- **输入与执行**：受控本地输入，单进程串行，一批最多 1,000 项。同步 WASM 绘制无法中途打断，取消只在项与项之间生效，没有单项超时。
- **存储**：本地文件系统，排他创建、内容同步后原子发布清单。批次目录须在支持硬链接的同一卷上。不承诺断电持久性，也不承诺网络文件系统上的事务语义。
- **Windows 旧仓库**：M200 修复前创建的资源仓库，若已出现首次导入持续 EPERM，修复后也不会自动恢复，需删除后重新初始化与导入。
- **构建**：重放要求确切构建；不分发历史构建，跨构建不重放。
- **记录内容**：出图记录包含业务数据、字体和图片原文件，以及交付机上的文档路径，交接时按其中内容的保密与许可要求处理。
- **资源写锁**：维护进程被强制结束后会留下写锁，需人工确认后移除（见[资源版本说明](resources-versioning.md#文件与故障边界)）。

### 接入服务前必须补的验证

以下均未实现，也未验证，不能视为已支持：

- **资源隔离**：多用户或多租户之间工作区、资源仓库与出图记录的隔离，以及访问控制与审计。
- **执行隔离**：每次渲染使用独立进程或 worker，加强制超时与内存上限（同步绘制无法在进程内中断），并给出最大展开规模（循环项数、元素数、请求与数据集大小）。现有像素上限为单边 20,000、总数 1 亿，不是建议负载。
- **容量**：A12 只是本地串行回归门槛，不是服务容量认证；服务需另定 CPU/内存预算、并发数与长期负载测试。
- **存储替代**：改用数据库或对象存储时，原子发布、排他目标和同批去重都要重新设计与验证，不能沿用硬链接假设。
- **不受信任的记录**：记录只作为数据读取，不加载其中的程序；接收外部记录前还需限制大小与数量。
- **未实现的能力**：HTTP 服务、MCP、业务 Agent（运行方式待按 M189、M190 用 Claude Code 加 Qwen token plan key 验证）、OCR、动态模板与循环扩展、URL 图片与远程字体、在线编辑器。
