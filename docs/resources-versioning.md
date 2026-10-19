# 本地资源内容版本

第二阶段票据 04–05 已支持资源 v1 导入、替换前影响检查、应用替换、按版本查询与读取，以及固定版本出图。替换保留 ID 和种类，每次成功追加内容版本，旧字节保留。批量交付以固定版本出图并把所用字节存入出图记录，见[出图记录](output-records.md)；从导入到重放的完整流程见[使用指南](guide.md)。

## 从 CLI 运行

在仓库根目录执行；`out/resources-v1` 应选用尚无清单的新目录。重复初始化或重复导入会失败，不会覆盖已有资源。

```powershell
npm run fetch-fonts
npm run build
node dist/bin.js resources-init --resources out/resources-v1
node dist/bin.js resources-import --source fixtures/resources --resources out/resources-v1
node dist/bin.js resources-list --resources out/resources-v1
node --input-type=module -e "import {openVersionedResourceStore} from './dist/index.js'; import {writeFile} from 'node:fs/promises'; const {store,problems}=await openVersionedResourceStore('out/resources-v1'); if(!store) throw Error(JSON.stringify(problems)); await writeFile('out/versions-v1.json',JSON.stringify(store.pin().versions,null,2));"
node dist/bin.js render --workspace docs/examples/m402-dsl --resources out/resources-v1 --request docs/examples/m402-dsl/render-request-m402.json --out out/m402-versioned
```

`resources-import` 和 `resources-list` 的标准输出是元信息 JSON 数组，可保存供程序读取；问题写到标准错误流。三个维护命令的退出码为 `0` 成功、`1` 仓库/内容/写入失败、`2` 用法错误。除 `resources-init` 外，命令与接口都要求目录已经是版本仓库：目录不存在、没有清单或是旧版资源目录时报 `input.unreadable`，说明里写明先执行哪条命令（M239）。查询只读取声明的元信息，内容完整性在按版本读取时检查；查询成功不代表所有内容都可读。

旧仓库仍使用原来的结构，不要求原地迁移：

```json
{
  "resources": [
    { "id": "logo", "kind": "image", "file": "images/logo.png" },
    { "id": "font-main", "kind": "font", "file": "fonts/main.otf" }
  ]
}
```

导入读取清单中列出的全部文件，不转换图片、不解析或改写字体。文件格式是否可用于绘制，由已有渲染流程验证。源文件与源清单不改写；以后修改源文件，也不会改变已导入的 v1。源路径须在仓库内，拒绝绝对路径、盘符、备用数据流、`.`/`..`、空路径段、符号链接和 junction；仓库根目录本身先解析为真实路径。旧仓库的单次渲染继续沿用原有行为。

## 公开接口

从 `dist/index.js` 导出以下接口：

| 接口 | 成功结果与语义 |
|---|---|
| `initializeResourceStore(dir)` | 准备空版本仓库，返回问题清单；已有清单绝不覆盖 |
| `importResources({ sourceDir, dir })` | 从旧清单整批导入，返回 `imported` 和 `problems`；严重问题时 `imported` 为空 |
| `openVersionedResourceStore(dir)` | 返回 `store` 与 `problems`；清单错误时无 `store` |
| `store.list()` | 按 ID 排序的当前元信息数组 |
| `store.get(id, version?)` | 省略版本取打开仓库时的当前版本；指定版本必须确切存在 |
| `store.read(id, version)` | 返回经过校验的 `Uint8Array`；失败抛出 `ResourceReadError` |
| `store.pin(versions?)` | 返回 `repository`、不可变的 `versions` 和问题清单；错误时无仓库 |
| `checkResourceReplacement({ dir, workspaceDir, id, kind, file, renderOptions? })` | 只读检查，返回 `check` 和问题清单；检查失败时无报告 |
| `applyResourceReplacement({ dir, workspaceDir, file, check, renderOptions? })` | 重新核对报告条件并追加版本；成功返回 `replaced` 元信息和问题清单 |
| `localResourceBackend(dir)`、`createMemoryResourceBackend()` | 版本仓库的存储接口：`open()` 打开快照，`commit(changes)` 整批新建资源或按预期版本追加内容版本，见[存储接口](storage-interfaces.md) |

元信息包含 `id`、`kind`、`version`、`byteLength`、`sha256`。版本从 1 开始，哈希代表内容而非版本身份。每次 `read` 重新读取并校验字节数和 SHA-256，不把外部修改静默接受为旧版本。

```js
import { loadWorkspace, openVersionedResourceStore, render } from './dist/index.js';
import { readFile } from 'node:fs/promises';

const opened = await openVersionedResourceStore('out/resources-v1');
if (!opened.store) throw new Error(JSON.stringify(opened.problems));
const versions = Object.fromEntries(opened.store.list().map(info => [info.id, info.version]));
const pinned = opened.store.pin(versions);
if (!pinned.repository) throw new Error(JSON.stringify(pinned.problems));
const workspace = await loadWorkspace({ dir: 'docs/examples/m402-dsl', resourcesDir: 'out/resources-v1' });
const request = JSON.parse(await readFile('docs/examples/m402-dsl/render-request-m402.json', 'utf8'));
const result = await render({ ...workspace, resources: pinned.repository }, request);
console.log(result.problems, result.image?.widthPx);
```

打开仓库得到一份清单快照，后续导入需要重开才可见。`pin()` 缺省固定全部当前资源，显式映射则只暴露列出的 ID；缺少 ID 或版本不存在时不回退当前内容。映射复制后固定，调用者修改原对象不会影响出图。所有本次可能用到的图片、文字字体、后备字体和 SVG 字体都应包含在映射内；最简单的方式是固定整个仓库。读取到的字节仍在每次调用时验证，这个接口本身不生成自足出图记录。

## 检查影响后替换

以下命令接续前面的 `out/resources-v1` 示例，把地铁标识替换为医院标识以便直接观察变化。生产使用时换成实际新素材。检查报告须使用新文件名并放在工作区之外；已有报告不覆盖。

```powershell
node dist/bin.js resources-check --resources out/resources-v1 --workspace docs/examples/m402-dsl --id icon-metro --kind image --file fixtures/resources/images/m402/icon-hospital.png --out out/metro-check.json
# 阅读 out/metro-check.json，确认所列引用后明确应用：
node dist/bin.js resources-apply --resources out/resources-v1 --workspace docs/examples/m402-dsl --file fixtures/resources/images/m402/icon-hospital.png --check out/metro-check.json
node dist/bin.js resources-get --resources out/resources-v1 --id icon-metro --version 1
node dist/bin.js render --workspace docs/examples/m402-dsl --resources out/resources-v1 --request docs/examples/m402-dsl/render-request-m402.json --out out/m402-current
```

检查和应用是两个独立调用，检查不修改资源。`resources-check` 同时把报告保存为 JSON 并输出到 stdout；`resources-apply` 输出新版本元信息；`resources-get` 输出指定版本的元信息。退出码继续为 `0` 成功、`1` 检查/冲突/文件失败、`2` 用法错误；资源版本与内容不会因失败推进。`--kind` 必须等于创建时种类；导入与替换都保存原始字节，候选是否可用于绘制仍由渲染器验证。

报告格式 `renderweave-resource-replacement/1` 包含仓库目录、资源 ID/种类/预期当前版本/哈希、候选文件的字节数与哈希、指定工作区真实目录及内容指纹、引用位置、字体配置和范围说明。`references` 区分模板固定引用、文字片段字体、状态样式、图片参数默认值、图片派生值、子模板图片实参及数据集图片字段；位置是标准 JSON Pointer，数组从 0 编号。扫描全部模板、隐藏元素和所有状态分支；数据集按静态数据定义的内联编译产物识别图片类型，普通文本和二维码内容中的 `res:...` 不算资源引用。

`configuration` 单独列出后备字体与 SVG 字体候选中的引用，表示可能受影响，不声称该字体一定参与每次出图。API 的 `renderOptions` 或 CLI 的 `--options <JSON文件>` 可指定 `fallbackFonts`、`svgFonts`（值为资源 ID 数组）；未指定项沿用引擎默认四档思源黑体，空数组表示禁用。检查和应用必须提供相同的有效配置；改变配置需重新检查。

指纹覆盖工作区顶层所有 `.json` 文件的文件名、原始字节和有效字体配置。因此新增、删除、内容变化、仅重新格式化 JSON，以及修改请求 JSON，都会使报告过期；Markdown 不参与指纹。检查期间核对前后指纹，应用持有资源写锁后重新扫描，内容和临时清单均写完后再次核对再发布。资源版本、当前内容、候选内容、工作区或配置有变化时拒绝；零引用同样核对全部条件。同字节的再次成功替换也产生下一版本。

报告只覆盖调用方提供的一个工作区与字体配置，不包含未提供的其他工作区、运行时临时数据集或临时参数。不能解析模板、缺少数据集编译产物或使用非内联组合 Schema 时，不给出“零引用”的成功报告。报告是用于防止过期写入的前置条件，不是签名或权限凭据；同一工作区的任意外部文件编辑器仍不在资源写锁的事务范围内。

## CLI 固定旧版出图

上面的首次导入步骤已把全部当前版本保存为 `out/versions-v1.json`。映射应在替换前保存，固定的是保存当时的版本；替换后用同一模板和数据集运行：

```powershell
node dist/bin.js render --workspace docs/examples/m402-dsl --resources out/resources-v1 --request docs/examples/m402-dsl/render-request-m402.json --versions out/versions-v1.json --out out/m402-v1
```

`--versions` 仅接受版本仓库，映射中缺少资源或指定版本不存在时不回退当前版本。模板和数据集仍取当前工作区，因此这一步验证资源历史读取，不代替后续票据的自足出图记录重放。

## 文件与故障边界

新仓库根目录含 `resources.json`，格式为 `renderweave-resources/1`；各资源声明 `currentVersion` 和连续的 `versions`，每个版本包含 `version`、`sha256`、`byteLength`、`file`。内容位于 `objects/<随机 UUID>.bin`，文件名不使用资源 ID，因此区分大小写的 ID 不会在 Windows 文件名上互相覆盖。维护接口不覆盖历史内容，不提供删除和历史回收。

写入先获得 `.write-lock` 排他目录锁，创建内容文件并同步，最后发布完整清单；清单提交前读者只见旧内容。初始化在持锁时确认尚无清单，再以同目录重命名发布；导入同样以重命名提交。初始化不用硬链接发布的原因见下文"M200"。文件系统须支持这些操作，不支持时返回错误。可捕获失败会撤回本次创建的文件并释放写锁；提交后若清理失败，以提示报告，已经提交的导入仍成功。并发写者收到 `resource.storeBusy` 后可重新执行，不自动抢锁。

| 问题码 | 典型位置与含义 |
|---|---|
| `input.unreadable` | 源/目标清单或条目结构非法，版本清单整体拒绝 |
| `input.duplicate` | 源清单重复 ID 或目标已有同 ID，整批拒绝 |
| `resource.unreadable` | 导入内容不可读、非法路径或按版本读取文件缺失 |
| `resource.integrityMismatch` | 字节数或 SHA-256 不符；使用该资源的元素收到严重问题 |
| `resource.versionNotFound` | 指定版本或固定映射内的资源不存在，不回退 |
| `resource.storeBusy` | 写锁已存在，当前未获得写权限 |
| `resource.writeFailed` | 文件创建、同步、提交失败；清理失败时为提示 |
| `resource.replacementInvalid` | 缺少或非法的检查报告，不能应用 |
| `resource.replacementStale` | 预期版本、工作区、配置、候选内容或目标仓库已不匹配，重新检查 |

进程强杀可能遗留写锁及未被清单引用的文件，读者不会通过清单读取这些半成品。恢复前应确认全部维护进程已停止，备份并检查清单及引用的版本，再人工移除遗留的空写锁目录；不要自动删除内容文件。断电持久性、网络文件系统、外部编辑器同时改写清单/路径及服务级隔离尚未验收。哈希用于发现损坏，不是针对同时篡改清单与内容的签名认证。取舍见 [ADR-0014](adr/0014-resource-manifest-commit.md)。

## 验收复现

```powershell
npm test
npm run typecheck
npm run build
node scripts/accept-versioned-resources.mjs out/stage2/resources-windows
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/accept-versioned-resources.mjs out/stage2/resources-linux
```

验收脚本每次在指定输出目录下新建临时工作区和资源仓库，通过编译后的 CLI 准备、导入、查询及出图；逐项核对 15 个资源的种类、版本、实际字节和哈希，再核对旧仓库、新仓库和固定映射生成的 M402 图片、问题清单及布局。`before/`、`after/` 保存实际 PNG、布局和问题，`metadata.json`、`hashes.json`、`environment.json` 保存证据。M402 的 11 份共享 JSON 无需修改。

接口测试位于 `test/versioned-resources.test.ts`：覆盖读取与映射、源文件变化、重复导入、清单损坏、路径与链接、清单提交 I/O 失败回滚、提交前读者可见性、同目标并发导入及初始化、CLI 参数/退出码，以及损坏图片和字体的元素诊断。

2026-10-12 实测：37 项新增用例通过，全量 23 文件、506 项通过，`npm run typecheck` 与 `npm run build` 通过。Windows Node v24.12.0 和 Linux Node v22.23.3 均通过上述 CLI 验收；两平台 15 个资源及 M402 图片、布局、问题清单哈希一致。M402 为 3496 × 780 px、120 DPI、0 个问题，图片 SHA-256 为 `785e0aad9beebf1203a6fd78284c69ab9606fa7d2323af94bd6bb50aabbfda72`。跨平台验收共用本次构建及锁定依赖，全新安装仍由票据 13 验收。

票据 05 的完整替换演示另运行：

```powershell
node scripts/accept-resource-replacement.mjs out/stage2/replacement-windows
docker run --rm -v "${PWD}:/work" -w /work node:22-alpine node scripts/accept-resource-replacement.mjs out/stage2/replacement-linux
```

脚本自动建立临时工作区与仓库，通过编译 CLI 检查并替换 `icon-metro` 图片和 `font-hei-medium` 字体，查询 v1、拒绝重复应用旧报告，再分别渲染当前版本及固定 v1。输出 `before`、`after-image`、`after-font` 及两份 `*-v1` 图片目录；`evidence.json` 保存引用位置和拒绝结果，`hashes.json` 保存各图片、布局、问题哈希。22 项新增接口/CLI 测试覆盖分类、零引用、同字节版本递增、过期报告、并发、提交失败回滚、提交前变更，以及图片/字体的旧版出图。

2026-10-12 票据 05 最终验证：全量 24 个测试文件、528 项连续三轮通过；类型检查和构建通过。Windows Node v24.12.0 / Linux Node v22.23.3 各 5 份成果均为 3496 × 780 px、120 DPI、0 问题，图片、布局、问题及引用证据跨平台一致；两份固定 v1 的完整结果都等于原图。

收尾曾观察到一次旧并发可见性测试在预期已有资源时读到空清单；当时前置导入结果未断言，原始原因未知且未复现。已补上前置结果断言，并在 finally 中等待异步写入结束后再清理测试目录；随后三轮全量通过，日志为 `out/stage2/replacement-repeat-1.log` 至 `replacement-repeat-3.log`。再次发生时，前置断言会保留具体资源问题码，供区分文件 I/O 故障与逻辑问题；不把本次诊断补强当作已确认的根因修复。

票据 07 回归捕获了明确的 Windows `EPERM`：资源导入重命名临时清单到 `resources.json` 失败，外部占用者未知。新增确定性故障注入先复现失败，再验证容错：仅 Windows 的 `EPERM`/`EACCES`/`EBUSY` 在持锁期间有限重试，等待依次为 20/40/80/160/320/640/1280 ms，最多等待 2540 ms；其他错误立即失败。每次尝试都重新执行提交前条件检查，等待期间工作区改变仍拒绝，绝不先删旧清单。持续拒绝保留旧仓库、清理本次文件并释放锁。对应 3 项回归及三轮全量日志位于 `out/stage2/closure-final-tests-*.log`。这次诊断不追溯断定票据 05 未捕获原因的故障来自同一外部占用。

最初 300 ms 上限的三轮全量中有一轮仍遇到真实 EPERM（保留于 `out/stage2/closure-tests-3.log`）；400 次并发导入探针未复现，见 `out/stage2/retry-probe.json`。最终上限是有界容错策略，不声称已识别外部占用者或消除所有 Windows 文件拒绝。

### M200：初始化后首次导入的持续 EPERM

2026-10-13 查明上述偶发的根因，并非短暂的外部占用：

- 并发"初始化 + 首次导入"压测稳定复现（旧代码 960 次中失败 3–21 次），失败全部发生在初始化后的第一次导入。
- 纯文件系统对照：初始化以 link 发布、再删临时名时，640 次中 13 次第二次替换失败，且轮询 15 秒仍失败；初始化改用 rename 时 640 次 0 失败。去掉后台写盘负载仍能复现。
- 失败的 `resources.json` 没有只读属性，能被独占打开，也能删除；但换进程、换源文件都无法用 rename 替换它，删除后再 rename 立即成功。NTFS 内部机制未查明，推断与删除临时名时被外部扫描打开的那条链接有关。

修复：初始化在持锁时确认尚无清单，再以 rename 发布，与导入共用同一提交与有限重试循环。所有写者都先持锁，因此不覆盖语义不变。旧代码创建且已"卡住"的仓库无法自动恢复，删除后重新初始化即可。

单元测试中该偶发复现率过低（旧代码多轮仍通过），不作为套件回归；回归门槛为 `node scripts/stress-resource-commit.mjs`：8 路 × 120 轮"初始化 + 首次导入"，要求全部成功。实测旧构建 3 轮全红，修复后 Windows 3 轮全过（约 5 秒），Linux 容器通过；修复后 Windows 全量测试连续 6 轮 622 项全过，无 EPERM。
