# 模板边界与视觉核查

`agent run --checks <计划.json>` 给本轮指定宿主核查计划。StaticSchema、数据集与示例图仍是已有输入。计划保存在 Agent 工作目录之外；Agent 只能读取副本。`check_outcome`、轮次结束、审核修改与应用共用核查实现，每次从当前候选重新计算。

宿主报告在 `check.json` 的 `assessment.design`，包含候选/计划/请求/数据/资源/示例图内容绑定指纹。失败保留总数及前 40 项、每例未覆盖保留总数及前 12 项，细节截断由 detailsTruncated 标记。声明的边界或样式失败使成果不合格；`passed` 仅表示计划里的检查通过，`uncoveredCount` 和 `content: needsReview` 继续说明未覆盖要求。接续沿用原计划，计划被改动时拒绝继续。

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

SSIM 使用 7×7 均匀窗口、总体协方差、亮度范围 255、K1=.01、K2=.03，边缘窗口截短。它与 Gaussian 11×11 版本分数不可混比。计算依据见 [SSIM 原论文](https://www.cns.nyu.edu/pub/lcv/wang03-reprint.pdf)；[scikit-image 参数说明](https://scikit-image.org/docs/stable/api/skimage.metrics.html#skimage.metrics.structural_similarity)也明确窗口、数据范围和协方差约定会影响结果。

这些分数用于定位和比较修复前后，不证明文字正确、信息完整或模板泛化。大片相同背景仍会抬高全图分数，所以同时保留局部指标、毫米要求和未覆盖情况。只有原始数据对应的 reference 用例做像素对照；变更站数或状态后不与原图强行逐像素比。

Agent 默认收到最多 8000 字符的 design 摘要（状态、总数、失败与低分区域），`check_outcome({"designCase":"用例ID"})` 按需取单用例详情；截断时有 truncated 标记。通过已有 `view_image` 和 `render_draft` 的区域参数按需查看局部。完整报告和热图可在轮次结束后生成：

```powershell
npm run build
node scripts/verify-template-design.mjs --round <已保存轮次> --plan <计划.json> --out <新目录>
```

输出 report.json、plan.json、reference.png、actual.png、heatmap.png。脚本不调用模型，失败退出 1，不能覆盖已有输出目录。热图红色越深表示差异越大；不是模板修改后的新图。原始参考若为 JPEG，reference.png 保留其编码字节供浏览器识别。
