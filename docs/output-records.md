# 单项正式交付与出图记录

第二阶段票据 06 已实现：以一个渲染项的批量请求正式交付文字与图形，并把记录整体复制后独立重放。公开入口为 `deliverBatch`、`readOutputRecord`、`replayOutputRecord`。既有 `render` 继续负责纯渲染。

当前边界：只接受 `final`、一个根模板和恰好一个渲染项；模板调用、循环、图片字段/元素、引用定义及码图明确拒绝。模板/素材闭包在票据 07 扩展，码图交付在后续票据接入，多项调度从 08 开始。纯渲染原有能力不受此限制。

## 从 CLI 出图与重放

Node.js 22 及以上，在仓库根目录运行。所有交付及重放目标必须是新目录；重复执行时换新目标。

```powershell
npm ci
npm run fetch-fonts
npm run build
node dist/bin.js resources-init --resources out/record-resources
node dist/bin.js resources-import --source fixtures/resources --resources out/record-resources
node dist/bin.js deliver --workspace fixtures/workspaces/single-text --resources out/record-resources --request docs/examples/output-record/batch-request.json --options docs/examples/output-record/options.json --out out/greeting-record
node dist/bin.js record-read --record out/greeting-record
Copy-Item -LiteralPath out/greeting-record -Destination out/greeting-archive -Recurse
node dist/bin.js replay --record out/greeting-archive --out out/greeting-replayed
```

样例生成 756 × 189 px、120 DPI 的 PNG。`replay` 只接收记录和新输出目录，不接收工作区或资源仓库。Linux 复制命令可用 `cp -R out/greeting-record out/greeting-archive`。复制成功后即可将归档目录交给具有同一构建的另一台机器。

[批量请求样例](examples/output-record/batch-request.json)包含根模板、统一模式和 `items`。项的 `id` 是非空唯一标识，仅作为数据保存，不参与文件路径；数据集可用 `{ "id": "ds-greeting" }` 或 `{ "inline": { "dataset": { "staticSchema": { "name": "问候", "version": 1 } }, "data": { "message": "欢迎乘坐" } } }`。`parameters` 和 `output` 沿用单次渲染合同。

`--options` 可省略，届时把引擎默认的后备字体与 SVG 字体配置展开后保存。样例故意配置一个缺失后备字体，证明缺失状态也能保存，重放不会补入当前机器上的字体。显式空数组禁用相应候选列表。

退出码：`0` 已完整交付、完整读取或重放匹配；`1` 输入范围、完整性、构建、渲染或文件操作失败；`2` CLI 用法、请求/选项读取或请求数值精度错误。诊断写到标准错误流，正式交付引用及读取的清单写到标准输出。

## 公开入口

```typescript
import { loadWorkspace, openVersionedResourceStore, deliverBatch,
  readOutputRecord, replayOutputRecord } from './dist/index.js';

const workspace = await loadWorkspace({
  dir: 'fixtures/workspaces/single-text', resourcesDir: 'out/record-resources',
});
const opened = await openVersionedResourceStore('out/record-resources');
if (!opened.store) throw new Error(JSON.stringify(opened.problems));
const result = await deliverBatch({
  workspace, resources: opened.store,
  request: { template: '问候牌', mode: 'final', items: [{
    id: 'greeting-01', dataset: { id: 'ds-greeting' }, parameters: {},
    output: { width: 160, height: 40, dpi: 120, format: 'png' },
  }] },
  outDir: 'out/api-record',
});
if (!result.delivered) throw new Error(JSON.stringify(result.problems));
const checked = await readOutputRecord({ dir: result.delivered.directory });
const replayed = await replayOutputRecord({ dir: result.delivered.directory, outDir: 'out/api-replay' });
```

交付返回文件引用和问题清单，不在返回值累积图片字节。资源使用已打开版本仓库的当前快照；所有所需字体的版本先固定，再读取并校验字节，交给本次渲染的内存资源仓库。传入 `workspace.resources` 不参与交付。文档、请求、配置在首次异步操作前复制并序列化，渲染使用这份保存内容。

## 文件格式与完整性

单项输出目录即记录目录：

- `record.json`：`renderweave-output-record/1` 完成清单；包含构建标识、项标识、资源 ID/种类/版本/可用状态，以及每个内容文件的 SHA-256 与字节数。
- `input.json`：实际请求、模板、数据集、静态定义 DSL 和编译产物、渲染配置。内置定义没有独立 DSL 原文，保存实际编译产物并由确切构建约束其行为。
- `font-000001.bin` 等：固定版本的独立字体副本。文本（包括片段和状态分支）的显式字体、全部配置候选都保存，缺失候选写入清单。
- `image.png` 或 `image.jpg`、`problems.json`、`layout.json`：本次正式结果。重放重新生成三者，逐一比较哈希；一致才写出新目录及 `replay.json` 完成清单。

排他创建输出目录，内容文件逐个排他写入并同步；最后才原子发布完整清单。写入失败或进程中断可能留下目录和文件，缺少 `record.json` 的目录始终不能读为成功。清单引用只允许受控单层文件名，拒绝逃逸路径、重复条目、缺失文件、链接及损坏字节。记录内容默认独立复制，字体不依赖原版本仓库。这里验证本地文件系统的写入失败和进程强退，不宣称断电持久性或网络文件系统事务。

完整性校验用于发现缺失和改动，不是来源签名。记录包含业务数据、模板和字体原文件，交接范围包含这些内容，不能只交付清单或图片。

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
