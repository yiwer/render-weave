# 两例模板修改种子（待独立审核）

两例是人工准备的有效已有模板，唯一预置缺陷均为英文字色 `#172B4D`；任务只允许改为 `#FFFFFF`。种子不是模型之前的答案，也不计真实模型观测。原始素材没有进入生成工作区或 Git。

| 案例 | 中文原文 | 英文原文 | 模板与数据定义 | 数据集 |
| --- | --- | --- | --- | --- |
| stop-name-02 | 梧岗宝桐路口 | Wugang Baotong Rd Crossing | holdout-stop-name-02 | ds-holdout-stop-name-02 |
| stop-name-03 | 无名站（龙岗-沿河路） | This is English Name | holdout-stop-name-03 | ds-holdout-stop-name-03 |

两例均为350×950mm、蓝底 `#0154A4`。`stop-name-zh` 用真实文本插槽 `stopNameZh` 逐字竖排，保持白字；`stop-name-en` 用真实文本插槽 `stopNameEn` 保持一整行横排，再顺时针旋转90度。只使用 fixtures 的 `font-hei-medium`，没有整图贴图或系统字体。第三例的英文是字面占位原文，中文全角括号、半角连字符全部保留。

种子的字体、字号和位置是人工准备值，需结合前后预览核准；不宣称它们是原图字体或精确复刻的真值。完整可渲染不等于业务审核通过，生成记录始终保持 `awaiting-independent-human-approval` / `approval: pending`。

## 生成接口

```ts
import {prepareHoldoutSeeds} from './scripts/agent-eval/prepare-holdout-seeds.ts';
const prepared = await prepareHoldoutSeeds({out: 'out/新的种子目录', resources: 'fixtures/resources'});
// {root, cases: [{id, workspace, correctedWorkspace, request, requirement,
//                allowedChange, beforePreview, afterPreview, validation}]}
```

返回的路径均为绝对路径。也可运行：

```powershell
node --import tsx scripts/agent-eval/prepare-holdout-seeds.ts --out out/新的种子目录 --resources fixtures/resources
```

`out` 必须不存在；已存在时立即拒绝，不能覆盖之前准备、观测或核准过的内容。父目录可自动创建。导入模块不会自行生成材料，函数不运行 Agent、不访问模型、不读取凭据。

每例输出：

- `workspace/`：已发布的定义、编译产物、固定数据集及有单点颜色缺陷的已有模板。
- `corrected-workspace/`：独立改色对照；数据定义、编译产物、数据集字节与原件相同。
- `request.json`：正式出图请求，350×950mm、120dpi、PNG，与订单预登记一致。
- `requirement.md`、`allowed-change.json`：保留范围、唯一属性变化及前后模板哈希；不能给后续模型提供 corrected-workspace 作为答案。
- `preview-request.json`、`preview/{before,after}/`：仅用于人工查看的40dpi草稿预览（551×1496像素），与正式验证分开标注。
- `validation/{before,after}/`：使用正式请求生成的120dpi图（1654×4488像素）、问题清单和布局摘要。
- `validation.json`：发布、渲染、文档一致性、公开模板差异及PNG像素证据；字体内容身份和请求哈希。根目录 `manifest.json` 提供全套引用。

## 已验证证据

2026-10-23，在唯一 `harness-19` 工作树运行：

```powershell
npm run build
npm run typecheck
node --import tsx scripts/agent-eval/prepare-holdout-seeds.ts --out out/holdout-seed-probe/final --resources fixtures/resources
```

两例×修改前后×正式/预览共8次公开 `loadWorkspace` / `render` 全部无问题、无文字溢出、无字体替代、无文字压缩；发布经 `publishStaticSchema` 成功。`diffTemplate` 每例严格只返回 `holdout-stop-name-0N/stop-name-en` 的 `color` 由 `#172B4D` 到 `#FFFFFF`，其余模板属性无变化，另三份工作区文档逐字节一致。

公开PNG像素核验通过：全部变化均在旋转后英文列（x=95..145mm、y=120..820mm）内，列外逐像素不变，原英文纯色确实变成白色，中文白色像素保留。正式图02变化70,799像素、纯色转换59,881像素，03变化45,791像素、纯色转换38,906像素；预览也分别通过同一检查。像素解码复用 `test/support/pixels.ts`，不读取渲染器私有排版结构。

已验证动态导入无准备副作用；再次给同一 `out` 得到 `EEXIST`，原清单字节保持不变。`npm run typecheck`、`git diff --check`通过。前后预览已查看，中文长名、括号和字面英文保留；最终独立审核由用户完成。

后续总准备脚本应重新生成到全新目录并绑定本次实际文件身份；本次 `out/holdout-seed-probe/final` 是生成器验证材料，不替代票19的正式冻结及人工核准。两例同属竖排站名模板家族，不能作为两个独立模板家族计算泛化能力。
