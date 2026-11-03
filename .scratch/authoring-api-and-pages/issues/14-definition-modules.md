# 14: 参照旧 RenderWeave 重做数据定义与静态数据定义两个模块

**What to build:** 把票据 06 的数据定义页面拆成两个模块，结构与交互参照旧 RenderWeave：数据定义放还在改的草案，编辑页左边字段、右边检查器，改动先留在页面上再保存；静态数据定义放已发布的不可变版本，卡片列表加四种看法的详情。

**Blocked by:** 06

**Status:** resolved

**Trace:** 用户走查票据 13 时反馈"这个实现和原型似乎完全对不上"，要求"参考旧的 RenderWeave 做出数据定义模块、StaticSchema 模块先"（2026-11-02）；决定在 M360。旧项目事实：`outside_context/legacy-renderweave/web/src/app/App.tsx:53-58`、`web/src/features/resources/StaticSchemaPages.tsx:52,124`、`docs/prototypes/schema-studio.md`。

- [x] 模块下拉多一个"静态数据定义"；数据定义模块只放草案，发布记录归到静态数据定义。
- [x] 数据定义列表：一份草案一张卡片（显示名称、名称、字段数、基于哪一版、最近保存），能搜索、排序；客户管理员能新建、发布、删除。
- [x] 编辑页：左边字段，表单与树状图是同一个编辑会话的两种看法；右边检查器改选中的字段。
- [x] 改动先留在页面上，可以撤销、重做、回到已保存；点"保存"（`Ctrl+S`）才写一次草案，保存后校验并定位到字段。
- [x] 有没保存的改动时，换页与关窗口都先问；改名或删字段前提示影响的模板；别人先保存时读回最新内容。
- [x] 静态数据定义列表：一个版本一张卡片（版本、字段数、引用深度、谁在用、发布时间），能搜索、排序；右键有打开、新标签页、发布记录、导出编译产物、复制引用、复制为草案。
- [x] 详情：元数据条，字段树、字段表单、编译产物 JSON Schema、数据定义 DSL 四种看法，代码能复制、下载，右边是选中字段的只读信息，能切换版本。
- [x] 复制为草案：同一名称接着发下一版；换名称是一份新的数据定义。
- [x] 旧地址 `#/definitions/:name?version=&field=` 照旧能打开：没有草案或带版本时转到静态版本。
- [x] 操作员只读：没有任何写入口，检查器没有输入框。
- [x] 开放 API 只做加法（1.9.0）：列静态数据定义加 `fieldCount`、`referenceDepth`，列数据定义的 `draft` 加 `displayName`、`fieldCount`。
- [x] 用户看过页面，确认方向对了（配色保留咖啡色，见 M360 的切换条件）。

**测试接缝：** 编辑会话的纯函数单元测试（`service/test/definition-session.test.ts`）；控制台浏览器用例（`service/test/console-suite.ts`）；接口用例（`service/test/definitions-suite.ts`）。

## Answer

2026-11-03 完成，用户看过截图后确认方向。

**成果：** 控制台 `pages/definitions.tsx`、`pages/definition-studio.tsx`、`pages/static-schemas.tsx`、`components/definition-fields.tsx`、`form/definition-session.ts`；开放 API 1.9.0（只做加法，没有新迁移）；决定在 M360。删除了 `pages/definition-detail.tsx`。

**跑过的命令与结果：**

- `npx tsc --noEmit -p service/console`、`npx tsc --noEmit -p service`：通过。
- `npx vitest run service/test/console.browser.test.ts --no-file-parallelism`（内存后端、本机 Edge）：24 项通过，2 项跳过；另一次全量里同样没有失败。
- `npx vitest run --maxWorkers=4`（Windows）：1,475 项通过，16 项失败，9 项跳过。
  - 服务侧 1 项是 `datasets-suite` 按整对象比对列表，没预期新加的属性；改正后 `service/test/datasets.test.ts` 6 项通过。
  - 引擎侧 15 项在 `agent-*` 与 `retail-barcodes`，本票没有改引擎。这 7 个文件 `--no-file-parallelism` 串行复核：126 项通过，1 项跳过，只剩 `agent-candidate-freeze` 的 `EPERM`（要开开发者模式），与 P1 验收记录相同。
- 截图与旧 RenderWeave 的同类页面对照过：列表、编辑页、静态版本的列表与详情。

**对验收的偏差：**

- 关票时 Docker 后端、Linux 全量与验收脚本都没有重跑，它们要独占 Docker，会清掉当时还开着的走查环境。用户同意后当天重跑，结果见下面。
- 旧项目的样本验证器、修订历史、可拖动画布等没有做，理由在 M360。

**关票之后重跑（2026-11-03）：**

- `RW_ALPINE_MIRROR=https://mirrors.aliyun.com node service/scripts/test-docker.mjs`：21 个文件，198 项通过；日志 2,599 行全部合格。
- `node service/scripts/accept-p1.mjs --walkthrough`：15 步全过，报告在 `out/p1/acceptance/2026-11-03T08-39-56-649Z/`（不进版本库）。第一次一启动就报语法错误：改步骤时新加的变量和后面的 `inspector` 重名；改名后通过。
- Linux 全量（`docs/dev-setup.md` 的命令，`node:22-alpine`，`docker run --init`）：构建与两项类型检查通过；`npm test -- --maxWorkers=4` 1,449 项通过，9 项失败，42 项跳过。9 项都在引擎的 7 个 `agent-*` 文件里，服务侧没有失败。这 7 个文件在干净容器里 `--no-file-parallelism` 串行复核：100 项通过，3 项跳过，没有失败。推断是并行时的负载与写锁：日志里有 `.write-lock` 报错和超时，与 P1 验收记下的 A12 后续同类。第一次卡在容器里下载字体，把本机字体放进快照后重跑。
