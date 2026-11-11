# 01: 不开工作副本也能读模板内容，只看不改不再留审计

**What to build:** 开放 API 加读当前修订内容的端点；设计页打开时只读内容，第一次改动才开工作副本。

**Blocked by:** 无

**Status:** resolved

**Trace:** [PRD](../spec.md)；用户故事 1、4；验收 A02、A03；方案第 12 节；M356、[P1 验收](../../../docs/p1-acceptance.md)「后续」第 5 项。

- [x] 新端点（如 `GET /v1/templates/{name}/content`）回答当前修订的原文、内容哈希与修订号，权限是 `tenant.read`；代建端点同形。不存在答 404，进跨租户端点清单。
- [x] 打开设计页：有工作副本读工作副本，没有就读内容；这一步不写任何东西。
- [x] 第一次改动才开工作副本，然后暂存。开的时候当前修订已经变了，回答 409 时提示读回最新内容，不悄悄盖掉。
- [x] 只看不改离开页面：审计里没有 `templateWorkingCopy` 的 `create`、`delete`。
- [x] 基准已变而这边没有改动的旧工作副本，打开时换成当前修订（M356），这条行为保留。
- [x] `docs/api.md` 记变更，OpenAPI 快照更新，小版本加一。

**测试接缝：** 开放 API 用例；浏览器用例核对只看不改的审计。

## Answer

完成于 2026-11-05，分支 `worktree-template-design-page`。

**成果**

- `GET /v1/templates/{name}/content` 与代建端点（`service/src/api/template-copies.ts`），开放 API 1.14.0。
- `service/console/src/template/session.ts`：打开时只读内容，第一次写回才开工作副本；`DesignDoc` 多一个 `opened`。
- 取代 M356 的"打开设计页就开工作副本"（M393 写明的例外）。

**验证**

- `npx vitest run --project service service/test/template-copies.test.ts service/test/api.test.ts service/test/openapi.test.ts`：3 个文件 27 项通过，含权限矩阵、跨租户清单与 OpenAPI 快照。
- 新增 `service/test/template-session.test.ts` 6 项：只读不写、第一次写回才开、打开后别处改了按冲突处理、都撤销后删掉、旧副本丢掉、已有副本直接暂存。
- 设 `RW_BROWSER`（Edge）跑 `console.browser.test.ts -t "模板设计|发布模板修订"`：3 项通过，内存后端。新增的步骤核对只看不改没有工作副本、审计没有 `templateWorkingCopy.*`。
- `tsc --noEmit -p service/console` 通过。Docker 后端留到票据 11。

**偏差**

- 打开之后当前修订变了：第一次写回时才发现（开工作副本得到的内容和读到的不同），走现有的"别处先改了"提示，用户选盖过去或读回最新内容。
