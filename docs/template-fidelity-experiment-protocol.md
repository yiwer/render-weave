# 模板还原评判：离线试验协议

2026-10-22，初版在第一次渲染前登记，校准修订逐条保留如下。需求 M308；验收见 [.scratch/template-fidelity-evaluation/spec.md](../.scratch/template-fidelity-evaluation/spec.md)。

## 固定输入与显示契约

- 数据来自 `docs/examples/m402-dsl/dataset-m402.json`；原始图为 `docs/examples/materials/m402-route-sign.jpg`。报告记录内容哈希，不调用 OCR 或生成模型。
- 受控正例取仓库维护的 M402 模板。它只用来制造已知缺陷并校准测量，不是原图精确还原的金标准。
- 请求为 740 × 165 mm、50 DPI、currentIndex=5，与之前真实模板任务的尺寸基准一致。所有图片使用同一公开 `compareDesignImages` 入口；历史候选也重新渲染，不能把不同 DPI 的分数直接混排。首次执行前，依据用户带来的调研补充：使用 final 模式得到无草稿标记的图像；严重问题导致无图时记录 unavailable，不将问题框混入感知分数。旧报告采用 draft，因此只有确认图像相同时，才能直接比较旧数值。
- 显示契约独立于候选路径名：站名、连续道路组、终点、运营方、服务时刻/说明、下一站、站点/下一站地标和标识，外加线路号。文本在全图做语义匹配，粗区域的纵向中心用于同名角色消歧；下一站的前缀/区域与重复地标的底栏区域作额外消歧。这是启发式，不能冒充核准的精确坐标或真实角色 ID。
- 时刻允许全角和小时不补零的等价写法。重复标签按次数匹配；顺序按匹配框的横向中心比较，逆序对数除以可比较对数。图像匹配资源 ID，不验证其中的图像内容是否正确。

校准过程：首跑修复两个坏例 DSL 构造错误（尺寸 fixed、派生变量显示名称），并发现正例服务时间跨粗分区被误判缺失；第二跑通过当时的 18 项断言，但历史观察集暴露出道路/时刻/图标跨区误报；第三跑改成全图语义匹配、增加 `raised-divider` 正向对照，暴露底栏复用地标的多计数；第四跑将下一站地标独立成角色，仍有跨角色误归属；第五跑补重复图像的区域消歧后通过 19/19。各次证据保留在 `out/fidelity-experiment-1` 至 `-5`。观察集参与了发现边界，因此本批不构成严格留出集验证，也不报告泛化准确率。

## 试验集合

1. 正例及十个受控变体：空骨架、漏首站、站序反转、隐藏班次时刻、站名字号减半、站点左留白增加、底栏增高但内容齐全、隐藏地标、插入陌生站名标签、写死首站和下一站。陌生文本单列未归属证据，不静默过滤为内容匹配。
2. 正常绑定与写死版本分别执行四个派生输入：首站改名、交换前两站、currentIndex=10、删除全部可选标识。每个派生输入经原渲染链校验；不允许严重问题被误记为成功适应。
3. 已保存的 P0 改前、P0 首次失败、P0 修正后、P1 无阈值与交接候选，以及当前区域纠偏候选作为观察集。保留原候选，不调模板来迁就新评判；发现测量边界后补受控用例并记录规则修订。已有失败候选也保留。

## 证据与判读

内容报告为“已覆盖项匹配 / 存在未匹配项 / 未知”，不是视觉验收通过。每个角色保存预期数、匹配数、未匹配值、额外值、路径、布局框、字号和逆序比例。

受控变体另记录与正例的布局偏差：中心坐标按画板宽高归一化后取欧氏距离；宽高分别取绝对对数比例，再求均值；字号取绝对对数比例。0 表示在该维度一致，减半的字号对数偏差为 ln(2)。历史候选没有核准的精确参考布局，不输出结构分数。

原图 SSIM/RGB 与受控正例 SSIM/RGB 分列。缺失内容不允许靠背景像素补偿；改动数据导致的合法像素变化也不能判为质量退步。暂不形成统一排序、权重总分或自动审批。

明确未覆盖：最终遮挡/透明度/裁切/旋转，分字或跨节点排字的可靠语义匹配，票价格式与本站状态配色，全套静态文案，以及人类对还原程度的偏好。layout.visible 不能证明最终可见；字号/布局框也不是墨迹/基线。

## 运行和归档

```powershell
npx tsx scripts/agent-eval/fidelity-experiment.ts --out out/fidelity-experiment
node scripts/agent-eval/fidelity-gallery.mjs --from out/fidelity-experiment --out docs/agent-eval/figures/template-fidelity
npx vitest run --project engine test/fidelity.test.ts
```

输出目录必须是新目录；保留失败的试验记录，修复脚本后另开目录。图表只呈现实际输出，不补写缺失结果。离线渲染/测试在真实模型计时之外运行；先结束真实门槛再校准，交接完成后统一从最终脚本归档。报告保存参考图、代码与依赖文件哈希、资源逐文件哈希；历史未保存资源内容版本的限制继续保留。

## 补充试验：FLIP 区域定位

依据用户补充的调研，试用本机 FLIP 1.7 CPU；其旧 venv 缺少 numpy/Pillow，实际另建 `out/fidelity-python` 并按 `scripts/agent-eval/fidelity-requirements.txt` 固定安装。将同一批中文受控图与正例/原图作比较：白底合成，参考图 LANCZOS 缩放至候选尺寸，固定 67 PPD，不做局部配准；保存版本、输入哈希、误差图和五区均值。验证自身误差为零、已知缺陷是否在对应区域呈现更大误差。FLIP 全图均值仍不作质量排名；它是否增加 Agent 修复率，需要后续独立对照。本试验不安装生产依赖、不修改引擎或 MCP。

```powershell
python -m venv out/fidelity-python
out/fidelity-python/Scripts/python.exe -m pip install --only-binary=:all: -r scripts/agent-eval/fidelity-requirements.txt
out/fidelity-python/Scripts/python.exe scripts/agent-eval/fidelity-flip.py --from out/fidelity-experiment --out out/fidelity-flip
node scripts/agent-eval/fidelity-gallery.mjs --from out/fidelity-experiment --flip out/fidelity-flip --out docs/agent-eval/figures/template-fidelity
```
