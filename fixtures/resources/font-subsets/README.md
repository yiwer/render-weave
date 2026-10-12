# 缺字测试字体

`TestSubset-Regular.otf`、`TestSubset-Medium.otf`、`TestSubset-Bold.otf` 分别由准备脚本获取的 Source Han Sans CN 2.005R Regular / Medium / Bold 子集化生成，OS/2 字重分别为 400 / 500 / 700。仅保留空格、`A`、`B`、`田` 的 Unicode 映射与必要轮廓，刻意缺少 `深`、`圳` 等常用字。

字体家族与 PostScript 名称改为 `RenderWeave Test Subset` / `RenderWeaveTestSubset-*`，不沿用原字体保留名称。保留原版权与许可证信息，完整许可证见 [LICENSE.txt](LICENSE.txt)。源文件固定版本与 SHA-256 见 [scripts/fonts.json](../../../scripts/fonts.json)，来源为 [Adobe Source Han Sans](https://github.com/adobe-fonts/source-han-sans/tree/2.005R)。

重新生成（Python 3，`fonttools==4.63.0`）：

```powershell
npm run fetch-fonts
python -m pip install fonttools==4.63.0
python scripts/make-font-fixtures.py
```

脚本保留源文件时间戳，使再次生成的字节一致。这些约 3 KB 的文件已提交，日常测试不需要 Python；测试单独构造资源仓库，不把此测试字体注册进业务样例的资源清单。
