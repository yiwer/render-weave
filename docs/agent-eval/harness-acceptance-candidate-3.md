# 候选3：通用反馈顺序修复后的全量重验准备

候选3已从独立复核合入的两份任务资料重新冻结。它具备进入真实验收的离线依据，当前真实模型观测为0。候选2的21结果为10通过、6次分页时序有效失败；原四首段4次达线、第二段4次未派发，整体未完成。这些记录保留，候选3不是补齐旧候选的缺观测，也不继承旧通过。

## 候选与变更

- 持久目录：`F:/GenCode/render-weave/out/harness-acceptance-20/candidate-3`；实际运行目录为其 `content/`。
- 候选身份：`sha256:b52cc55359ad9341184657c0dec89811a5c760cdc2003867f8d245059ed0e61c`。
- 发布来源：`20cbc4390217a07fa78fd5ef4d612cffa4b454c7`；修复交付 `3a242d8`，独立合入主线 `ad04734`。共同文件3322份，仅 `agent/tasks/next-round.md` 与 `agent/tasks/template-revision.md` 相对候选2改变，其余3320份逐字节相同。
- 两份资料分别为 `83d4463578bbbd6cc7b19eb0c4a618a3e19035a2100f5cbd019c6c96c94da556`、`605aec5324ddd2a53c57b596e0b4d0362e701ed770e81803f376ac2ab85ad00a`。变化要求模板改前传入全部工作副本、保持字节不变读完目录并补详情，改后再查及终检；没有题目专用区域提示、评分放宽或真值改变。
- MCP0.17.0、转录/3、full、原生Haiku5.5及小模型、effort缺省、整轮3600000ms、停滞阈值2、提取40轮/模板80轮、jobs1、每场景2次全部保持。Node与原生执行器版本/二进制摘要和候选2绑定一致，提供方内部修订仍未知。

[readiness3](../../out/harness-acceptance-20/candidate-readiness-3.json)保存候选、验证依据及两份绑定；[发布步骤](../../out/harness-acceptance-20/publication-3/steps.json)的7项命令均退出0。包内先验证、准备种子和绑定，最后再次验证；所有执行文件与来源清单逐项一致。

## 验证与限制

此前[离线验收](harness-acceptance-candidate.md)的基线全量、责任修复回归及渲染平台对照仍保留。当前不宣称对最终源码再次跑过一轮全量。两份资料修复的关联公开回归：Windows52项通过；Linux51项通过、1项原Windows专用条件跳过；最后一句交回范围消歧后，两平台各追加1项公开接续及2项资料来源测试，均通过。两平台build/typecheck通过；发布树另行重建及typecheck通过。

[最终修复证明](../../out/harness-feedback-order-fix/validation-final.json)列出两份资料前后摘要、18份日志及平台结果；独立复核已核对全部日志哈希。发布来源清单另存 [candidate3-source-validation.json](../../out/harness-acceptance-20/candidate3-source-validation.json)。源码、构建、Schema、评分器和依赖未改变，因此保留已有共享渲染对照，不声称新做过图片测试。

这些检查证明资料传递、公开分页能力和身份守卫仍可执行，不能证明模型的反馈顺序已改善。旧候选2六次失败全部实际读过后续页，但没有在缺陷仍存在时取得所要求的后续页证据；候选3保留同一守卫，结果待实际观测。

## 新计划绑定

| 计划 | 配置与绑定 | 范围 |
| --- | --- | --- |
| 原四场景，原38唯一派发 | `out/harness-acceptance-20/plans/original-four/config.json`；同目录 `binding-3/` | 原固定输入，4场景×2次，8观测/10阶段全部重验 |
| 可信反馈，21唯一派发 | `out/harness21-trusted-feedback-candidate-3/inputs/config.real-model.json`；该新根 `binding/` | 中英文×4任务×2次，16阶段全部重验 |

以上out路径均位于 `F:/GenCode/render-weave/`：

- 原四绑定：`sha256:9bfc3abb4823e882ffa460f564978e17d76c2e0ddb723b450079d24c597fada0`；实验：`sha256:e5a34ac2e8ff6a3569de10e28f5b4e5d49ba5b2ab69fbe28dc40e684762b0ee1`。
- 21绑定：`sha256:ab144c6db10caa506703b383f8373a2dff3b6503060488e5eba811ee03a5809d`；实验：`sha256:519ae413e61d1c3bfa409cbf02ca549e31a7418ff5f518e3f3e2d27584ee9680`。

两绑定均显式使用 `--previous-binding`，保留旧候选2及旧绑定ID和全部重验单元。原四继续使用原52份固定输入；21从新包重新准备8类受控种子，22份原资源独立复制且哈希一致，固定真值/缺陷不变。新 `plan.json` 为16单元ready且全部not-run。种子是机制初始状态，不是模型观测；本次没有调用真实模型或使用12张留出素材。

新21根与旧 `out/harness21-trusted-feedback` 分开；旧candidate2、inputs-2、binding-2、完整失败报告和归档保持原件。原四新观测根由负责人另登记为 `out/harness-original38-candidate-3`，后续命令仍从candidate-3/content执行，禁止拼接旧、新候选的通过。

[证据索引3](../../out/harness-acceptance-20/evidence-index-3.json)保存301份文件摘要，其中旧索引236份已逐项重核不变。发布脚本和独立复核记录也实拷贝到publication-3/tooling。真实派发、硬额度停止、人审与最终结论继续归原38、21及各留出票，本次冻结不关闭它们。
