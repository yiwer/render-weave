# 项目说明：M402 公交线路牌模板

- 业务：公交线路牌（领域约定见 domain-route-sign.md，如有）。
- 示例图：sample.png，实际尺寸 740 × 165 mm，是 M402 路开往万国城总站方向的设计稿，本站为第 5 站。
- 已有输入（在 workspace/，不要修改）：数据定义"线路牌 v1""停靠站点 v1"及其编译产物，按示例图转录的数据集（id：ds-m402-wanguocheng）。
- 主模板：命名为"线路牌主模板"，基准"线路牌 v1"，对外参数 currentIndex（number，本站序号，从 1 开始，0 表示不标本站）。被调模板自行命名。每个模板一个文件，写到 workspace/。
- 目标范围：宽 740–1500 mm，高 165 mm，站数 2–50。
- 示例图对应的出图请求：{"template":"线路牌主模板","dataset":{"id":"ds-m402-wanguocheng"},"parameters":{"currentIndex":5},"output":{"width":740,"height":165,"dpi":50,"format":"png"}}
- 客户说明：站名上方蓝色圆形内带数字的标记是早期错误设计，忽略，不画。
