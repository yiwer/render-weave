# 交给业务 Agent 的资料

`renderweave agent run` 按任务把本目录的文件复制进轮次的 Agent 工作目录（见 [业务 Agent 任务](../docs/agent-tasks.md)）。Agent 只读这些资料、示例图与 MCP 工具返回的内容，不读仓库里的其他文件。

## 三层资料与优先级（M216）

| 层 | 文件 | 写什么 | 给 Agent 时的文件名 |
|---|---|---|---|
| 项目说明 | 每次发起时用 `--brief` 给出，模板见 [briefs/_template.md](briefs/_template.md) | 这一单的事实：尺寸、目标范围、命名、客户说明 | `docs/brief.md` |
| 领域约定 | [domains/](domains/)`<领域>.md`，用 `--domain` 选，模板见 [domains/_template.md](domains/_template.md) | 只在某个行业成立、跨项目都适用的约定 | `docs/domain-<领域>.md` |
| 通用做法 | [guide.md](guide.md)，每次都给 | 任何"示例图 → 数据定义 → 模板"都适用的做法 | `docs/guide.md` |

三者冲突时：项目说明 > 领域约定 > 通用做法。模板辅助修改的修改要求、下一轮的反馈另有更高的优先级，见任务提示词。

## 归属规则

沉淀一条经验之前，先问它在哪一层成立：

- **能用一句与行业无关的话说清的**，写进 `guide.md`。例如"一张示例图看不出是否随对象变化的公司名，建可选字段并列为待确认"。
- **只在某个行业成立的**，写进该行业的领域约定。例如"站名下方的带圈数字是地标图片"。
- **只关于这一单的**，写进项目说明。例如"站名上方的蓝色圆标是早期错误设计，忽略"。

判断不了时，先写进项目说明；在两个以上项目里重复出现，再上移到领域约定或通用做法。不要把评估场景的答案写进资料：领域约定与通用做法里的例子用别的业务（会议胸牌、价签等，M222），或只描述类别、不给具体值。

## 其他文件

| 目录 | 内容 |
|---|---|
| [tasks/](tasks/) | 任务提示词，每种任务一份；`next-round.md` 接在下一轮的提示词之后。只写做事步骤与各资料的用途，不含具体业务；占位符（如 `{sample}`、`{template}`）由命令填入 |
| [reference/](reference/) | DSL 参考（`data-definition.md`、`template.md`）与成果格式（`outcome.md`），示例用会议胸牌（M222），都在测试中实际校验 |
| [briefs/](briefs/) | 项目说明模板。评估场景的项目说明在 [scripts/agent-eval/scenarios/](../scripts/agent-eval/scenarios/) |

## 改了资料之后

改了本目录下的任何文件（包括提示词与 DSL 参考），都要跑一次评估，连续两次达线才算可以使用：

```bash
npm run build
npx tsx scripts/agent-eval/run.ts
```

评估场景、通过线与报告见 [Agent 评估](../docs/agent-eval.md)。新增一个领域时，先按模板写约定包，再至少用一张该领域的示例图实跑数据定义提取与模板辅助设计，并把结果记进验证记录。
