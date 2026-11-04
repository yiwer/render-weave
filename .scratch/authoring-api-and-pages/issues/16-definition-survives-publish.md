# 16: 发布不影响数据定义，版本可以自定义

**What to build:** 用户走查后纠正了模型：发布只是从数据定义产出一份静态数据定义，数据定义自己留着、能接着改；版本缺省是下一个编号，可以改成自定义的字符串。照旧 RenderWeave 做（`outside_context/legacy-renderweave/specs/renderweave-v1.md:54`、`:69`、`:250-255`）。

**Blocked by:** 13

**Status:** resolved

**Trace:** [ADR-0028](../../../docs/adr/0028-publishing-leaves-the-definition-and-versions-can-be-named.md)，M368；取代 M346 的"删除草案"与 M366。

- [x] 发布后草案留着，内容不变，基于的版本换成这一版；再发布与它比较。
- [x] 发布时能写字符串版本与发布说明；写法不对、同名已有都拒绝；`2` 与 `v2` 是同一个编号。
- [x] 模板的基准、数据集的 `staticSchema`、字段的 `ref` 都能引用字符串版本；整数继续有效。
- [x] 最新版本看发布的先后，不看版本的大小。
- [x] 数据定义列表、发布确认页、发布记录、静态版本页按新模型改；回退改成用旧版的内容覆盖草案。
- [x] 内存与 PostgreSQL 两种后端都支持（迁移 0015）；开放 API 升 1.10.0，放宽的字段逐条列出。
- [x] Docker 后端、验收脚本与引擎组全量回归通过。（引擎组有条件通过，见 Answer 的偏差）

**测试接缝：** `service/test/schema-version.test.ts`、`definition-publish-suite.ts`、`approvals-suite.ts`、`console-suite.ts`。

## Answer

2026-11-04 完成。决定在 ADR-0028 与 M368。

**成果：** 引擎的版本在 `src/workspace.ts`（`parseSchemaVersion`、`formatSchemaVersion`）与 `src/schema/publish.ts`；五份 JSON Schema；迁移 `service/migrations/0015_named_schema_versions.sql`；接口在 `service/src/api/definitions.ts`、`static-schemas.ts`、`approvals.ts`，开放 API 1.10.0；页面在 `service/console/src/pages/definition-publish.tsx`、`definitions.tsx`、`static-schemas.tsx`、`definition-studio.tsx` 与 `form/schema-version.ts`。

**跑过的命令与结果：** 见 [P1 验收](../../../docs/p1-acceptance.md)「验收之后的模型纠正」。

- `RW_ALPINE_MIRROR=https://mirrors.aliyun.com node service/scripts/test-docker.mjs`：21 个文件，202 项通过；日志 2,901 行全部合格。
- `node service/scripts/accept-p1.mjs --walkthrough`：15 步全过。
- `npx vitest run --maxWorkers=4`：1,501 项通过、17 项失败；1 项已改，16 项在 `agent-*`，串行复核后只剩 `EPERM` 那 1 项。
- 控制台相关 6 个文件 64 项通过，2 项只在 Docker 后端跑。
- Linux：构建、两项类型检查通过，相关 11 个文件 170 项通过。

**偏差：**

- **和旧项目不同的一处**：版本缺省仍是编号，旧项目必须手填。用户定的。
- **开放 API 不再只有加法**：`version`、`baseVersion` 放宽成整数或字符串，发布后 `GET …/draft` 不再答 404；放宽的 12 处列在 `service/test/openapi.test.ts`。A01 按这一条有出入。
- **Agent 先不用自定义版本**：工具合同的版本仍是整数。
- **没有做**：草案的修订历史（M360 没做）。所以"用这一版覆盖草案"之后，草案原来的内容恢复不了，页面上先确认。
- **`npm test` 仍是有条件通过**（验收文档「后续」第 1、2 项）；Linux 全量没有跑。
- **真人没有走过新页面**：观感只有截图。

## Comments
