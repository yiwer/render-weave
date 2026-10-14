工作目录中的 sample.png 是客户提供的公交线路牌设计稿，实际尺寸 740 × 165 mm。数据定义"线路牌 v1""停靠站点 v1"及其编译产物、按设计稿转录的数据集（id：ds-m402-wanguocheng）已放在 workspace/ 中，不要修改它们。你的任务：为"线路牌 v1"做模板，使出图尽量还原设计稿，并能服务其他线路（站数 2–50、站名长短不同）。

要求：
1. 先读 docs/ 目录下的全部文档：template-reference.md 是模板 DSL；如有领域约定文档，必须遵守。再读 workspace/ 中的数据定义与数据集，查看 sample.png，用 list_resources 查看可用的字体与图片资源。
2. 主模板命名为"线路牌主模板"，基准为"线路牌 v1"，声明 public 参数 currentIndex（number，本站序号，从 1 开始）。需要时另建被调模板，每个模板一个文件，写到 workspace/。
3. 用 render_draft 出草稿预览，请求为 {"template":"线路牌主模板","dataset":{"id":"ds-m402-wanguocheng"},"parameters":{"currentIndex":5},"output":{"width":740,"height":165,"dpi":50,"format":"png"}}。对照 sample.png 与问题清单修改，直到没有严重问题、版面与设计稿基本一致。
4. 最后输出：模板清单与结构、与设计稿仍有的差异、你不确定的地方。
