# 项目说明：M518 公交线路牌模板

- 业务：公交线路牌（领域约定见 domain-route-sign.md）。
- 示例图：实际尺寸 990 × 420 mm，是 M518 路开往科技园总站方向的设计稿，本站为第 5 站（黄底高亮的"市民中心"）。本站是出图参数，不进数据集。
- 主模板："线路牌主模板"，对外参数 currentIndex（number，本站序号，从 1 开始，0 表示不标本站）；被调模板自行命名。
- 目标范围：高 420 mm，宽 990–1300 mm，站数 2–30，站名最长 8 字。
- 客户说明：线路号用铭牌图片 res:route-no-m518（已在数据集里），线路号后的方向箭头用 res:arrow-double-right。站名上方的设施图标：地铁用 res:icon-metro-red，医院用 res:icon-hospital-cross。站名下方的带圈数字是地标图片，数据集里已引用 res:landmark-1-svg … res:landmark-4-svg。
