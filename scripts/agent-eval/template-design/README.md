# 模板设计评估集

衡量业务 Agent 的模板辅助设计能力在线路牌以外的版式上够不够用（M333）。12 个用例，每个是一张示例图加专家版数据定义与数据集；Agent 只做模板，评分看压测有没有严重问题、版面检查过了几项。它不在 M230 的门槛里，按需跑。

## 什么时候跑

- 改了模板相关的资料：`agent/reference/template.md`、`agent/tasks/template-design.md`、通用做法里讲模板的部分、本集用到的领域约定；
- 换模型、升级 Claude Code、改 MCP 工具合同之后，想知道模板能力有没有退步；
- 新增或改写领域约定包之后（`agent/README.md`「改了资料之后」要求至少实跑一张该领域的图）。

门槛场景（`scripts/agent-eval/config.json`）照旧按 [Agent 评估](../../../docs/agent-eval.md) 的规则跑；本集不替代它。

## 运行

```bash
npm run build
npx tsx scripts/agent-eval/run.ts --config scripts/agent-eval/template-design/config.json --repeat 1 --label tds-<日期>-<模型>
```

- 评估命令的 `--repeat` 缺省 2；本集配置的最少次数是 1（`consecutivePasses: 1`），只看一次时写 `--repeat 1`。`--scenarios tds-05-asset-card,tds-12-cup-label` 只跑部分用例。
- 换模型时加 `--model`、`--small-model`，例如 DeepSeek V4.1 Flash 写 `--model deepseek-v4.1-flash --small-model deepseek-v4.1-flash`（M332）。
- 其余选项、冻结身份、上游错误的重试、额度熔断与续跑都与门槛评估相同；打印的续跑命令会带上 `--config`，`--rescore` 要再传一次 `--config`。
- 报告写到 `docs/agent-eval/reports/<名称>.json`，名称建议以 `tds-` 开头。

## 用例

| 用例 | 领域约定 | 尺寸（mm） | 主要考察 |
|---|---|---|---|
| [01 M518 横版公交线路牌](cases/01-m518-route-sign/README.md) | route-sign | 990 × 420 | 与 M402 同版式的迁移，SVG 图标 |
| [02 M162 竖版站台线路牌](cases/02-m162-vertical-route-sign/README.md) | route-sign | 420 × 750 | 纵向循环、中英双语、本站整行高亮 |
| [03 超市商品价签](cases/03-supermarket-price-tag/README.md) | price-tag | 100 × 56 | 价格最醒目、可选价格、EAN-13 |
| [05 固定资产标识卡](cases/05-fixed-asset-card/README.md) | asset-tag | 90 × 50 | 新领域、标签对齐、二维码加 CODE128 |
| [06 地铁屏蔽门导乘图](cases/06-metro-door-strip/README.md) | metro-strip | 1320 × 560 | 三种站点状态、横竖排切换、换乘标签 |
| [07 诊室电子门牌](cases/07-clinic-doorplate/README.md) | clinic-doorplate | 300 × 400 | 照片字段、候诊队列、空值处理 |
| [08 物流电子面单](cases/08-logistics-waybill/README.md) | waybill | 100 × 134 | 格线表格、长地址、明细行数 |
| [09 生鲜促销价签](cases/09-fresh-promo-tag/README.md) | price-tag | 100 × 56 | 价格拆分、划线原价、按序配色 |
| [10 检票口候车信息屏](cases/10-rail-gate-screen/README.md) | departure-board | 960 × 536 | 整行状态样式、深色底表格 |
| [11 危化品库位标识卡](cases/11-hazmat-bin-card/README.md) | hazmat-label | 200 × 150 | 枚举驱动的图片循环、派生英文 |
| [12 茶饮杯贴](cases/12-drink-cup-label/README.md) | order-label | 60 × 80 | 标签自动折行、整块隐藏 |
| [13 登机牌](cases/13-boarding-pass/README.md) | boarding-pass | 203 × 86 | 主副券重复引用、按舱位显隐 |

没有 04：素材包的 04 号是会议胸牌，而 Agent 参考（`agent/reference/`）的示例正是会议胸牌（M222），用它评估等于把答案给了 Agent。胸牌的三张素材（讲者头像、祥云底纹、回纹边框）没有导入。

## 每个用例目录

| 文件 | 给谁 | 内容 |
|---|---|---|
| `sample.jpg` | Agent | 示例图 |
| `brief.md` | Agent | 项目说明：尺寸、主模板名与参数、目标范围、客户说明（资源怎么用） |
| `schema-*.json`、`compiled-*.schema.json`、`dataset-*.json` | Agent（工作区） | 专家版数据定义、引擎编译的产物、示例数据集 |
| `request.json` | Agent | 示例图对应的出图请求；评分也按它的尺寸与 DPI 出草稿 |
| `stress.json` | 评分 | 压测：改数据、参数或尺寸后草稿出图，记严重问题 |
| `checks.json` | 评分 | 版面检查：在草稿的布局摘要上判断 |
| `README.md` | 维护者 | 用例文档：来源与哈希、考察点、数据定义的取舍、压测与检查的理由、与样图的差异 |

压测与检查的写法见 `scripts/agent-eval/score.ts` 的 `DataPatch`、`StressSpec`、`CaseCheck`：

- 改数据的键是路径（`stops[10].name`，序号从 0 开始），值为 `null` 时删掉，`{"$take": {"from": "stops", "count": 30}}` 从原列表循环取项；
- 检查有 `text`、`image`、`barcode`、`qrcode`、`largest` 五种，可限区域（元素框中心在画板上的相对位置）、字号、颜色（RGB 距离 100 以内），`absent` 断言找不到，`variant` 先改数据或参数再判断。

## 资源

`resources/` 只放图片（33 张，`resources.json` 登记）。评估时每个用例在单元目录里另组一份资源仓库：字体取 `fixtures/resources`（`npm run fetch-fonts` 下载），图片只放本用例 `config.json` 里列出的。共用的 `fixtures/resources` 不动，门槛场景与 MCP 合同快照看到的资源不变（M334）。

## 来源与核对（2026-10-25）

- 素材来自用户提供的 `renderweave_eval_assets_pack`（13 张样图、39 张新增图片）与 `renderweave_svg.html`。HTML 是同一批图片的画廊，46 张内嵌图片与素材包文件逐个比对 SHA-256 全部相同，没有额外内容；脚本只有筛选与复制，没有外联。
- 素材包 `resources.json` 中的字体、M402 与测试图片与 `fixtures/resources` 逐字节相同；M162 的四个设施图标与 `scripts/agent-eval/scenarios/m162/icons/` 相同。
- 39 张新增图片经引擎实渲（正式与草稿模式各一张对照图），0 个问题；SVG 都是纯几何图形，没有 `<text>` 与外部引用。
- 样图是生成图，有少量不合理处（站名、换乘、繁体字、条码校验位），各用例文档的「数据集」一节写了怎么处理。

## 通过线与校准

通过线（M337，按首轮基线定稿）：压测全部无严重问题，版面检查至少 85%（向上取整，即每例留 1–2 项余量）。

- **正例**：05 有专家模板（`fixtures/agent-eval/templates/tds-05-expert/`，压测 8/8、版面 11/11）；其余 11 例以首轮基线（Haiku 5.5）的模板作正例，草稿逐张与样图对照过，版面检查全部满分不是因为检查写宽了。
- **复核的规则**：草稿与样图一致却没过的检查，改检查；草稿确有缺陷的，保留；压测在用例自身约束下不可能满足的，改用例并在项目说明里写明上限。
- **基线里改过的**：01 的长站名压测（12 字 → 8 字）、08 的长地址压测（60 字 → 40 字）、条码自带的下方文字也算文字；`waybill`、`order-label`、`hazmat-label` 三份约定删掉了"换行""两行""多行段落"等引擎做不到的说法。细节见各用例文档与[票据 03](../../../.scratch/template-design-eval/issues/03-baseline-and-pass-lines.md)。
- **引擎没有段落换行**：一个文字元素就是一行。写新用例时，长文本的压测上限要按单行压缩、缩字后放得下来定。
