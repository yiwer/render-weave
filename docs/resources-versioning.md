# 本地资源内容版本

第二阶段票据 04 已支持把旧资源清单整体导入版本仓库，保留 ID、种类和实际字节，首次内容版本为 1。公开接口可查询、按版本读取和固定资源版本映射；现有 `render` 命令直接接受新仓库。资源替换与影响检查属于票据 05，批量和出图记录仍在后续票据中。

## 从 CLI 运行

在仓库根目录执行；`out/resources-v1` 应选用尚无清单的新目录。重复初始化或重复导入会失败，不会覆盖已有资源。

```powershell
npm run fetch-fonts
npm run build
node dist/bin.js resources-init --resources out/resources-v1
node dist/bin.js resources-import --source fixtures/resources --resources out/resources-v1
node dist/bin.js resources-list --resources out/resources-v1
node dist/bin.js render --workspace docs/examples/m402-dsl --resources out/resources-v1 --request docs/examples/m402-dsl/render-request-m402.json --out out/m402-versioned
```

`resources-import` 和 `resources-list` 的标准输出是元信息 JSON 数组，可保存供程序读取；问题写到标准错误流。三个维护命令的退出码为 `0` 成功、`1` 仓库/内容/写入失败、`2` 用法错误。查询只读取声明的元信息，内容完整性在按版本读取时检查；查询成功不代表所有内容都可读。

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

## 文件与故障边界

新仓库根目录含 `resources.json`，格式为 `renderweave-resources/1`；各资源声明 `currentVersion` 和连续的 `versions`，每个版本包含 `version`、`sha256`、`byteLength`、`file`。内容位于 `objects/<随机 UUID>.bin`，文件名不使用资源 ID，因此区分大小写的 ID 不会在 Windows 文件名上互相覆盖。维护接口不覆盖历史内容，不提供删除和历史回收。

写入先获得 `.write-lock` 排他目录锁，创建内容文件并同步，最后发布完整清单；清单提交前读者只见旧内容。初始化通过同目录硬链接不覆盖发布，导入通过同目录重命名提交。文件系统须支持这些操作，不支持时返回错误。可捕获失败会撤回本次创建的文件并释放写锁；提交后若清理失败，以提示报告，已经提交的导入仍成功。并发写者收到 `resource.storeBusy` 后可重新执行，不自动抢锁。

| 问题码 | 典型位置与含义 |
|---|---|
| `input.unreadable` | 源/目标清单或条目结构非法，版本清单整体拒绝 |
| `input.duplicate` | 源清单重复 ID 或目标已有同 ID，整批拒绝 |
| `resource.unreadable` | 导入内容不可读、非法路径或按版本读取文件缺失 |
| `resource.integrityMismatch` | 字节数或 SHA-256 不符；使用该资源的元素收到严重问题 |
| `resource.versionNotFound` | 指定版本或固定映射内的资源不存在，不回退 |
| `resource.storeBusy` | 写锁已存在，当前未获得写权限 |
| `resource.writeFailed` | 文件创建、同步、提交失败；清理失败时为提示 |

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
