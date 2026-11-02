# 04: 经开放 API 新建、保存、校验与删除数据定义草案

**What to build:** 服务端的数据定义草案：每个名称至多一份，可从空白或某个静态版本新建，带预期哈希整份保存，校验并预览编译产物。

**Blocked by:** 03

**Status:** resolved

**Trace:** [P1 PRD](../spec.md)「角色、权限与寻址」「数据定义草案」；用户故事 2、3、4、5、6、7、29；验收 A02、A10；M297、M298。

- [x] 权限矩阵加 `definitions.write`、`templates.write`、`authoring.publish`、`authoring.approve`、`authoring.policy`，按 PRD 分给客户管理员与代建工程师；客户操作员与 API 密钥只读。
- [x] 列出本租户的数据定义：每个名称的静态版本、有没有草案、草案基于哪一版，以及各版本被多少数据集与模板使用。
- [x] 新建草案：空白（名称、显示名称），或从某个静态版本另起；名称已有草案时拒绝。
- [x] 保存：整份替换，按原始字节存，带预期 SHA-256，不符答 409 并给当前哈希。
- [x] 校验回答问题清单，定位到字段；编译预览回答 `compileStaticSchema` 的产物。
- [x] 与基于的版本相比，删除与改名的字段列为"会影响绑定"，并列出用到它们的模板。
- [x] 删除草案。
- [x] 客户端点与代建端点（路径带目标租户）共用一份实现；全部进权限矩阵与跨租户端点清单；每次写入记审计，带前后内容哈希。
- [x] 迁移的新表启用行级安全；OpenAPI 快照只有加法。

**测试接缝：** 开放 API，内存后端进 `npm test`，行级安全在 Docker 后端测；五种身份逐项覆盖。

## Answer

完成于 2026-11-01，提交 0beeb24。接口写法见[开放 API · 数据定义草案](../../../docs/api.md#数据定义草案)，判断记在 M351。

**成果**

- **权限**：矩阵加 `definitions.write`、`templates.write`、`authoring.publish`、`authoring.approve`、`authoring.policy`。客户管理员五项全有，代建工程师有前三项，操作员与 API 密钥只读（`service/src/api/permissions.ts`）。
- **迁移** `service/migrations/0011_definition_drafts.sql`：每个名称至多一份，记基于的版本，内容按原始字节存进本租户的内容，开行级安全。
- **端点** `service/src/api/definitions.ts`：列出 `GET /v1/definitions`；`POST`、`GET`、`PUT`、`DELETE /v1/definitions/{name}/draft`；`GET …/draft/check` 校验并预览编译产物，列出会影响绑定的字段与模板。代建端点是同一份实现，路径带目标租户。
- **引擎新公开入口** `templateFieldUses`（`src/template/field-uses.ts`）：模板读到了哪些字段，路径沿单引用往下走。
- **审计**：`definitionDraft.create`、`.save`、`.delete` 记前后内容哈希，保存的差异摘要逐字段。代建工程师的读取另记 `authoring.read`。
- **OpenAPI** 升 1.2.0，只做加法。

**验证**

- 新用例 `service/test/definitions-suite.ts` 8 项（内存后端进 `npm test`，PostgreSQL 在 Docker 组）；`test/template-field-uses.test.ts` 6 项；权限矩阵与跨租户端点清单各加 12 个端点；`rls.docker.test.ts` 把新表纳入。
- 变异核对：去掉预期哈希检查，保存那条用例失败；不沿引用往下走，引擎用例失败（这一处第一次没被抓到，因为 M402 没有基准字段经单引用的路径，补了一条用例）。
- 在 worktree 的最终提交上（与 04、05、07、10、12 五张票一起）：`npm run typecheck`、`service/` 下 `npx tsc --noEmit` 与 `npx tsc -p console/tsconfig.json` 通过；`npx vitest run --project service` 144 项通过、17 项跳过（浏览器用例的本机快速版，要设 RW_BROWSER），连跑四次没有偶发失败。
- Docker 后端 `node service/scripts/test-docker.mjs`：20 个文件 172 项全过，三个服务的结构化日志没有不合格的行。这也是合入 M350 之后第一次跑通整组。
- 引擎组（不含 `agent-*` 重型文件）：42 个文件 894 项全过。控制台浏览器用例本机快速版（Edge，内存后端）：15 项通过、2 项跳过。

**偏差**

- 校验走 `publishStaticSchema`，不是 PRD 写的 `checkDslDocument` 加 `compileStaticSchema`：解析问题相同，产物相同（用例核对），还能提前报写错版本号。理由见 M351。
- 校验与编译预览合成一个端点；`PUT` 的 `expectedSha256` 一律必填，PRD 的"首次保存不带"就是新建。
- 空白新建不能用已有静态版本的名称（409），PRD 没写，理由见 M351。
