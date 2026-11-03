# 02：按工作空间 staticSchema 接入 Claude 并运行一轮测试

**What to build:** 在独立分支接入现有 Claude Code + OpenCode Go，以工作空间选定的已发布 staticSchema 驱动 Excel 转换和独立检查，运行真实模型测试。

**Blocked by:** 01

**Status:** resolved

**Trace:** 用户要求“OK，接入进行一轮测试”，补充“更泛用一些……工作空间中的 staticSchema”；流程 P04。

- [x] 从工作空间固定选定的 staticSchema 版本与内容，禁止模型另改目标定义。
- [x] 通用转换计划支持对象、列表、源单元格及显式类型转换，不硬编码线路/站点字段。
- [x] 复用 Claude Code 执行器及 OpenCode Go 代理，模型只能调用任务工具；代码在隔离容器中执行。
- [x] 用非公交工作空间与工作簿运行真实模型；记录所有工具尝试、独立检查、用量与故障修复。
- [x] 本地验证嵌套列表、多候选与错误拒绝；语义待审和产品未应用状态明确。
- [x] 完成密钥扫描、必要回归与文档。

**测试接缝：** 通用入口的 CLI、MCP 请求与实际 Docker 执行；引擎校验只走公开入口。业务期望值保留在模型不可访问的宿主验证侧。

## Answer

2026-11-03。在独立工作树 `F:/GenCode/render-weave-excel-prototype`、分支 `prototype/excel-agent-p04` 实现本地接入入口；父提交 `c9a32a902a84f535967c603e14a2b0583a54bb93`。实际结果和限制见[首轮报告](../../../docs/agent-eval/excel-agent-p04.md)，原始记录在该分支的 `scripts/prototypes/excel-agent/evidence-p04/`。

真实命令：

```powershell
node --import tsx scripts/prototypes/excel-agent/agent-run.ts --workspace fixtures/workspaces/price-tag --definition '商品价签@1' --workbook fixtures/excel/price-tags.xlsx --brief scripts/prototypes/excel-agent/fixtures/price-brief.md --out out/excel-agent-p04/live-01 --claude 'D:/nodejs/node_global/node_modules/@anthropic-ai/claude-code/bin/claude.exe' --inject-list-truncation
```

结果：退出 0；Claude Haiku 5.5 经 OpenCode Go，Claude Code 2.1.296；128666 ms、8 轮、2 次转换。初次宿主注入的列表截断被独立发现；模型重交原脚本后通过。6 份候选通过工作空间 staticSchema，70 个非空单元格全部分类；与模型未见的既有期望 JSON 逐身份逐字段比对 6/6 相同。数据仍未应用或出图。不是“模型自己的错误被修复”：两次 requested 脚本相同，实际 executed 脚本因注入而不同。

其他验证：

- `npm run build`、`npm run typecheck`：通过；编译时修正了使用未导出的 workspace 帮助函数，最终仅用公开读取入口。
- `python -X utf8 scripts/prototypes/excel-agent/test_generic.py`：11 项通过，覆盖任意字段的嵌套结构、显式类型、错序、第二份候选、目标锁定和来源失败。
- `python -X utf8 scripts/prototypes/excel-agent/accept.py --out out/excel-prototype/p04-regression`：P01–P03 原型 42/42 通过。
- `node node_modules/vitest/vitest.mjs run test/agent.test.ts test/mcp.test.ts --maxWorkers=1 --no-file-parallelism`：Agent 30 项通过，MCP 首次 27 通过 / 5 失败，原因是工作树没有字体。按开发环境约定复制已有字体后单独重跑 `test/mcp.test.ts`，32/32 通过。
- CLI 预检：未知 staticSchema 版本拒绝且不创建轮次；已存在轮次拒绝覆盖，均未调用模型。
- `node scripts/scan-keys.mjs out/excel-agent-p04/live-01 scripts/prototypes/excel-agent src/agent/run.ts`：69 个文件，命中 0。归档后连同新报告、票据与源码再扫描 108 个文件，命中 0；真实运行记录的源码哈希全部匹配，12 份相关 Markdown 的本地链接无失效项。
- 验收结束 `docker ps -a --filter label=renderweave.prototype=excel` 无遗留容器。

范围偏差与边界：接入在本地专用入口，尚未扩展正式 `renderweave agent run` 的图像输入合同、检查点或审核应用。真实模型只跑了一个价签样本；没有自行追加付费轮次。模型备注里会员价缺省位置描述有误，已在报告说明，未篡改原文。样本数据正确不代表自由文本与所有 schema/表式均已验收。Postman 技能用于先明确工具合同；当前 CLI 不支持 `postman status`，本次本地 MCP/真实会话验证不依赖 Postman 集合。

下一步：P05 接多候选审核、人工修正与应用；补复杂引用/嵌套数据的真实模型与较大样本验证后，再决定正式产品接入范围。
