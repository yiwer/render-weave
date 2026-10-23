# 模板反事实业务验收

维护者先固定输入变化、独立业务事实和允许联动，再用公开渲染入口生成实际图片、布局与报告。它补充原有十项技术压测；零严重问题、内部变量变了、整张图片哈希变了，都不能单独证明业务正确。政策由维护者提供，不采纳被测 Agent 的说明作为预期。

## 运行与证据

```powershell
npx tsx scripts/agent-eval/run.ts --behavior-policy policy.json --workspace candidate-workspace --resources fixtures/resources --out out/behavior/order-001
```

这个离线模式不要求模型 key、不调用模型、不应用工作区。`--workspace` 是待检查的完整工作区；模板修改先由维护者把工作副本叠加到副本中。必须提供 `--resources` 和新的 `--out`；同一输出目录不能再用另一份政策覆盖。与真实模型运行、续跑、重新评分的选项不混用。

退出码：`0` 表示本政策已声明的事实通过；`1` 有明确失败（含严重渲染问题）；`3` 无明确失败但缺独立事实或可靠测量；`2` 用法/文件错误。`coverage.complete` 仅表示六类均出现且各案例声明的事实均通过，绝不表示全图业务、全部样式或客户自助能力通过。没有列入政策的维度一直未核查。

`behavior.json` 使用 `renderweave-behavior-report/1`：

- `policy` 保存政策文件的 SHA-256、来源说明；`policy.json` 保留原字节。
- `workspace.json` 保存实际候选、数据定义及数据集；`candidates.sha256` 对应此文件字节。
- 每个案例存 `request.json`、`render.json`、`output.png`（JPEG 请求为 `output.jpg`）；报告关联输入请求及实际图片哈希，事实逐项列 `expected`、`actual`、路径、`pass/fail/notChecked`。
- `resources/<sha256>` 保留本案例渲染实际读取的图片/字体字节及 ID、种类、哈希。修改前后渲染共用这一份输入资源。
- 像素事实另存 `approved-<sha256>.png`；修改案例另存 `before-workspace.json`、`before-render.json` 和 `before.png`。
- `technical` 与业务事实分开；缺事实、未知事实种类、缺基线或不能可靠测量时不靠技术成功补成通过。

变更政策、输入或允许范围后另建实验和输出目录。不能事后扩大允许范围来解释旧实验失败；旧报告及其政策继续留存。统一候选冻结和真实模型门槛由后续票据处理。

## 政策合同

政策格式为 `renderweave-behavior-policy/1`。`id` 标识政策，`authority` 写维护者已核准事实的来源（人工作业单、独立标注或已批准样例）；程序不能替代组织对事实来源的批准。每个案例有唯一安全 `id`、`category`、输入变化 `change`、完整公开渲染 `request` 和 `facts`。相对文件路径相对于政策文件目录。

以下示例可直接对仓库的问候牌工作区运行，核查字段换值；它只覆盖一类，`coverage.complete` 为 `false`：

```json
{
  "format": "renderweave-behavior-policy/1",
  "id": "greeting-field",
  "authority": "维护者核准：显示内容应为 World，不能保留 Hello",
  "cases": [{
    "id": "changed-message",
    "category": "field",
    "change": "将 message 改为 World",
    "request": {
      "template": "问候牌",
      "dataset": {"inline": {
        "dataset": {"staticSchema": {"name": "问候", "version": 1}},
        "data": {"message": "World"}
      }},
      "parameters": {},
      "output": {"width": 160, "height": 40, "dpi": 60, "format": "png"},
      "mode": "draft"
    },
    "facts": [{
      "id": "message", "kind": "texts", "selector": "问候牌/问候语",
      "order": "x", "expected": ["World"]
    }]
  }]
}
```

`selector` 匹配公开布局的元素路径，`*` 是唯一通配符。每次循环出现独立核对，不按文字去重。文本和颜色序列必须给 `order: "x" | "y"`，按实际空间坐标排序；选择错误轴导致实例排序歧义时不能据此断言正确。

| 事实种类 | 独立预期与观察范围 |
|---|---|
| `texts` | `expected: string[]`；比较实际可见布局中的全部匹配文字、实例数与空间顺序，重复项各占一个位置；不等同于 OCR 或最终像素可见性 |
| `colors` | `expected: string[][]`；每实例实际文本片段颜色，颜色规范成 RGBA；配合文字事实核查参数状态 |
| `visibility` | `expected: boolean`；匹配元素及父级的布局显示/隐藏；不把元素不存在当作隐藏成功，不声明透明度/遮挡已测量 |
| `box` | `expected` 中明确给出 `x/y/width/height` 的所需数值，`toleranceMm` 必填；要求唯一匹配，适用于缺失可选信息后的空间释放 |
| `fit` | `expected: {minFontSize,maxFontSize,minCompression}`；同时要求文字无溢出、墨迹在画板内；实际绘制证据已确认完全透明、完全裁切或完全遮挡时失败，并在 `actual.visibility` 留证。复杂变换、部分/可能遮挡或没有墨迹证据仍记未核查。完整文字另外用 `texts` 核查 |
| `pixels` | `expected: {file,sha256}`、`regionMm: {x,y,width,height}`、逐通道容差 `tolerance`（0–255）；核准 PNG 必须是同 DPI 的区域图，比较区域内全部像素。参考字节改变或尺寸不同为未核查，实际区域出界为失败 |

像素事实适合核准的图片内容和可见性；不能只给资源名、全图哈希或自动从当前候选截出的图片。核准参考包含需要的背景合成。尺寸以本次 DPI 四舍五入到像素，参考图必须使用同一口径；不自动拉伸参考或放宽容差。一个案例可用 `resources: [{id,file}]` 为已有图片资源提供受控替换字节，仅影响本次内存渲染，原资源仓库不改变。

`fit` 不是全图可见性判据；有遮挡风险时必须另给核准像素或独立审核。票据 13 提供的有限不可见证据现已用于 `fit` 的明确失败；正常对象的 `visibility.status: unknown` 不单独否定字号、压缩与墨迹适配事实，也不证明最终感知可读。原票据 18 的主模板基准、33 的覆盖、34 的完整样式验收均保持原责任。

## 六类校准政策

以下预期写在离线公开入口测试的固定输入中，在候选生成和反例变异前形成；没有从被测候选或模型备注计算答案。

| 类别 | 输入变化与独立事实 | 合法对照与反例 |
|---|---|---|
| `field` | 问候内容换为 `World`；实际文字必须为 `World` | 正常变量插槽通过；写死 `Hello` 即使零严重问题也失败 |
| `list` | 先 `Alpha → Beta → Alpha → Alpha → Gamma`，再缩为 `Alpha → Gamma`；按各实例从左到右核对 | 正常循环通过；固定两项、反序、合并相邻同名项失败；合法同名实例保留 |
| `parameter` | 三站中将本站从 1 改为 2；首站红/黑切为灰/红，下一站从 Beta 切为 Gamma | 参数绑定通过；循环把本站写死为 0，实际状态错误而失败 |
| `optional` | `note` 有值占左侧 40 mm，缺值时隐藏且问候语移至 x=0 | 正常隐藏释放空间；仅隐藏容器内部文字、仍保留 40 mm 空白的反例失败 |
| `fit` | `Long station name`，目标宽度 80/160 mm；字号 5–10 mm、压缩至少 0.6、墨迹在画板内 | 正常适配通过；2 mm 过度缩字、移出画板、完全透明（颜色 alpha 或累计 opacity 为零）、完全裁切/遮挡失败；部分遮挡、部分裁切及复杂变换保留未核查 |
| `image` | 同名 `badge` 从左红右蓝换成左蓝右红，固定 10×10 的独立核准区域 | 对两个核准版本逐像素通过；整图变化但图案全绿的反例失败 |

校准运行：`npx vitest run test/agent-template-behavior.test.ts --maxWorkers=1`。它调用真实评估 CLI 和真实渲染器；不 mock 内部函数、不运行模型。它证明判据能区分这些受控正反例，不证明真实模型能使用反馈。

## 修改任务的两种允许范围

案例 `category: "revision"` 还须提供 `revision`：

```json
{
  "beforeWorkspace": "../saved-workspace",
  "targets": ["new-color"],
  "allowedChanges": [{
    "template": "问候牌", "path": "问候牌/问候语", "target": "element", "properties": ["color"]
  }],
  "allowedOutputChanges": [{"selector": "问候牌/问候语", "properties": ["colors"]}]
}
```

`targets` 指向本案例的独立事实 ID，必须非空才能完成目标。`allowedChanges` 是源模板允许变化的路径和属性（元素或模板级）；增删须显式 `change: "added" | "removed"`，不能靠属性列表放行整个元素。`allowedOutputChanges` 是公开渲染结果允许变化的实例范围与测量属性：`visible/box/text/colors/fontSizes/fonts/image/type`；实例增删用 `"*"`。布局联动必须在运行前声明，例如允许目标文字变宽，同时列出相邻元素的 `box` 可改变。

报告分别给出 `targets`、`nonTargets`、`changes/violations` 以及 `outputChanges/outputViolations`。源属性允许变化不自动放行其对非目标的输出影响；非目标保留是结构和公开布局的比较，不能替代未声明区域的像素审核。未修改目标、改了背景、未经声明移位的控制例分别失败；预先另立政策允许移位时通过，但使用不同政策哈希与报告目录。
