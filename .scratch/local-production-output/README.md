# 第二阶段实施票据：本地生产出图与可复现交付

用户已确认拆分。13 张票据已分别发布，初始状态均为 ready-for-agent；本页只维护索引，实时状态以各票据为准。

父规格：[第二阶段 PRD](spec.md)。

按用户要求采用 tracer bullet，每张票同时交付用户可见行为、公开入口/CLI、必要的合同与验收。没有先做所有模型、再做所有渲染器一类横向票；没有需要独立排期的大范围预重构。

| 票据 | 完整行为 | 直接阻塞 | PRD 验收 |
|---|---|---|---|
| 01 | [二维码从文本绑定到可扫码图片](issues/01-qr-render.md) | 无 | A01、A02、A04 |
| 02 | [资产编号生成 CODE128 条形码](issues/02-code128-render.md) | 无 | A01、A03、A04 |
| 03 | [完整商品编号生成 EAN 与 UPC 条形码](issues/03-retail-barcodes.md) | 02 | A03、A04 |
| 04 | [导入资源为 v1 并用它完成出图](issues/04-versioned-resource-import.md) | 无 | A01、A08、A11 |
| 05 | [检查影响后替换资源，保留旧版出图能力](issues/05-safe-resource-replacement.md) | 04 | A08、A11 |
| 06 | [一张纯文字牌的正式交付与自足重放](issues/06-single-record-roundtrip.md) | 04 | A09、A10、A11 |
| 07 | [完整 M402 的模板与素材依赖随记录重放](issues/07-m402-record-roundtrip.md) | 06 | A01、A09、A10 |
| 08 | [35 个本站逐项正式交付，错误项不拖累整批](issues/08-batch-final-delivery.md) | 07 | A05、A06、A11、A13 |
| 09 | [一批草稿展示问题并与正式交付清楚区分](issues/09-batch-draft-previews.md) | 08 | A06、A07 |
| 10 | [停止长批次并辨认中断后的完整成果](issues/10-batch-cancel-and-interruption.md) | 08 | A07、A11 |
| 11 | [千项交付节省重复素材且内存不随图片累积](issues/11-long-batch-storage-and-memory.md) | 08 | A09、A12 |
| 12 | [带查询码的线路牌在换素材后仍能重放历史](issues/12-coded-sign-history.md) | 01、03、05、08 | A02、A03、A04、A06、A08、A09、A13 |
| 13 | [全新环境完成交付、重放与阶段验收](issues/13-stage2-cross-platform-acceptance.md) | 09、10、11、12 | A01、A02、A03、A04、A05、A06、A07、A08、A09、A10、A11、A12、A13、A14、A15 |

已检查：50 条用户故事全部覆盖；A01–A15 全覆盖；依赖编号有效、无环、无冗余传递边。票据 01 已 resolved；其余为 ready-for-agent。立即可开始：02、04。

06 先交付纯文字牌完整往返，07 扩展到调用闭包与素材；06 对未覆盖能力必须明确拒绝，不得生成不完整的成功记录。08 起每个正式成功项已有完整出图记录。各票包含自己的异常行为验证，13 汇总阶段证据。

按阻塞关系领取票据：只有其直接阻塞票全部 resolved 后才能开始；当前起点为 02、04，按编号下一张为 02；父规格保持不变。

2026-10-12：[票据 01 验收记录](issues/01-qr-render.md#answer)已完成二维码 DSL、公开入口、CLI、独立解码与错误诊断。20 个测试文件、393 项通过；Windows/Linux 各 16 份二维码图片及布局摘要哈希一致，实施已获用户确认提交。

