# 原38英文及几何库存：待核准材料

已整理41项：13个纯英文站名、3个纯英文标题/说明、19个混排英文局部、6个几何锚点。当前没有任何人工核准或候选通过结论；仅为20之后原样旧候选局部审核备料。

[完整JSON](<C:\Users\Administrator\.codex\visualizations\2026\10\23\01a167fb-6fcb-7771-8713-7be4f73bddf8\harness-original38-en-inventory.json>)；SHA-256：`a70d6cf83e36fb2eeb36d9fc5d7fb345c7e82b5f20d9f0e491ccd3517058b530`。

原图为历史混合站牌3200×3600像素，已重新目视读取英文及几何，图像SHA为`622e340e787706113d6f579d53b892e4a7ed6f2a3b85041b5c2f0c5c6300f1da`。13站与3个独立英文节点可整节点定位；19混排项只核英文子段，历史ROI包含其他文字，不能拿缩小英文框与整节点墨迹自动比较。

本库存引用历史reference和annotation的框、颜色及容差，全部标为unapproved；JSON中既有approvedRegions只是字段名称。没有新测量，没有把旧模板字号或像素高度当作字体真值。800×900mm来自历史请求，不冒充独立物理尺寸证明。

## 13个纯英文站名

| ID | 英文/几何事实（待核准） | 源状态 | 核查方式 |
|---|---|---|---|
| stop-2-en | Martyrs' Square | passed | 事实及测量核准后可自动定位 |
| stop-3-en | City Market | passed | 事实及测量核准后可自动定位 |
| stop-4-en | University | passed | 事实及测量核准后可自动定位 |
| stop-5-en | General Hospital | passed | 事实及测量核准后可自动定位 |
| stop-6-en | Palm Park | current | 事实及测量核准后可自动定位 |
| stop-7-en | Clock Roundabout | normal | 事实及测量核准后可自动定位 |
| stop-9-en | Public Library | normal | 事实及测量核准后可自动定位 |
| stop-10-en | Ministries Complex | normal | 事实及测量核准后可自动定位 |
| stop-11-en | National Museum | normal | 事实及测量核准后可自动定位 |
| stop-12-en | Corniche | normal | 事实及测量核准后可自动定位 |
| stop-13-en | Fish Market | normal | 事实及测量核准后可自动定位 |
| stop-14-en | Free Zone | normal | 事实及测量核准后可自动定位 |
| stop-15-en | Old Harbour | normal | 事实及测量核准后可自动定位 |

## 3个纯英文标题与说明

| ID | 英文/几何事实（待核准） | 源状态 | 核查方式 |
|---|---|---|---|
| header-en | Palm Park | not-applicable | 事实及测量核准后可自动定位 |
| destination-en | Port | not-applicable | 事实及测量核准后可自动定位 |
| footer-sms-en | Scan for live arrivals · SMS stop code 2048 | not-applicable | 事实及测量核准后可自动定位 |

## 19个混排英文局部

| ID | 英文/几何事实（待核准） | 源状态 | 核查方式 |
|---|---|---|---|
| stop-1-en | Central Station | passed | 人工局部；自动unknown |
| stop-8-en | Courthouse | normal | 人工局部；自动unknown |
| stop-16-en | Port | terminal | 人工局部；自动unknown |
| header-label | Bus Stop | not-applicable | 人工局部；自动unknown |
| code-label | Stop code | not-applicable | 人工局部；自动unknown |
| towards-label | Towards | not-applicable | 人工局部；自动unknown |
| count-label | Stops | not-applicable | 人工局部；自动unknown |
| trip-label | Full trip | not-applicable | 人工局部；自动unknown |
| table-右-transfer | Other routes | not-applicable | 人工局部；自动unknown |
| table-右-stops | Stops | not-applicable | 人工局部；自动unknown |
| table-左-transfer | Other routes | not-applicable | 人工局部；自动unknown |
| table-左-stops | Stops | not-applicable | 人工局部；自动unknown |
| current-badge | You are here | current | 人工局部；自动unknown |
| legend-time | Times are approximate | not-applicable | 人工局部；自动unknown |
| service-access-label | Accessibility | not-applicable | 人工局部；自动unknown |
| service-fare-label | Fare | not-applicable | 人工局部；自动unknown |
| service-frequency-label | Frequency | not-applicable | 人工局部；自动unknown |
| service-hours-label | Hours | not-applicable | 人工局部；自动unknown |
| footer-customer-label | Customer service | not-applicable | 人工局部；自动unknown |

## 6个几何锚点

| ID | 英文/几何事实（待核准） | 源状态 | 核查方式 |
|---|---|---|---|
| marker-first | 首站为圆角实心方标，图中属于已过站状态 | passed | 事实及测量核准后可自动定位 |
| marker-passed | 已过站圆标为浅色外环、白色圆心 | passed | 事实及测量核准后可自动定位 |
| marker-current | 本站圆标为深色外环、黄色圆心 | current | 事实及测量核准后可自动定位 |
| marker-normal | 普通后续站圆标为深色外环、白色圆心 | normal | 事实及测量核准后可自动定位 |
| marker-terminal | 终点为深色圆角实心方标 | terminal | 事实及测量核准后可自动定位 |
| highlight-current | 本站一行有浅黄色圆角高亮底块 | current | 事实及测量核准后可自动定位 |

## 材料、状态与后续使用

已读取并逐字节核对三个候选与旧summary中记录的SHA相等；历史工作区5份JSON与该轮snapshot逐一一致，原请求与该轮保存请求内容相同，历史报告使用的3份字体字节一致，第四份未使用字体也登记当前SHA。仅保存引用和摘要，未复制原图或字体、未渲染或运行模型。

历史轮次verdict为unqualified，根和agent内均无最终outcome。后续是明确加载旧诊断指定的三个原样候选进行局部离线审核，不得伪造有效outcome、人工批准、应用或正式交付。旧报告/2与20候选上的新报告分开，不把历史needsWork改写为通过。

passed/current/normal/terminal各有源图定位，库存仅记证据存在，不等于候选已覆盖。terminal英文是混排人工项；terminal方标只补几何。全16站英文longestText仍未知：stop-10-en在13个纯英文节点的旧ROI中最宽，不能代表另外3个混排英文子段或未来长文本。左右Other routes/Stops表头均保留独立条目，不因样式相同漏掉重复实例。

20之后：先核对库存源SHA并绑定实际候选/合同/请求/资源身份，产生新的局部报告和面板目录；原样候选不删字、不改字体、不调整布局。只用公开比较/渲染入口，不调用含arabic-double干预的旧脚本。纯英文16项和几何6项需要事实、测量、状态及容差核准后才能作为自动依据；混排19项由人看英文局部与上下文，自动保持unknown。

人工记录另存observations；先独立看源图/候选，再看自动诊断。记录审核者、时间、源图与候选身份、区域/实例、判断与理由；缺失分钟保持未知。当前库存不关闭原34/38，不充当英文真实模型纠偏，不借用12张留出素材或其审核结果。

本次没有修改main、候选、历史reference/报告，没有新阿文任务或模型调用。
