# 09: 保存模板修订前看到结构化差异与前后对比，随时指回旧修订

**What to build:** 发布模板修订页：结构化差异、同一份样例数据集改前改后的对比图、修订历史与指回；基准不符时显示两边差异，确认后才覆盖。

**Blocked by:** 01、07

**Status:** resolved

**Trace:** [P1 PRD](../spec.md)「发布模板修订页」；用户故事 20、21、23；验收 A05、A11；M265、M299；原型画板 12。

- [x] 结构化差异按元素路径列出改动，标出新增、删除与修改的属性。
- [x] 改前改后对比：当前修订与工作副本用同一份样例数据集各渲染一张，可以换样例数据集。
- [x] 保存为新修订；基准修订已变时显示两边差异，明确选择覆盖才保存。
- [x] 修订历史：修订号、主体、时间、来源（推送或网页）；指回任一旧修订，指回前确认。
- [x] 保存与指回之后的提示写明审计已记下主体与前后内容哈希。
- [x] 多份数据集的改动影响一段在 P3 接入前不显示。
- [x] 浏览器用例走通"改字号 → 看差异与对比 → 保存 → 指回上一修订"。

**测试接缝：** 控制台浏览器用例（Docker 后端那组）；页面只调开放 API。

## Answer

完成于 2026-11-02，提交 98d981b，分支 `claude/confident-ellis-ffa1d9`。判断记在 M356。

**成果**

- `service/console/src/pages/template-publish.tsx`：发布修订页，地址 `#/templates/{名称}/publish`，改子模板时带 `?in=调用它的模板`。
- `service/console/src/components/revision-changes.tsx`：结构化差异按元素路径列出，标出新增、删除与修改的属性；两边都是对象的属性往里展开到变了的子键。
- 模板列表与只读预览加了设计、发布修订、修订历史与复制为新模板的入口（`service/console/src/pages/templates.tsx`）。
- 接口只调开放 API，OpenAPI 没有变化。

**验证**

- 浏览器用例「发布模板修订（P1 票据 09）」走通改字号、看差异与对比、保存、指回上一修订；另核对审计的主体与前后内容哈希、基准已变时不带覆盖答 409、勾选之后才能覆盖、操作员只读。
- `npm run typecheck`、`npm run typecheck:service` 通过，`service/` 下 `npm run build` 通过。
- `npx vitest run --project service`：21 个文件通过、1 个跳过，189 项通过、19 项跳过（跳过的是要设 `RW_BROWSER` 的浏览器用例）。
- 设 `RW_BROWSER`（Edge）跑 `npx vitest run --project service service/test/console.browser.test.ts`：17 项通过、2 项跳过。
- `RW_ALPINE_MIRROR=https://mirrors.aliyun.com node service/scripts/test-docker.mjs`：退出码 0，20 个文件 174 项全过，日志 2050 行、不合格 0 行。之前有一轮 15 项失败，`worker` 主机名解析不到，同样的代码独占 Docker 重跑全过；推断是与票据 06 的同一个 Compose 项目撞车，记进了 `docs/dev-setup.md`「已知的坑」。
- 引擎组没有重跑：这两张票没改 `src/` 与 `schemas/`。

**偏差**

- 这条用例的"改字号"经接口暂存，页面从差异开始；从设计页改字号一路走到发布，在票据 08 的用例里。
- 多了两样票据没列的：丢弃工作副本的按钮；复制为新模板（用户故事 22，放在模板列表上）。
- 还没做真人走查，归票据 13。
