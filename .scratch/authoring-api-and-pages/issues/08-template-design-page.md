# 08: 客户管理员在模板设计页点选元素，用属性面板、参数、结构与规则做小改

**What to build:** 模板设计页：草稿预览上点选元素，属性面板按 DSL 的 JSON Schema 生成并写回工作副本，另有参数、结构、规则三页；暂存、切换样例数据集与模式、缩放、右键菜单。

**Blocked by:** 01、07

**Status:** resolved

**Trace:** [P1 PRD](../spec.md)「属性面板、参数、结构与规则」；用户故事 13–19、27；验收 A06、A11；M205、M299；原型画板 10。

- [x] 预览上点选元素：按布局摘要的元素框命中，按元素定位打开模板文档里的位置；选中框与元素路径显示在图上。
- [x] 属性面板按 `schemas/template.schema.json` 里该元素类型的属性生成：位置尺寸、文字、图片、颜色、绑定、条件显示、状态样式、适配；只能填数，不做自由拖拽。
- [x] 参数页：对外参数与内部参数的显示名称、类型、约束与缺省值。
- [x] 结构页：元素树（容器、循环容器、子模板调用），与预览选中双向同步；子模板调用可打开子模板的设计页。
- [x] 规则页：所选元素相关的检查项、缩字组、字形压缩下限与缩字下限。
- [x] 每次改动重渲染草稿预览并刷新问题清单；页面内可撤销、重做；"保存"暂存工作副本，并显示未保存的改动数。
- [x] 工具栏：选择、平移；切换样例数据集（含压测数据）、草稿与正式模式、缩放。
- [x] 右键菜单：复制元素路径、在结构中定位、打开绑定的字段。"让 Agent 修改""留评论"在 P2、P4 接入前不显示。
- [x] 每种元素至少一项属性改动的浏览器用例：写回后通过 `checkDslDocument`，预览随之变化。

**测试接缝：** 控制台浏览器用例（Docker 后端那组）；属性面板的生成规则另有单元测试，只经"给元素类型与文档、得到可编辑项与写回结果"这一入口。

## Answer

完成于 2026-11-02，提交 77312ef，分支 `claude/confident-ellis-ffa1d9`。判断记在 M356。

**成果**

- `service/console/src/template/properties.ts`：属性面板的生成规则，入口是 `propertyPanel`、`writeProperty`，参数与检查项走 `listItemPanel`、`writeListItem`。属性全部来自 `schemas/template.schema.json`，`if/then` 的收窄生效，写回时修掉因这次写入失效的相邻属性。
- `service/console/src/template/session.ts`：编辑会话，管页面里的文档、撤销与重做、暂存。
- `service/console/src/pages/template-design.tsx`：设计页，地址 `#/templates/{名称}/design`；`service/console/src/components/property-fields.tsx`：字段。
- `fixtures/workspaces/all-elements/template-all-elements.json`：十二种元素都有的模板，单元测试与浏览器用例共用。
- 接口只调开放 API，OpenAPI 没有变化。

**验证**

- 单元测试 `service/test/template-properties.test.ts` 45 项，只经生成与写回的入口，结果由引擎的 `checkDslDocument` 判断；含每种元素、每个顶层属性、每个变体的穷举。
- 浏览器用例「模板设计（P1 票据 08）」：十二种元素加画板各改一项属性，写回后 `checkDslDocument` 没有严重问题，预览随之变化；另走撤销、重做、写回失败重试、别处先改了时盖过去、参数、结构、规则、缩字组、工具栏、右键菜单、子模板、发布与复制为新模板。
- 变异核对：写回时不修相邻属性，16 项单元测试失败；暂存之后不重新预览，浏览器用例失败。
- `npm run typecheck`、`npm run typecheck:service` 通过，`service/` 下 `npm run build` 通过。
- `npx vitest run --project service`：21 个文件通过、1 个跳过，189 项通过、19 项跳过（跳过的是要设 `RW_BROWSER` 的浏览器用例）。
- 设 `RW_BROWSER`（Edge）跑 `npx vitest run --project service service/test/console.browser.test.ts`：17 项通过、2 项跳过。
- `RW_ALPINE_MIRROR=https://mirrors.aliyun.com node service/scripts/test-docker.mjs`：退出码 0，20 个文件 174 项全过，日志 2050 行、不合格 0 行。之前有一轮 15 项失败，`worker` 主机名解析不到，同样的代码独占 Docker 重跑全过；推断是与票据 06 的同一个 Compose 项目撞车，记进了 `docs/dev-setup.md`「已知的坑」。
- 引擎组没有重跑：这两张票没改 `src/` 与 `schemas/`。

**偏差**

- **改动自动暂存**：预览只渲染存下来的工作副本，所以改完约半秒写回，"保存"是立刻暂存。"未保存的改动数"平时一闪而过，写回失败时才留着。代价是审计里每次写回一条。切换条件在 M356：真人走查觉得"保存"多余或审计太吵，就给预览加带内容的写法。
- **正式模式不另出图**：预览接口只出草稿，页面按相同的问题清单说正式出图的结果。只有提示时图上还有问题边框，页面写明了。
- **只看不改也有两条审计**：开放 API 读不到当前修订的内容，打开设计页要开工作副本，离开时内容没变就删掉。
- **压测数据靠名称认**：名称或 ID 里有"压测"、"压力"、`stress` 的单独一组，数据集没有这个类型。
- **"打开绑定的字段"跳到数据定义**：地址是 `#/definitions/{名称}?field={字段}`。票据 06 合入前落在列表页；合入后能打开详情，还不会按 `field` 展开那一行。
- 点选按布局摘要的元素框，不计旋转，与预览上的问题框相同。
- 还没做真人走查，归票据 13。
