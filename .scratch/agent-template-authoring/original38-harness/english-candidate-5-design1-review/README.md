# TfL161 · 候选5首次实际英文审核包

实际首轮已由根唯一派发并完成。使用已独立审查合入 `ea1dfc73d6151b44862ff7b7e7668c2f69770000` 的生成器，公开候选/阶段核查通过，再从普通副本调用 `readReview(round,{persistArtifacts:false})`、`readPreviousRound`、`loadWorkspace` 与 `render`。没有新模型调用、批准或应用，也没有填入任何人工结论。

包在 `F:/GenCode/render-weave/out/harness-original38-review/en-tfl161-design1-candidate-5`，首页 `review.html`。完整119文件、28目录；原轮次及副本各93文件、26目录，生成前后与事后复核完整路径集合及SHA全部相同。核准材料59文件保持原字节。

- `source-page-13-200dpi.png`：核准1654×2339整页原件，未经编辑。
- `source-panel-original-pixels.png`：核准材料已有1654×500页首视口原件，生成器逐行核对其全部像素与整页对应区域相同。
- `actual-request.png`：原始正式请求公开渲染的1653×500、200 DPI成果，SHA256 `0b70a4a890ff41ec2aa15fc6c4742342e710b59c4b68f713229226328d93e7ef`。没有把它重采样到1654像素；HTML只按相同画板显示宽度对照，原图链接保留原像素。
- `independent-review.json`：原英文39项，逐项结论、证据与分钟全部空；仅补真实候选、绑定、轮次、outcome及图片身份。`time-events.blank.json`仍为空事件/null分钟。
- `diagnostics.html`：与原图/实际成果首页分开；包含自动诊断和原模型说明，不能替代用户独立审核。

冻结候选 `sha256:187d36a38bd24950511931a548e67f911cbe87de49e03aaf813a05d174a06526`；阶段绑定 `sha256:ab7d3ddf3000a8d57fdbfb9fc2117711cfc633f4ccbfd7081b34808f256c8bec`。本包按公开dispatch开始/完成记录绑定唯一design-1原件，保持原请求约210×63.5mm和200 DPI。材料核准不等于成果通过；源字体/字号、命名本站及完整实际站序的未知边界不变。

本目录保存生成结果、完整包清单、公开验证日志和事后只读核查摘要的逐字节副本。`package-manifest.json`原SHA256为 `d6c3b16b1c10bf948c30c705725f34f296315e3ceb4fc051d12215cc0a10bf78`；`audit.json` SHA256为 `bc34145fc190f754eed879b9829b9974a95b6f47119cc051d9e90cd674908380`，309项核查、0发现。固定生成器SHA256 `c62365f1dc6398168563857f65ef76c7fe2b84f459a3ba64be7d019c0f237c93`。

这份记录仅证明实际审核材料的来源和完整性，不作视觉通过或纠偏成功结论。首次结果原件保留；是否存在真实缺陷及是否启动唯一获准接续由根依据实际对照决定，后续用户39项审核和真实分钟另存，不覆盖本包。
