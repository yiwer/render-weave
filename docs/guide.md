# 使用指南：从资源导入到历史重放

照本页在一个临时目录里走完一次闭环：

1. 导入资源。
2. 交付 35 张 M402 线路牌。
3. 在一批中找出失败项并读懂原因。
4. 替换一张图片资源。
5. 用替换前的出图记录脱离原工作区重放。

全程只用命令行，不需要阅读代码。第 3 步的 35 项交付约 1 分钟，其余每条命令几秒。

## 准备

需要 Node.js 22 或以上版本。首次下载字体需要联网，字体版本和 SHA-256 固定在 `scripts/fonts.json`。在仓库根目录执行：

```powershell
npm ci
npm run fetch-fonts
npm run build
```

约定：

- 本页所有命令都在仓库根目录执行，成果都放在 `out/guide/`（不进版本库）。
- `node dist/bin.js` 就是 renderweave 命令行。命令写法在 PowerShell 与 Linux shell 中相同；只有复制、查看、改名和比较文件这几步分别给出两种写法。
- 每条命令执行后，用 `$LASTEXITCODE`（PowerShell）或 `echo $?`（Linux shell）查看退出码。本页每步都写明预期退出码。
- 交付、重放和检查报告的目标必须是新路径；目标已存在时命令失败，不会覆盖。想从头再走一遍，先删除整个 `out/guide/`（见文末「清理」）。

## 1. 复制一份工作区

工作区是一个目录，里面是这几类 JSON 文件：

- 静态数据定义：数据定义的发布版本。
- 编译产物：用于校验数据集。
- 模板：数据怎样画成图。
- 数据集：一条线路的具体数据。

这里把 M402 样例复制成临时工作区，之后的操作不改动仓库里的样例。

PowerShell：

```powershell
New-Item -ItemType Directory -Force out/guide | Out-Null
Copy-Item -Recurse docs/examples/m402-dsl out/guide/workspace
```

Linux shell：

```bash
mkdir -p out/guide
cp -R docs/examples/m402-dsl out/guide/workspace
```

## 2. 导入资源为 v1

资源是模板用到的图片和字体，模板里写成 `res:资源ID`。正式交付要求资源放在版本仓库中：

- 每个资源的 ID 和种类（image 或 font）创建后不变。
- 内容每替换一次就多一个版本，旧版本的字节一直保留。

```powershell
node dist/bin.js resources-init --resources out/guide/resources
node dist/bin.js resources-import --source fixtures/resources --resources out/guide/resources
node dist/bin.js resources-list --resources out/guide/resources
```

- `resources-init` 准备一个空仓库。
- `resources-import` 把 `fixtures/resources/resources.json` 列出的全部图片与字体导入为 v1。
- `resources-list` 列出当前版本。每个资源显示 `id`、`kind`、`version`、`byteLength`、`sha256`。

预期三条命令的退出码都是 0，列表中 `icon-metro` 为 `"version": 1`。已有仓库不能再初始化，同一 ID 也不能重复导入。

## 3. 交付 35 张线路牌

[35 项批量请求](examples/output-record/m402-batch-request.json)的内容：

- 根模板 `标准线路单边`，模式 `final`（正式交付）。
- 显式列出 35 个渲染项。每项有唯一的 `id`（`m402-01` … `m402-35`），使用同一数据集 `ds-m402-wanguocheng`。
- 每项的 `parameters.currentIndex` 是本站序号，依次为 1–35。
- 出图规格为 740 × 165 mm、120 DPI 的 PNG。

```powershell
node dist/bin.js deliver --workspace out/guide/workspace --resources out/guide/resources --request docs/examples/output-record/m402-batch-request.json --out out/guide/batch-35
```

运行中每完成一项，标准错误流打印一行进度，例如 `[5/35] m402-05：已交付 out\guide\batch-35\0005（严重 0，提示 0）`。结束后标准输出给出汇总，其中 `"delivered": 35`、`"failed": 0`，退出码为 0。

批次目录 `out/guide/batch-35/` 里有：

- `batch.json`：汇总清单，按输入顺序列出每项的 `index`、`id`、`status` 和目录。
- `0001/` 到 `0035/`：每项一个目录，按输入顺序编号。项标识只作为数据保存，不当作文件名。每个目录包含：
  - `image.png`：交付图片，3496 × 780 像素。
  - `problems.json`：问题清单，成功项为 `[]`。
  - `layout.json`：布局摘要，记录每个元素的实际位置、字号等。
  - `record.json` 及 `input.json`、`font-*.bin`、`image-*.bin`：出图记录，内容见下文「出图记录的内容与交接」。

再用 `batch-read` 核对一次：

```powershell
node dist/bin.js batch-read --batch out/guide/batch-35
```

退出码 0 表示运行已正常结束，且清单与各项目录一致。

## 4. 找出失败项并读懂原因

[混合请求](examples/output-record/m402-mixed-batch-request.json)在 4 个合法项之间放了 4 个错误项：

```powershell
node dist/bin.js deliver --workspace out/guide/workspace --resources out/guide/resources --request docs/examples/output-record/m402-mixed-batch-request.json --out out/guide/batch-mixed
```

预期退出码为 1，表示部分失败；汇总为 `"delivered": 4`、`"failed": 4`。合法项照常交付，错误项不拖累整批。

有三个地方可以找到失败项：

1. **进度行**：失败项显示"失败"，下一行打印问题码与原因，例如 `[严重] check.failed 标准线路单边 / 本站序号不能超过站点数：本站序号超过了停靠站点数`。
2. **`batch.json`**：`items` 中这些项的 `status` 为 `failed`。
3. **失败项目录里的 `problems.json`**：用下面的命令打开。

PowerShell：

```powershell
Get-Content out/guide/batch-mixed/0002/problems.json
```

Linux shell：

```bash
cat out/guide/batch-mixed/0002/problems.json
```

每个问题有四个字段：

| 字段 | 含义 |
|---|---|
| `level` | `severe` 为严重问题，阻止正式出图；`hint` 为提示，不阻止出图 |
| `code` | 稳定的问题码，可用于脚本判断 |
| `location` | 问题位置：模板检查项、输入来源（如 `request.output`），或模板元素路径 |
| `message` | 中文原因 |

本例的四个失败项：

| 目录 | 项标识 | 问题码 | 原因 | 修正方法 |
|---|---|---|---|---|
| `0002` | `stop-36` | `check.failed` | 模板检查项"本站序号不能超过站点数"：本站 36 超过了 35 个停靠站点 | 本站序号改为 1–35 |
| `0004` | `wrong-version` | `input.staticSchemaNotFound`、`dataset.staticSchemaMismatch` | 内联数据集选了工作区里没有的"线路牌 v2"，与模板的基准"线路牌 v1"也不符 | 改为工作区中的版本 1 |
| `0006` | `too-large` | `request.outputTooLarge` | 出图 23622 × 780 像素，单边超过 20000 像素上限 | 减小宽度或 DPI |
| `0007` | `no-dataset` | `input.datasetNotFound` | 工作区里没有数据集 `ds-missing` | 改为已有的数据集 ID |

`0004` 与 `0007` 无法展开，问题清单最后还有一条 `render.expansionBlocked`。批量交付的每一项与单次 `render` 对同一输入给出同一份问题清单，可以直接按问题码判断原因。

修正后重试：把改好的项另组一个新批次，交付到新目录。原批次不会被覆盖，也不会自动续跑。

想看严重问题出现在牌面哪里，可以把请求的 `mode` 改为 `draft`，交付到新目录：

- 可展开的项会生成带问题边框的 `draft.png`。
- 草稿不是可交付成品，也不生成出图记录。

详见[草稿批次](output-records.md#草稿批次)。

再对已存在的 `out/guide/batch-mixed` 执行一次同样的命令，会得到 `delivery.writeFailed` 和退出码 1，原批次保持不变。

## 5. 检查影响后替换一张图片

演示用医院标识替换地铁换乘标识 `icon-metro`。生产中换成实际的新素材。

先只读检查影响：

```powershell
node dist/bin.js resources-check --resources out/guide/resources --workspace out/guide/workspace --id icon-metro --kind image --file fixtures/resources/images/m402/icon-hospital.png --out out/guide/metro-check.json
```

- 退出码 0。报告保存到 `out/guide/metro-check.json`，同时输出到标准输出。报告须放在工作区目录之外。
- `impact.references` 列出工作区中引用该资源的每个位置。本例只有一处：模板"标识图标"中，状态 `地铁` 的图片来源（`kind` 为 `stateStyle`）。
- `impact.configuration` 列出后备字体与 SVG 字体配置中的引用。本例为空。

确认这些位置可以换新图后，应用替换：

```powershell
node dist/bin.js resources-apply --resources out/guide/resources --workspace out/guide/workspace --file fixtures/resources/images/m402/icon-hospital.png --check out/guide/metro-check.json
node dist/bin.js resources-list --resources out/guide/resources
```

- 应用的退出码为 0，`icon-metro` 变为 `"version": 2`。模板里仍写 `res:icon-metro`，不用修改。
- 报告只能使用一次。如果检查后资源版本、候选文件、工作区 JSON 或字体配置有任何变化，应用会被拒绝，问题码为 `resource.replacementStale`，退出码为 1。这时需要重新检查。同一份报告再应用一次，也会这样被拒绝。

然后看看新版本的效果。[单次渲染请求](examples/m402-dsl/render-request-m402.json)同样是本站 5：

```powershell
node dist/bin.js render --workspace out/guide/workspace --resources out/guide/resources --request docs/examples/m402-dsl/render-request-m402.json --out out/guide/after-replace
```

退出码 0。`out/guide/after-replace/image.png` 中的地铁换乘标识已变为医院标识，之后的新批次也都使用 v2。

## 6. 脱离原工作区重放替换前的记录

`out/guide/batch-35/0005` 是第 3 步用 v1 交付的本站 5。先把这一项复制出来，再把原工作区和资源仓库改名，确认重放不依赖它们。

PowerShell：

```powershell
Copy-Item -Recurse out/guide/batch-35/0005 out/guide/archive-0005
Rename-Item out/guide/workspace workspace-away
Rename-Item out/guide/resources resources-away
```

Linux shell：

```bash
cp -R out/guide/batch-35/0005 out/guide/archive-0005
mv out/guide/workspace out/guide/workspace-away
mv out/guide/resources out/guide/resources-away
```

重放：

```powershell
node dist/bin.js replay --record out/guide/archive-0005 --out out/guide/replay-0005
```

预期退出码为 0，输出"已重新渲染，图片、问题清单和布局摘要均一致"。`replay` 只读取记录目录，命令里没有工作区或资源仓库参数。

比较图片：

- 重放图片与归档图片应逐字节相同，仍是替换前的地铁标识。
- 第 5 步的新图换成了医院标识，与归档图片不同。

PowerShell（依次输出 `True`、`False`）：

```powershell
(Get-FileHash out/guide/archive-0005/image.png).Hash -eq (Get-FileHash out/guide/replay-0005/image.png).Hash
(Get-FileHash out/guide/archive-0005/image.png).Hash -eq (Get-FileHash out/guide/after-replace/image.png).Hash
```

Linux shell（前两行哈希相同，第三行不同）：

```bash
sha256sum out/guide/archive-0005/image.png out/guide/replay-0005/image.png out/guide/after-replace/image.png
```

另外，`node dist/bin.js record-read --record out/guide/archive-0005` 只核对记录的完整性，不重新渲染，退出码 0。

重放要求构建与交付时完全相同，包括 `dist/`、`package.json`、`package-lock.json` 和实际安装的依赖。构建不同时，重放以 `record.buildMismatch` 拒绝，退出码为 1。因此交付所用的构建需要和记录一起保留。

## 出图记录的内容与交接

一项正式交付的目录就是一份自足的出图记录，包括：

- 业务数据（数据集）。
- 根模板和所有被调用的模板。
- 静态数据定义与编译产物。
- 渲染请求、参数与字体配置。
- 所用图片和字体的原文件字节与版本号，以及渲染器构建标识。
- 交付图片、问题清单和布局摘要。

交接时请复制整个目录，不能只交付图片或 `record.json`。记录里含业务数据和字体文件，请按这些内容的保密与许可要求处理。`input.json` 还为每份文档保存了交付时它在本机上的路径（`source`），只作来源说明，重放不读取这些路径。

同一批次中相同的字体和图片以硬链接共享，只占一份磁盘：

- 用 `Copy-Item -Recurse` 或 `cp -R` 复制单项，会得到独立的字节。
- 不要改动记录中的任何文件。读取时会逐个核对哈希，改动会使记录被拒绝；由于是硬链接，同批其他记录也会一起被拒绝。

更完整的规则见[出图记录](output-records.md)。

## 退出码速查

| 命令 | 0 | 1 | 2 | 130 |
|---|---|---|---|---|
| `deliver` | 全部项产出本模式的完整成果（草稿可能仍含严重问题） | 整批拒绝、目标已存在、部分失败或未执行 | 用法错误，或请求/选项无法读取 | 已按 Ctrl+C 取消 |
| `batch-read` | 运行已结束，清单与目录一致 | 运行未完成（没有 `batch.json`），或目录不是批次目录 | 用法错误 | — |
| `replay`、`record-read` | 重放一致，或记录完整 | 完整性、构建、渲染或文件失败 | 用法错误 | — |
| `resources-*` | 成功 | 仓库、内容、检查、冲突或文件失败 | 用法错误 | — |
| `render` | 已出图（草稿须另看问题清单） | 未出图 | 用法错误，或请求文件无法读取 | — |

## 遇到问题时

- **`delivery.writeFailed`，提示 `EEXIST`**：目标目录已存在，换一个新目录。
- **`resource.storeBusy`**：另一个命令正在写资源仓库，稍后重试，不要删除仓库中的 `.write-lock` 目录。只有确认没有任何命令在写（例如维护命令被强制结束）后，才按[资源版本说明](resources-versioning.md#文件与故障边界)的步骤人工恢复。
- **交付中途停止**：
  - 按一次 Ctrl+C，当前项完成后停止，退出码 130。
  - 再按一次，或进程意外结束，会留下没有 `batch.json` 的目录。用 `batch-read --batch <目录>` 查看哪些项已完整交付，把其余项另组新批次。
- **`record.buildMismatch`**：当前构建与记录不同，改用交付时的构建重放。

## 清理

PowerShell：

```powershell
Remove-Item -Recurse -Force out/guide
```

Linux shell：

```bash
rm -rf out/guide
```
