# 01：验证工作簿读取、隔离转换和独立核对

**What to build:** 在独立原型分支上证明固定工作簿视图、受限 Python 转换及宿主独立核对能够处理双方向数据并拒绝注入缺陷。

**Blocked by:** 无

**Status:** resolved

**Trace:** [父规格](../spec.md)；M359–M361；流程 P01–P03；A01/A02/A03/A04/A06/A08/A09 的机制子集，不代表这些业务验收项全部完成。

- [x] 固定 `.xlsx` 原件与哈希；保留坐标、合并、时间格式、空格、前导零、公式缓存状态和隐藏数据。
- [x] 双方向不同列组可生成两份候选，保留顺序、重复值、完整站名与字段来源。
- [x] 宿主独立发现漏站、列表截断、误去重、错序、缺少候选、伪造来源和未分类区域。
- [x] 通过公开引擎入口逐份核对数据定义；第二份候选的非法值不能漏检。
- [x] 实测无宿主挂载、秘密隔离、无外网及运行限制；超时、超量、取消、半写、符号链接和异常 JSON 不冒充成功。
- [x] 保留完整证据、复跑方法；机械通过仍标语义待审，不宣布模型或业务验收通过。

**测试接缝：** `prototype.py` 的公开子命令、实际 Docker 子进程和引擎公开入口；期望值独立人工列出，脚本及 ZIP 故障从边界注入。没有复制旧项目实现。

## Answer

2026-11-03 完成原型验证。独立工作树 `F:/GenCode/render-weave-excel-prototype`，分支 `prototype/excel-agent-p01-p03`，基础提交 `1376daa7a422dbcefffa7ea4b03a9d8ef6e16cf2`。原型源码、夹具和证据在该分支的 `scripts/prototypes/excel-agent/`；结论见[机制报告](../../../docs/agent-eval/excel-data-prototype.md)。

运行结果：

- `python -X utf8 scripts/prototypes/excel-agent/accept.py --out out/excel-prototype/acceptance-final`：最终归档 `evidence/results.json` 为 **42/42 通过**，`realModelRun: false`、`productionReady: false`。
- `npm run build`、`npm run typecheck`：通过。首次类型检查缺少构建产物；构建后重新检查通过。
- `python -X utf8 -m py_compile` 检查原型 Python 文件：通过。
- `docker ps -a --filter label=renderweave.prototype=excel`：验收结束无遗留容器。
- 验证环境：Python 3.13.13、Node 24.12.0、Docker Linux 引擎 29.2.0。固定镜像与源码 SHA-256 见证据；工作树独立安装锁定的 Node 依赖，主检出依赖未改动。

早期完整运行分别为 35/35、41/41；补齐引擎检查、取消和异常 XML 探测后，最终 42/42。只将最终版本标为归档依据，未把历史测试拼成一个结果。

边界：脚本由人工编写，错误后修复由验收程序安排；未调用 Claude/OpenCode Go。读取器只实现受限 `.xlsx`；机械检查仅覆盖 copy/collect，语义保持待审核。未实现产品输入分支、模型任务工具、人工修正、应用、出图、真实制作表验收或托管安全复核。ADR-0028 不因本票关闭而自动定稿。

下一步：P04 接现有 Claude Code + OpenCode Go，以相同夹具运行真实模型修复循环并记录全部尝试，再用实际制作表和人工核准结果校准业务判据。
