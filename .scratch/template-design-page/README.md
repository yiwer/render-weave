# 模板设计页重做票据（第一、二期）

本页只维护索引：标题、直接阻塞与验收映射。状态以各票据的 `**Status:**` 行为准，验收记录写在各票据的 `## Answer`。

父规格：[模板设计页重做 PRD](spec.md)。设计事实源：[方案](../../docs/template-design-page.md)与[原型](../../docs/prototypes/template-design/README.md)。

## 第一期：重组

| 票据 | 完整行为 | 直接阻塞 | 规格验收 |
|---|---|---|---|
| 01 | [不开工作副本也能读模板内容，只看不改不再留审计](issues/01-read-template-content.md) | 无 | A02、A03 |
| 02 | [预览能答出一个元素实例的变量取值、命中分支与各实例的状态](issues/02-preview-inspection.md) | 无 | A02、A04 |
| 03 | [模板设计页换成舞台加浮动面板的外壳，现有能力一项不少](issues/03-stage-shell.md) | 无 | A01、A11 |
| 04 | [点图上的元素，范围条写明定义在哪、图上几处、改一处全改](issues/04-selection-and-scope.md) | 03 | A05 |
| 05 | [结构树跨模板展开，和图上的选中双向同步](issues/05-cross-template-tree.md) | 01、03 | A05 |
| 06 | [打开适配层，一眼看到哪些文字被压缩、哪些放不下](issues/06-overlays.md) | 03 | A02、A08 |
| 07 | [样例带上换数据、参数与尺寸，试值不写进模板](issues/07-sample-tray.md) | 03 | A06 |
| 08 | [变量面板看得到当前值，悬停标出谁在用](issues/08-variables-panel.md) | 02、03 | A06 |
| 09 | [每个属性一个值格，能绑定、断开、提取为参数，能追到值从哪来](issues/09-value-cell.md) | 08 | A07 |
| 10 | [检查器按元素类型分组，文字的内容与适配能直接看懂](issues/10-inspector-groups.md) | 09 | A07 |
| 11 | [第一期验收：逐张对照原型、真人走查、记下端到端耗时](issues/11-phase-one-acceptance.md) | 04、05、06、07、10 | A01、A11、A12 |

## 第二期：结构编辑

| 票据 | 完整行为 | 直接阻塞 | 规格验收 |
|---|---|---|---|
| 12 | [在结构树上复制、删除、排序元素，包进容器，改名字](issues/12-structure-editing.md) | 11 | A09 |
| 13 | [在图上用手柄改元素，能拖什么由父容器的布局决定](issues/13-layout-handles.md) | 11 | A09 |
| 14 | [添加元素，或把字段拖进来生成绑定好的元素](issues/14-add-from-field.md) | 12 | A09 |
| 15 | [用表单配置循环与子模板调用](issues/15-loop-and-call-forms.md) | 11 | A09 |
| 16 | [不写表达式配派生变量与检查项，分支标出当前命中](issues/16-derived-and-check-editors.md) | 11 | A09 |
| 17 | [按取值配状态样式，看到每个取值在图上有几处](issues/17-state-styles.md) | 11 | A09 |
| 18 | [从空白开始新建模板](issues/18-new-blank-template.md) | 14 | A02、A10 |
| 19 | [把一块元素提取成子模板](issues/19-extract-subtemplate.md) | 12、15 | A09 |
| 20 | [第二期验收：不写 DSL 做出站点模板，真人走查](issues/20-phase-two-acceptance.md) | 13、16、17、18、19 | A10、A12 |

已检查：26 条用户故事全部覆盖；A01–A12 全部覆盖；依赖编号有效、无环、无冗余的传递边。

- 01、02、03 没有前置阻塞，可以并行开始：01、02 主要动接口与引擎，03 只改控制台。
- 04、05、06、07、08 都等外壳 03，之后可以并行，但都改同一组页面文件，建议一张合入再开下一张。
- 第二期等第一期验收，走查的反馈先进第一期。
- 规划决定见 M383、M392；Agent 进左面板（修订 M342）待定，只影响方案的第四期。
- 按阻塞关系领取票据：直接阻塞的票据全部 `resolved` 后才能开始。构建、装依赖与测试在独立 worktree 里做。
