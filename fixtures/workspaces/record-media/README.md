# 记录素材验收夹具

这张 100 × 40 mm 的牌同时绘制 PNG、JPEG、WebP、带中文的 SVG 和需后备字体的文本 `A深田圳B`。不属于 M402 共享 DSL。

`schema-record-media-v1.json` 和编译产物定义图片/文本字段；`render-request.json` 使用内联数据，模板图片参数默认选择 WebP。`options.json` 保留字体顺序并各含一个不存在的候选。预期正式输出有一项 `text.glyphFallback` 提示，指出“深”“圳”被替代；复制后的重放保持提示和字体摘要。

资源取自 `fixtures/resources`，额外的 `subset` 使用已提交的 `font-subsets/TestSubset-Regular.otf`；`record-text-svg` 使用本目录原创的 `text.svg`。`scripts/accept-record-closure.mjs` 在临时仓库中导入两份额外资源，不修改共享资源清单。

```powershell
npm run build
node scripts/accept-record-closure.mjs out/stage2/closure-windows
```

脚本生成 M402 和本夹具的记录及独立重放图片，路径见输出目录 `evidence.json`。完整合同见 [出图记录说明](../../../docs/output-records.md)。
