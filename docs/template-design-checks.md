# 模板边界与视觉核查

`agent run --checks <计划.json>` 给本轮指定宿主核查计划。StaticSchema、数据集与示例图仍是已有输入。计划保存在 Agent 工作目录之外；Agent 只能读取副本。`check_outcome`、轮次结束、审核修改与应用共用核查实现，每次从当前候选重新计算。

宿主报告在 `check.json` 的 `assessment.design`，包含候选/计划/请求/数据/资源/示例图内容绑定指纹。失败保留总数及全局前 40 项，每例另保留自己的失败总数及前 12 项；每例未覆盖也保留总数及前 12 项，细节截断由 detailsTruncated 标记。声明的边界或样式失败使成果不合格；`passed` 仅表示计划里的检查通过，`uncoveredCount` 和 `content: needsReview` 继续说明未覆盖要求。接续沿用原计划，计划被改动时拒绝继续。

## 核查计划

```json
{
  "format": "renderweave-design-checks/1",
  "basis": "项目审核人核准的区域及毫米范围；说明依据和允许替代",
  "cases": [
    {
      "id": "两站、本站1、保留原徽标",
      "changes": [{ "path": "/stops", "op": "resize", "length": 2 }],
      "parameters": { "currentIndex": 1 }
    }
  ],
  "styles": [
    {
      "id": "普通站名",
      "path": "主模板/站点区/站点循环*/名称",
      "cases": ["reference"],
      "minCount": 1,
      "expect": { "fontSize": { "min": 9, "max": 12 } }
    }
  ]
}
```

这里的字号只是格式示例，不能当所有项目的正确值。参考区域须由人核准，推断值应先与客户确认。

- `reference` 是自动执行的原始请求；再允许最多 23 个组合。每个组合从原数据独立复制，顺序执行自己的 changes。`path` 是相对 data 的 JSON Pointer，数组从 0 起；`resize` 缩短取前 N 项，扩展循环复制原项及全部可选字段。`set` 改已有字段，`remove` 删除已有字段；不存在的路径报错。可选字段缺省须另列用例，不能在构造极值时顺手删掉。
- `parameters` 合并覆盖原参数；`output` 可指定毫米宽高。所有结果仍经过完整数据校验和实际渲染。DPI 只控制采样成本，不改变毫米样式规则；核查图最长边约 2048 像素。
- `path` 匹配实际展开的元素路径，`*` 匹配任意字符。每个匹配实例都核查，缺省至少匹配一个。`cases` 缺省表示全部用例；普通、本站、已过、终点、最长文字应在各自参数/数据组合中声明对应范围。
- `expect` 支持毫米范围 `fontSize`、`spacing`、`x`、`y`、`width`、`height` 和允许的文字 `colors`。字号检查所有非空片段的实际字号；容许字体替代，未要求字体资源 ID 相同。位置是未计旋转的布局框，不能据此判断旋转后像素位置或遮挡层级。

## 像素诊断

可选 `reference: { "sha256": "示例图哈希", "region": { "x": 0, "y": 0, "width": 1000, "height": 223 } }` 指定参考图上的画板像素区域；region 缺省为整图。画板比例偏差超过 1% 时返回 `alignmentRequired`，不强行拉伸，不自动估计透视。

同一画板区域在白底合成后统一到最多 2048 像素长边，返回 RGB 平均绝对差的相似度、亮度 SSIM，以及 12×4 网格中最差的 5 个区域（小图减少网格数）。区域同时给出参考图像素坐标、候选画板毫米坐标、相交叶元素路径。路径关联是布局框相交的定位线索，不代表已判定哪个元素导致差异；每区最多列 12 个路径。

reference 可另列最多 12 个 targets：每项为 `{ "id": "header", "region": { "x": 0, "y": 0, "width": 1000, "height": 100 }, "goal": "顶栏内容的相对位置和层级", "approval": "proposed" }`。region 为原图像素坐标，必须位于参考画板内；评分窗口向外取整到比较采样格，返回有效比较坐标。approval 由宿主计划维护，proposed 是待核准目标，approved 是已有核准目标；两者均只提供视觉诊断，不自动产生 SSIM 及格线。数值硬要求仍明确写入 styles。

默认摘要只给命名区域 ID、核准状态和分数；`check_outcome({"designTarget":"header"})` 按需取目标、坐标和元素路径，仍受 8000 字符预算限制。修改 goal、approval 或区域会改变计划及证据指纹。M402 的待核准目标见 [design-targets.json](../scripts/agent-eval/scenarios/m402/design-targets.json)，不覆盖已归档 P1 计划。

SSIM 使用 7×7 均匀窗口、总体协方差、亮度范围 255、K1=.01、K2=.03，边缘窗口截短。它与 Gaussian 11×11 版本分数不可混比。计算依据见 [SSIM 原论文](https://www.cns.nyu.edu/pub/lcv/wang03-reprint.pdf)；[scikit-image 参数说明](https://scikit-image.org/docs/stable/api/skimage.metrics.html#skimage.metrics.structural_similarity)也明确窗口、数据范围和协方差约定会影响结果。

这些分数用于定位和比较修复前后，不证明文字正确、信息完整或模板泛化。大片相同背景仍会抬高全图分数，所以同时保留局部指标、毫米要求和未覆盖情况。只有原始数据对应的 reference 用例做像素对照；变更站数或状态后不与原图强行逐像素比。

Agent 默认收到最多 8000 字符的 design 摘要（状态、总数、失败与低分区域），`check_outcome({"designCase":"用例ID"})` 按需取单用例详情；截断时有 truncated 标记。通过已有 `view_image` 和 `render_draft` 的区域参数按需查看局部。完整报告和热图可在轮次结束后生成：

```powershell
npm run build
node scripts/verify-template-design.mjs --round <已保存轮次> --plan <计划.json> --out <新目录>
```

输出 report.json、plan.json、reference.png、actual.png、heatmap.png。脚本不调用模型，失败退出 1，不能覆盖已有输出目录。热图红色越深表示差异越大；不是模板修改后的新图。原始参考若为 JPEG，reference.png 保留其编码字节供浏览器识别。

## 检查点与纠偏

提供计划时才装配 docs/visual-refinement.md。首次骨架和每次核查前更新 state.json，再调用 check_outcome；工具返回 checkpoint.status 为 ready/missing/invalid。进度只表达 Agent 的设计选择、未解决项和下一步，缺失不把技术上合格的模板判成不合格。

已有宿主工具日志记录有效进度与候选快照。交接只采用最近检查点，候选变化后旧进度失效；没有检查点的旧轮次可回退到 state.json，但 progressSource=stateFile 并提示未经检查点绑定。匹配检查点可携带一份不超过 16000 字节的 scratch/visual-review.md，接续时恢复到同一路径，其他 scratch 文件和图片不复制。该详细记录仍是自述，按需读取，不能替代当前核查。

Agent 最多做两次局部纠偏，保存被改路径、原属性值和同一区域的前后指标；无进展或预算用尽时交回并列剩余差异。这是运行指导的上限，实际遵循情况要用日志观察，宿主没有自动改写模板或启动额外模型轮次。
