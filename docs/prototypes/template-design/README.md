# 模板设计页原型

[方案](../../template-design-page.md)的可交互原型。只作讨论，不作实现基础。

图、布局摘要、元素定位和问题清单都由引擎真实渲染（`build-data.mts`），样板是 M402 线路牌（`docs/examples/m402-dsl/`）和胸牌（`docs/dsl/` 的示例）。写回是模拟：改线路牌的站名字号、主色和胸牌的姓名字号时换上预渲染的真图，其他改动只提示；变量取值由页面自己算，真实产品要由预览接口回答（方案第 12 节）。

## 看稿

```bash
python -m http.server 8768 --bind 127.0.0.1 --directory docs/prototypes/template-design
```

打开 <http://127.0.0.1:8768/>，状态栏的"试这几步"带你走一遍。按 1440 × 900 设计。

`screenshots/` 是主要状态的截图。重新生成数据：

```bash
npx tsx docs/prototypes/template-design/build-data.mts
```

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 原型本身，不依赖框架，配色用控制台的 M361 色板 |
| `data.json`、`imgs/` | 引擎的输出 |
| `build-data.mts` | 生成上面两项 |
| `screenshots/` | 无头 Edge 下 1440 × 900 的截图 |
