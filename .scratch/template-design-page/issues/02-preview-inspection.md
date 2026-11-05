# 02: 预览能答出一个元素实例的变量取值、命中分支与各实例的状态

**What to build:** 渲染入口与预览端点按元素路径带回求值结果，页面不用自己再算一遍。

**Blocked by:** 无

**Status:** resolved

**Trace:** [PRD](../spec.md)；用户故事 10、11、22；验收 A02、A04；方案第 12 节。

- [x] 引擎 `render` 加可选项（照 `elementLocations`）：给元素路径，回答这个实例所在作用域的全部变量（名称、种类、类型、当前值）、每个 `branch` 派生变量命中第几支、每个检查项是否成立。作用域在 `src/evaluate.ts` 展开时就有。
- [x] 同一回答带这个元素定义的全部实例：路径、状态样式 `states.by` 的取值。
- [x] 对外参数带来源：调用方的元素路径与 `args` 的运算数（变量、固定值或循环信息），页面据此画来源链。
- [x] `POST /v1/previews?workingCopies=true&inspect=<元素路径>`：回答多一个字段，渲染请求的 DSL 不变（同 M352 的写法）。路径不存在时这个字段为空，不报错。
- [x] 回答有上限：列表只给项数，引用只给一层字段，超长文本截断。
- [x] 不要就没有；要了不改变图片、问题清单与布局摘要。代建端点同形。

**测试接缝：** 引擎公开入口，M402 的 `站点列[12]` 与 `站点列[5]`（`stopState` 的命中不同）；开放 API 用例。

## Answer

完成于 2026-11-05，分支 `worktree-template-design-page`。

**成果**

- `src/inspection.ts`：展开时记下每个实例的作用域，展开完按元素路径回答；`render` 加可选项 `inspect`，公开类型 `ElementInspection`。
- `Scope` 加 `branchHit`、`checkFailed`，`VariableTable` 加 `names()`。
- `POST /v1/previews?inspect=<元素路径>` 与代建端点，回答多一个 `inspection`，开放 API 1.15.0。渲染请求的 DSL 不变。
- 状态样式的变量从模板原文档读（model 求值时已合并掉）；能确定的取值用现成的 `table.knownValues`，页面不用再从分支推。

**验证**

- 新增 `test/element-inspection.test.ts` 5 项，M402 的 `站点列[12]`、`站点列[5]`、根模板、隐藏元素与不存在的路径：`index` 来自循环序号、`stopNameSize` 追到主模板的内部参数、`stopState` 命中分支、实例状态计数 已过站 4、本站 1、未到站 30；要了不改变图片字节、问题与布局摘要。
- `service/test/template-copies-suite.ts` 新增 1 项走开放 API，回答都按 OpenAPI 描述校验，含 `workingCopies` 与 `inspect` 一起用。
- `npx vitest run --project service service/test/template-copies.test.ts service/test/api.test.ts service/test/openapi.test.ts` 通过。Docker 后端留到票据 11。
- `npm run typecheck` 通过。`tsc -p service` 里 `console-suite.ts` 有 5 处 `HTMLElement | SVGElement` 的报错，那几行这张票没动；只看不影响用例运行，留作单独处理。

**偏差**

- 票据 08 落地时改了入口：`inspect` 不再是预览的查询参数，换成 `POST /v1/previews/inspection`，引擎入口换成不出图的 `inspectElement`。原因：每次点选都要变量值，走预览就要多出一张图、占每分钟 60 次的额度（用例里实测，点几下就会撞限）；求值本身不用绘制。分支还没合入，没有兼容问题。

- 回答没带检查项的显示名称：`CheckModel` 没读进来，页面有模板文档，用文档里的。
