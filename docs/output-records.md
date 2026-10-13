# 批量正式交付、草稿预览与出图记录

第二阶段票据 06–09 已实现：一个根模板列出多个渲染项，逐项正式交付，或先整批生成草稿预览。每个成功项都是一份自足出图记录，含完整模板调用、数据和素材依赖，整体复制后可独立重放。公开入口为 `deliverBatch`、`readOutputRecord`、`replayOutputRecord`；既有 `render` 继续负责纯渲染。

当前边界：一批统一为 `final` 或 `draft` 模式，渲染项数为 1–1,000，串行执行。已支持子模板、循环、引用定义、PNG/JPEG/WebP/SVG 与缺字替代。取消与中断辨认（票据 10）、素材去重（11）及码图交付（12）尚未实现，URL 图片与码图仍明确拒绝。每份记录独立复制所用字体，M402 一项约 34 MB，长批次的磁盘占用要按此估算。

## 从 CLI 批量交付与重放

Node.js 22 及以上，在仓库根目录运行。交付和重放的目标必须是新目录；重复执行时换新目标。

```powershell
npm ci
npm run fetch-fonts
npm run build
node dist/bin.js resources-init --resources out/record-resources
node dist/bin.js resources-import --source fixtures/resources --resources out/record-resources
node dist/bin.js deliver --workspace docs/examples/m402-dsl --resources out/record-resources --request docs/examples/output-record/m402-batch-request.json --out out/m402-batch
node dist/bin.js record-read --record out/m402-batch/0035
Copy-Item -LiteralPath out/m402-batch/0035 -Destination out/m402-35-archive -Recurse
node dist/bin.js replay --record out/m402-35-archive --out out/m402-35-replayed
```

[35 项请求](examples/output-record/m402-batch-request.json)逐项列出 M402 本站 1–35，每项生成 3496 × 780 px、120 DPI 的 PNG。[混合请求](examples/output-record/m402-mixed-batch-request.json)在合法项之间放入本站 36、错误数据版本、超大尺寸和不存在的数据集，交付后只有这 4 项失败，退出码为 1。[单项请求](examples/output-record/batch-request.json)配合 `--workspace fixtures/workspaces/single-text --options docs/examples/output-record/options.json` 使用，样例故意配置一个缺失的后备字体，用来证明缺失状态也随记录保存。

`deliver` 每完成一项，就在标准错误流打印一行进度，形如 `[3/35] m402-03：已交付 out\m402-batch\0003（严重 0，提示 0）`；失败项随后列出问题。全部结束后，标准输出给出批次目录与汇总。`replay` 只接收一项记录和新输出目录，不接收工作区或资源仓库；Linux 复制命令可用 `cp -R`。

退出码：

- `deliver`：`0` 本模式的成果全部完整（正式为全部已交付，草稿为全部已预览）且 `batch.json` 已写出；`1` 整批拒绝、目标已存在、部分项失败或未执行、汇总未写出；`2` CLI 用法、请求/选项读取错误或请求数值精度错误。草稿返回 0 不代表可交付，汇总仍列出严重问题数。
- `record-read`、`replay`：`0` 完整读取或重放匹配；`1` 完整性、构建、渲染或文件操作失败；`2` 用法错误。

失败项的重试方式：修正后显式列成新批次，交付到新目录。旧批次不会被覆盖，也不会自动续跑或重试。

## 批量请求与执行规则

请求包含 `template`、`mode`（`final` 或 `draft`，整批统一，渲染项不能各自指定）和 `items`。每项有 `id`、`dataset`、`parameters`、`output`：

- `id`：非空，批次内唯一，只作为数据保存，不参与文件路径。
- `dataset`：写成 `{ "id": "ds-m402-wanguocheng" }` 引用已保存的数据集，或写成 `{ "inline": { "dataset": { "staticSchema": { "name": "问候", "version": 1 } }, "data": { … } } }` 内联数据。
- `parameters`、`output`：沿用单次渲染合同。

执行前整批拒绝（不建目录、不产生成功项）的情况：

- 外层结构不合法、出现未定义属性、渲染项不是对象。
- 项列表为空、超过 1,000 项、标识重复。
- 选项不合法，或工作区有严重读取问题。
- 根模板无法准备：不存在、调用闭包缺失或成环、含码图元素。
- 固定资源的字节与版本不符。
- 目标目录已存在。

只让本项失败、其他项照常交付的情况：数据集缺失或数据版本错误、参数或出图尺寸非法、正式模式下渲染出现严重问题（如本站 36 的 `check.failed`）、两种模式下都无法展开、本项写入失败。

开始执行前，以下内容在一次同步步骤内固定：

- 文档、全部渲染项和渲染配置复制一份。
- 所有项可能用到的资源先固定版本映射，再读出字节并校验。

运行中改写传入的工作区对象或请求，或在仓库里替换资源，都不会混入本批；下一批才使用新内容。每项仍调用同一个 `render`，不复制检查、求值或排版逻辑。

各项串行执行。每项写完成果即释放图片字节，返回值和 `batch.json` 只保留状态、问题与文件引用。单项写入失败后会在批次目录写一个探测文件：可写就继续下一项；整体不可写就停止调度，其余项标为 `notRun`，并给出 `delivery.storageUnavailable`。`onItem` 回调抛错同样停止调度，问题码为 `delivery.stopped`。

## 草稿批次

把请求的 `mode` 改为 `draft`，就能用同一批渲染项先核对，再以 `final` 运行。每项沿用单次渲染的草稿规则（见[草稿与正式模式](render-modes.md)），三类项各有明确结果：

| 情况 | 草稿批次 | 正式批次 |
|---|---|---|
| 没有严重问题 | `previewed`：草稿图片、问题清单、布局摘要 | `delivered`：图片与完整出图记录 |
| 有严重问题但可展开（本站 36、某站缺站名） | `previewed`：草稿图片带占位与问题边框，严重问题计入汇总 | `failed`：无图片，保留问题清单与真实内容布局摘要 |
| 无法展开（如数据集选错定义） | `failed`：只有问题清单 | `failed`：相同问题清单 |

同一输入的两种模式问题清单逐项一致；草稿布局摘要描述实际显示的占位布局，可能与正式不同。为避免把预览当成品：

- 草稿图片命名为 `draft.png`/`draft.jpg`。
- `batch.json` 与返回值标明 `mode: draft`，状态为 `previewed`，不会出现 `delivered`。
- 草稿项不生成出图记录。
- CLI 在含严重问题时另行提示"不是可交付成品"。

草稿批次同样固定输入、逐项释放图片字节、排他创建目标。

```powershell
node dist/bin.js deliver --workspace docs/examples/m402-dsl --resources out/record-resources --request docs/examples/output-record/m402-draft-batch-request.json --out out/m402-draft
```

[草稿样例](examples/output-record/m402-draft-batch-request.json)包含合法的本站 1 与 35、可展开的本站 36，以及无法展开的 `wrong-schema`。本站 1、35、36 得到草稿预览，`wrong-schema` 失败，因此退出码为 1。去掉 `wrong-schema` 后全部预览完整，退出码 0，汇总仍有 1 个严重问题。

## 公开入口

```typescript
import { loadWorkspace, openVersionedResourceStore, deliverBatch,
  readOutputRecord, replayOutputRecord } from './dist/index.js';

const workspace = await loadWorkspace({
  dir: 'docs/examples/m402-dsl', resourcesDir: 'out/record-resources',
});
const opened = await openVersionedResourceStore('out/record-resources');
if (!opened.store) throw new Error(JSON.stringify(opened.problems));
const result = await deliverBatch({
  workspace, resources: opened.store,
  request: { template: '标准线路单边', mode: 'final', items: [1, 2, 3].map((current) => ({
    id: `m402-${current}`, dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: current },
    output: { width: 740, height: 165, dpi: 120, format: 'png' },
  })) },
  outDir: 'out/api-batch',
  onItem: (item, { completed, total }) => console.log(`${completed}/${total}`, item.id, item.status),
});
if (!result.directory) throw new Error(JSON.stringify(result.problems)); // 整批拒绝
const first = result.items[0]!;
if (first.status === 'delivered') {
  const checked = await readOutputRecord({ dir: first.directory! });
  const replayed = await replayOutputRecord({ dir: first.directory!, outDir: 'out/api-replay' });
}
```

`BatchDeliveryResult` 的字段：

- `directory`：批次目录，整批拒绝时没有。
- `mode`：批次模式，整批拒绝时没有。
- `summary`：`total`、`delivered`、`previewed`、`failed`、`notRun` 五个项数，以及全部项的严重问题总数 `severe` 和提示总数 `hints`。
- `items`：按输入顺序排列的逐项结果。
- `problems`：批次级问题。

逐项结果 `BatchItemResult` 的字段：

- `index`（从 1 开始）、`id`、`status`：`delivered`（正式交付成功）、`previewed`（草稿预览已生成，可能仍有严重问题）、`failed` 或 `notRun`。
- `directory`：可直接打开的本项目录。
- `files`：受控文件名。
- `severe`、`hints`：问题计数，`problems` 为完整问题清单。
- `reason`：没有本项目录时说明原因。

资源使用已打开版本仓库的版本，传入的 `workspace.resources` 不参与交付。

模板依赖包括隐藏调用及全部状态分支，按名称收集可达模板，并检查循环、缺失和重复。以下内容都随记录保存：每个模板基准、派生引用类型、实际数据集基准，以及静态定义原文和编译产物中的确切版本引用。渲染器继续校验每一层调用的数据版本，不把不同版本合并。

资源按声明的类型收集：

- 固定图片、文本/片段/状态字体。
- 图片参数的默认值与根调用实参、图片派生分支、被调模板的图片实参。
- 数据集对象和列表中的图片字段。

普通文本中的 `res:` 不当作资源。隐藏元素和未命中分支的引用也固定；后备字体与 SVG 字体候选保留配置顺序和可用/缺失状态。SVG 原字节独立保存，内嵌图片属于其字节；外部引用仍由既有 SVG 清理规则处理，重放时不会读取外部地址。

## 文件格式与完整性

批次目录：

- `batch.json`：`renderweave-batch/1` 汇总清单，全部项结束后最后原子发布。字段包括构建标识、根模板、模式、`summary`、逐项条目和批次级问题。
- 逐项条目的字段：`index`、`id`、`status`、`directory`（相对批次目录）、`files`、`severe`、`hints`，没有目录时另有 `reason`。缺少 `batch.json` 的批次目录表示运行未正常结束。
- `0001/`、`0002/` 等子目录：名称只由输入序号生成。
  - 正式成功项是一份完整出图记录（见下文）。
  - 草稿预览项有 `draft.png` 或 `draft.jpg`、`problems.json`、`layout.json`，最后发布 `preview.json`（`renderweave-preview/1`：模式、构建标识、项标识及三个文件的 SHA-256）。它不是出图记录：不复制输入与资源，`record-read` 和 `replay` 都拒绝。
  - 失败项只有 `problems.json`，以及可用时的 `layout.json`，没有 `record.json`，不能读作记录。
  - 写入失败或未执行的项可能没有目录，原因写在 `reason`。

每项记录目录：

- `record.json`：`renderweave-output-record/1` 完成清单；包含构建标识、项标识、资源 ID/种类/版本/可用状态，以及每个内容文件的 SHA-256 与字节数。
- `input.json`：实际请求、模板调用闭包、数据集、相关静态定义 DSL 和编译产物、渲染配置。内置定义没有独立 DSL 原文，保存实际编译产物并由确切构建约束其行为。读取时核对保存文档与重新收集的完整依赖相同，不能通过删除内置定义再让本机生成来补缺。
- `font-000001.bin`、`image-000005.bin` 等：固定版本的独立资源副本，文件扩展名不参与图片格式识别。缺失引用和候选写入清单。
- `image.png` 或 `image.jpg`、`problems.json`、`layout.json`：本次正式结果。重放重新生成三者，逐一比较哈希；一致才写出新目录及 `replay.json` 完成清单。

批次目录与各项目录都排他创建，内容文件逐个排他写入并同步；各项最后才原子发布 `record.json`，全部项结束后再发布 `batch.json`。写入失败或进程中断可能留下目录和文件，缺少 `record.json` 的目录始终不能读为成功。清单引用只允许受控单层文件名，拒绝逃逸路径、重复条目、缺失文件、链接及损坏字节。记录内容默认独立复制，字体不依赖原版本仓库。这里验证本地文件系统的写入失败和进程强退，不宣称断电持久性或网络文件系统事务。

完整性校验用于发现缺失和改动，不是来源签名。记录包含业务数据、模板、图片和字体原文件，交接范围包含这些内容，不能只交付清单或图片。

## 构建匹配

构建标识散列当前实际引擎文件、`package.json`、`package-lock.json`，以及递归解析到的生产依赖文件（包括 CanvasKit/resvg WASM），不依赖 Git 状态或包版本唯一性。标签不含安装目录，移动相同构建可继续重放；改动引擎或实际依赖文件会拒绝。使用 `dist` 构建进行正式交付，并保留其完整引擎、包元数据和锁定依赖。源码执行与编译执行是不同构建，不能混用。平台和 Node 版本另行记录于验收证据。

`readOutputRecord` 验证内容完整性，不要求当前引擎能重放；`replayOutputRecord` 再核对确切构建并实际出图。记录中的程序不会被加载或执行，也不会自动取得历史构建。

## 票据 06 验收

```powershell
npm test
npm run typecheck
npm run build
node scripts/accept-output-record.mjs out/stage2/record-windows
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/accept-output-record.mjs out/stage2/record-linux
```

公开入口回归覆盖单项合同、内联数据、PNG/JPEG、图形和参数、固定字体/缺失候选、复制重放、逐文件删改、路径逃逸、构建不匹配、重新渲染比较、目标竞争、写入一半后失败及完成清单提交失败。CLI 脚本在临时目录准备真实输入，复制记录后移走原工作区/仓库/原记录，再验证重放；在内容已写完但清单尚未发布时强杀子进程，确认残留目录拒绝读取；复制构建后分别改动引擎与实际 qrcode 依赖字节，确认构建拒绝。

Windows/Linux 结果写在各自目录的 `hashes.json`、`evidence.json`、`environment.json`；`evidence.json` 给出本次独立记录和重放图片的位置。容器共享已构建 JS、锁定依赖及字体；全新 Linux 安装仍由阶段票据 13 验收。M402 共享 JSON 未改。

2026-10-12 实测：Windows Node v24.12.0、Linux Node v22.23.3；25 个测试文件、573 项全过，类型检查和构建通过。两平台图片、布局、问题哈希一致，Windows 生成的同一记录在 Linux 也重新出图匹配。图片 SHA-256 为 `2234e9c6b8de9927f08a958a097df8568caabc8db963a691ea53140305277141`，0 个问题。

## 票据 07 验收

```powershell
npm run build
node scripts/accept-record-closure.mjs out/stage2/closure-windows
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/accept-record-closure.mjs out/stage2/closure-linux
```

脚本通过编译 CLI 完成两组记录，并先与公开 `render` 的同配置结果逐字节比较，再复制、改动当前模板/数据/字体配置、改变资源文件位置并移走全部原输入后重放。M402 直接使用 11 个共享 JSON，不修改原样例；记录包含 5 个模板，线路牌/停靠站点两份静态定义及单值·文本/单值·时刻两份内置编译产物。素材牌使用 [record-media 夹具](../fixtures/workspaces/record-media/README.md)，同时验证 PNG/JPEG/WebP/SVG 中文、缺字替代及缺失候选。

本机输出位置由 `out/stage2/closure-windows/evidence.json` 和 `closure-linux/evidence.json` 给出。M402 图片 SHA-256 为 `785e0aad9beebf1203a6fd78284c69ab9606fa7d2323af94bd6bb50aabbfda72`，3496 × 780 px、120 DPI、0 问题；素材牌为 `6502a98321cab3692d1f54224723890779f3dc056be1c2acc872ee8db59bbef1`，472 × 189 px、120 DPI，保留一项 `text.glyphFallback` 提示。两平台图片、问题清单和布局摘要一致。

17 项新增记录依赖测试覆盖完整调用、列表单值图片、隐藏/状态/片段资源、图片参数及派生值、原记录和仓库失效、嵌套内容删除/篡改、内置定义缺失、存在多个版本时的调用版本错配。票据 06 的文件故障和强退脚本仍通过。全量回归中另捕获 Windows 清单替换偶发 `EPERM`，补了有限重试及 3 项资源回归，细节见[资源版本说明](resources-versioning.md)。

票据 07 最终全量为 26 文件、592 项，连续三轮通过；类型检查和构建通过。新 CLI 已读取原票据 06 的记录，格式兼容仍受确切构建重放规则约束。

## 票据 08 验收

```powershell
npm test
npm run typecheck
npm run build
node scripts/accept-batch.mjs out/stage2/batch-windows
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/accept-batch.mjs out/stage2/batch-linux
```

公开入口回归（`test/batch-delivery.test.ts`）覆盖以下场景：

- 35 项 M402 本站逐项与公开 `render` 一致，35 张图各不相同，进度回调按序。
- 混合批次只有 4 个坏项失败，修正后另组批次不改动原批次。
- 根模板缺失、项不是对象、工作区有严重问题时整批拒绝。
- 运行中真实替换资源、改写传入的模板和请求，本批不受影响，下一批改用 v2。
- 标识只作数据；单项写入失败后继续；存储整体不可写时停止并标出未执行；进度回调抛错时停止。
- CLI 的进度、汇总与退出码。

脚本通过编译 CLI 交付[35 项请求](examples/output-record/m402-batch-request.json)和[混合请求](examples/output-record/m402-mixed-batch-request.json)，逐项与 `render` 逐字节比较，另外验证：

- 第 35 项复制后可读取、可重放。
- 修正后的失败项另组批次交付，原批次全部文件哈希不变；再次写入同一目标被拒绝。
- 退出码：非 JSON 请求返回 2，非批量 JSON 返回 1。

2026-10-12 实测（Windows，Node v24.21.0）：

- 27 个测试文件、603 项全过，类型检查和构建通过。
- 35 项用时 37.6 秒，批次目录共 1.22 GB：每份记录独立复制 4 个字体，约 34 MB。
- 本站 5 的图片 SHA-256 与票据 07 的 M402 基准相同，为 `785e0aad9beebf1203a6fd78284c69ab9606fa7d2323af94bd6bb50aabbfda72`。
- 票据 06、07 的验收脚本按新目录布局（记录在批次目录的 `0001/`）重跑通过，图片哈希与原记录一致。

2026-10-13 在 Docker `node:22-alpine`（Linux，Node v22.23.3）上用同一构建复跑：35 项图片哈希与 Windows 逐一相同，构建标识相同，混合批次失败项及各退出码一致。经挂载目录写盘，35 项用时约 95 秒。全新环境安装由票据 13 汇总；长批次的素材去重和内存曲线由票据 11 验收。

## 票据 09 验收

同一脚本（`scripts/accept-batch.mjs`）新增草稿部分，命令同上。公开入口回归在 `test/batch-draft.test.ts`，覆盖：

- 同一输入的草稿与正式两批：三类项状态、逐项问题清单一致、草稿文件与 `preview.json` 哈希、草稿无记录。
- 模式只能整批统一，草稿同样保护已有目标。
- CLI 草稿退出码与"不是可交付成品"提示。

脚本运行[草稿样例](examples/output-record/m402-draft-batch-request.json)，验证：

- 退出码 1：本站 1、35、36 已预览，`wrong-schema` 失败。
- 同一请求按 final 运行：逐项 `problems.json` 与草稿相同，本站 36 无图片；本站 1 的草稿图与正式图哈希相同。
- 去掉无法展开项后：退出码 0，汇总 1 个严重问题并输出不可交付提示。

2026-10-13 实测：

- Windows（Node v24.21.0）：28 个测试文件、606 项全过，类型检查和构建通过。
- Linux 容器：草稿图片、问题清单与草稿布局摘要和 Windows 逐字节一致。

Docker 同时大量写盘时，全量测试曾两次偶发 Windows 资源清单 `rename` 的 EPERM，超出 M179 的有界重试；无负载时全量通过，外部占用者仍未知。
