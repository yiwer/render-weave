工作目录里的 sample.png 是一块公交线路牌的设计稿。请按顺序完成，不要跳步：

1. 用 Read 工具查看 sample.png，读出线路号、票价、高亮（黄底）的本站站名。
2. 调用工具 mcp__rw__render_draft，参数 request 为：
   {"template":"标准线路单边","dataset":{"id":"ds-m402-wanguocheng"},"parameters":{"currentIndex":23},"output":{"width":740,"height":165,"dpi":50,"format":"png"}}
3. 只根据工具返回的预览图（不要根据设计稿推测），读出预览图中的票价和高亮的本站站名。
4. 对比设计稿与预览图，列出最多 5 处可见差异。

最后只输出一个 JSON：{"sample":{"routeNo":"","fare":"","currentStop":""},"preview":{"fare":"","currentStop":""},"differences":[]}
