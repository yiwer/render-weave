# 区域反馈与停止条件：事前登记

本次从另一位 agent 的观察中选择两个可证伪假设：两条反馈若指向同一参考区域，会挤掉另一区域；完整检查通过后继续修改可能增加成本或回退。另用固定源码探针核查参考框、字号和未测量边界。

## 固定条件

沿用 [上一批协议](template-repair-feedback-protocol.md) 的 C 位置坏例：站点面板 padding.top 4→10 mm，下一站区 padding.left 8→20 mm。参考来自维护中的 M402 正例，不是任意 PNG 的自动真值；StaticSchema 和示例数据集已给出。

四单元顺序：c-1-role、c-1-region、c-2-region、c-2-role。每单元固定两轮、每轮 maxTurns=20，主/小模型均 claude-haiku-5-5。通过现有 runAgentTask 串行执行；计时期间不运行测试、编译或其他模型。用户级 OPEN_CODE_API_KEY 只传进程，不入库。

两臂反馈文案、排序、上限相同。role 每角色最多一项；region 使用预先登记的映射：badges/stations 属 station-panel，next-stop/next-landmark 属 next-stop-panel，其他角色各自独立。均优先内容、字号、位置，再按严重程度和 ID 排序，最多两项、1200 字符。该映射是参考区域归组，不声称自动定位了错误根因。

## 停止与计分

目标修复、全部检查通过、新增失败相对初始、第二轮相对第一轮回退分别记录。沿用平均字号对数误差 ≤ln1.1、平均中心误差 ≤0.005，以及改名/currentIndex=10 内容绑定回归。全检查不是最终像素可见性真值。

第一轮离线评分后立即写 stop-decision.json，绑定候选、评分哈希、时间；仅当技术 qualified、预登记检查 ID 集完整且全通过才 stop=true。无成果、缺项、重复、额外检查都不准停。第二轮仍真实执行，充当影子续跑；停止策略取已登记的前缀成果与实际前缀成本。共享第一轮，因此这不是两组独立随机化停止策略实验。报告全部实际八轮费用/耗时，单列可省的影子续跑成本。

## 复跑与范围

先测试、build、提交，再 `node --import tsx scripts/agent-eval/repair-experiment.ts --prepare out/repair-region-live --comparison role-region`；manifest 固定脚本、src、dist、agent、资源和输入指纹。使用 `node scripts/agent-eval/repair-live.mjs --root out/repair-region-live`。目录已存在则拒绝覆盖，质量失败不重试；额度或基础设施错误停止后续派发并保留。

票据 33 的提取覆盖不等于本任务重新 OCR 数据；本次只核对既有数据的展示与绑定。票据 34 关注可信参考、缺项/片段/坐标证据，不能把参考框高直接换成字号。票据 35 需要普通运行与评估共用可复现机制，本实验提供记录证据，不代替其产品接入验收。主检出与本分支票据状态分歧不自动同步，不关闭原票据。

同尺度叠图、OCR、墨迹掩码与领域字号默认值本次没有模型干预对照，不能宣称收益。保持产品 MCP、默认任务上下文和技术 verdict 不变。
