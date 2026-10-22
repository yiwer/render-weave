# 模板成果

第一次写出可读候选就保存 outcome.json；修改后更新，交回前调用 check_outcome。

```json
{"candidates":["candidates/main.json"],"pending":[],"notes":"关键设计选择、已核查范围、剩余差异"}
```

candidates 是本轮交付的模板文件。设计任务列全部模板；修改任务只列实际改过或新建的模板。文件必须在 candidates/ 下，模板名与文件引用完整。
pending 无待确认项时写 []；有时每项写 file、可选 path、reason（inferred、unreadable、conflicting 或 requiredMissing）、note，可选 candidate。path 为该模板内真实元素路径，用 / 分隔，可带模板名。
locations 可省略；需要定位时写 file、path、where，可选原图像素 region（x/y/width/height）。图上位置是自述，不是识别证据。根对象只有 candidates、pending、notes、可选 locations。

按 check_outcome 的 assessment 决定：
- structure/candidates 为 invalid：修正引用或写法。
- render.status 为 notChecked：记录未验证范围。
- render.capabilityBlocked 为 true：保留候选和原文，notes 说明阻塞与剩余工作，结束；严重问题仍阻止批准和应用。
- 其他严重问题：修正；反复无进展时交回草稿并说明。
- qualified 只表示技术检查通过，不能代替信息、视觉和修改范围核查。未核查项如实写入 notes。

修改任务逐条对照 revision 的模板、元素路径与属性；撤销与修改要求无关的差异。差异被截断时按路径读取已保存模板与候选核对。
额度或上下文将尽时先保存 outcome.json 与 state.json。宿主恢复的 draft.json 完成度未知，只能查看和接续。
