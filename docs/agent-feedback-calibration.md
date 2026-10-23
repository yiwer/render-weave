# 可信反馈校准

票据14准备中英文各四种任务：数据定义提取、数据集提取、模板辅助设计、模板辅助修改。每类预登记两次，共16个单元。本页中的假执行器只验证编排机制，不计入A15真实模型有效观测；真实模型验收归票据21，旧四场景及样式/状态审核仍归原票据38。

## 准备与检查计划

```powershell
npm run build
npx tsx scripts/agent-eval/prepare-feedback.ts --out out/feedback-calibration --resources fixtures/resources
npx tsx scripts/agent-eval/run.ts --config out/feedback-calibration/config.json --plan out/feedback-calibration/plan.json
```

准备目录必须不存在。命令从预先定义的合成事实经公开发布、渲染和Agent入口生成素材、核准基准、工作区、请求、反馈、范围政策与受控初始轮次。没有调用模型，也没有使用12张公交留出素材。模板每种语言有24个核准区域；第22区预置文字、字号、颜色和位置缺陷。数据定义预置字段名错误；数据集预置站名错误。

`seed` 是受控的已知缺陷初始成果，不是模型第一次自由生成的成果。后续真实观测只测量从这一初始状态纠偏的表现，不推断模型首次提取/设计的成功率。模型首次自由产物的能力另由业务回归和留出验收承担。

`--plan` 不需要key，不派发任务。缺素材、反馈、政策或核准事实会保留16个计划单元并列出缺失项；内容不符合初始轮次的身份时也不能标为ready。退出码0表示输入可用，3表示仍缺材料。ready仅表示可执行，绝不表示模型效果已验收。

## 冻结输入与执行

配置仍使用`renderweave-agent-eval-config/2`。反馈场景新增`kind: "feedback"`、`language`、四选一`task`、`seedRound`、`feedback`、`policy`，以及提取的`contentBaseline`或模板的`reference`。路径可绝对或相对仓库根目录。每类至少两次；每种任务沿用既有轮数预算，统一覆盖预算须在正式派发前登记。

实际派发经过原评估入口，然后调用`agent run --from <seed> --feedback <feedback>`。接续不能重复传入task/sample/brief/workspace等固定输入。评估身份固定初始轮次全部字节、继承工作区与实际资源、反馈、政策、核准资料，以及构建、实际提示词/资料来源、运行参数和评分器。每次尝试保留原件；同一实验变化条件必须新建实验标识。

准备后再修改实现或资料，须在最终候选冻结前重新准备并登记输入；不能把调试期间的准备物直接称为已冻结候选。原有0.10.x观测不能因为同为中文样例就移入新版计划。

## 核准事实与范围政策

提取基准沿用[视觉反馈中的内容事实](agent-visual-feedback.md)：定义任务以明确definition/field核对字段，数据集以values中的path/value核对实际值；只写name或模型coverage自述不会产生真值。未核准语义单列unknown。模板基准包含原图摘要、图像和画板尺寸、区域ID/实例路径、文字/字号/颜色/位置等独立事实；complete不代表全部维度已验证。

范围政策格式为`renderweave-feedback-policy/1`：

```json
{
  "format": "renderweave-feedback-policy/1",
  "candidate": "candidates/definition.json",
  "corrections": [{"pointer": "/fields/1/name", "before": "stpoName", "after": "stopName"}],
  "unknownIds": ["unapproved-semantics"]
}
```

pointer是JSON Pointer，数组索引从0开始，仅用于预登记的校准改动范围；它不改变产品数据集字段路径的1-based约定。每项必须给出不同的before/after，初始成果必须包含该before值。只有这些属性可变化；其他候选、字段、画板和数据保持原样。模板另以`requiredLaterPageRegion`指定必须在后续页实际取得并修复的区域。

## 结果解释

报告分别记录目标修正、非目标保留、未知范围保留、后续页取证和末次检查身份。目标修正成功但其他字段被改，仍是fail。仅调用一次compare_reference、只修第一页、提交说明声称正确、或零severe均不能替代这些判据。

模板实际沿nextRegionOffset续取，日志记录返回的区域目录和该页问题；最后一次有效compare_reference的reportId必须等于宿主终检，最后一次有效check_outcome的内容身份也必须相同。检查之后再改候选，旧报告不能证明当前成果。

计划完整列出pass、fail、invalid、not-run。已有有效失败不能被未运行项遮盖；额度中断保留invalid及剩余not-run，等待恢复后继续同一计划。尝试原件、总成本和未知成本沿用[评估报告](agent-eval.md)的规则。

校准报告显式保留证据类别及真实模型有效观测数量。机制验收的该数量为0；局部修正达线仍需把未测维度留给独立审核，不生成整体相似度或整体业务分数。
