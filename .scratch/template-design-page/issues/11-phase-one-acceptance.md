# 11: 第一期验收：逐张对照原型、真人走查、记下端到端耗时

**What to build:** 走完第一期的完成标准，反馈回炉之后才开第二期。

**Blocked by:** 04、05、06、07、10

**Status:** ready-for-agent

**Trace:** [PRD](../spec.md)「完成标准」；用户故事 26；验收 A01、A11、A12。

- [ ] Docker 后端测试、OpenAPI 快照、控制台严格类型检查全过。
- [ ] 真实服务上打点"改一项到换图"的端到端耗时，分别记写回、排队、渲染，写进票据的 Answer。
- [ ] 和 `docs/prototypes/template-design/screenshots/` 逐张对照，有意的差异写明原因。
- [ ] 真人走查 M402 与胸牌，主路径照 PRD 的完成标准。
- [ ] 分开记"行为已验证"与"观感已对照"，没对照的不写做完。
- [ ] 更新 `CONTEXT.md`、`docs/service.md` 的模板设计相关段落，走查的判断记 M 编号。

**测试接缝：** 全量；见规格「接缝」。
