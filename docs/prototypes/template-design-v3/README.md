# 模板设计页第三轮原型

[第三轮方案](../../template-design-refine.md)的原型：参照 Figma UI3、Penpot、Framer、Webflow、Canva 与 Claude Design，改左面板、检查器、插入与流程。只作讨论，不作实现基础。

图与元素框是引擎的真实输出，取自第一期原型的 `../template-design/imgs/m402-base.png` 与 `data.json`（M402 基准样例，本站序号 5）；写回是模拟，控件点了不改东西。

## 看稿

直接用浏览器打开 `index.html`（`file://` 就行，图用相对路径），按 1440 × 900 设计。底部状态栏切场景，`Ctrl+/` 开快捷操作，`Esc` 回到默认场景；左面板的图层行能点，检查器跟着换。

也能用地址直接进某个场景：`index.html#scene=done&sel=area`，`scene` 取 `done`、`blank`、`param`、`quick`、`insert`、`agent`，`sel` 取 `name`、`area`、`badges`、`mark`。

## 截图

`screenshots/` 是无头 Edge 下 1440 × 900 的截图，重截：

```bash
node docs/prototypes/template-design-v3/shoot.mjs
```

| 文件 | 场景 |
|---|---|
| `00-现在-站名.png`、`00-现在-标识行.png` | 现在的页面（票据 20 用例里截的），对照用 |
| `01-选中站名.png` | 选中条、紧凑的检查器：尺寸一格、文字一块、适配一行摘要 |
| `02-名称区的自动排布.png` | 方向图标、九宫格、间距与内边距一行 |
| `03-标识行.png` | 循环与每项排布 |
| `04-地标与按字段显示.png` | 显示绑"当「地标」不为空"建出的派生变量 |
| `05-新建的空模板.png` | 数据页一键建调用方传的参数，空画板的三步提示 |
| `06-新建参数.png` | 一个弹层建参数 |
| `07-快捷操作.png` | Ctrl+/ 搜动作与属性 |
| `08-插入菜单.png` | 底部工具栏的形状菜单 |
| `09-Agent.png` | Agent 页（P2 接入）：对话出提案，放进工作副本 |
