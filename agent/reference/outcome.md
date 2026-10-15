# 成果的交回格式

任务结束前，在工作目录根上写 `outcome.json`。RenderWeave 先校验它的结构，再用引擎校验其中列出的候选文件；不合格的成果交给人决定是否重做。

```json
{
  "candidates": ["candidates/schema-badge.json", "candidates/schema-session.json"],
  "locations": [
    { "file": "candidates/schema-badge.json", "path": "fullName", "where": "胸牌正中的大号姓名", "region": { "x": 96, "y": 410, "width": 520, "height": 120 } },
    { "file": "candidates/schema-badge.json", "path": "role", "where": "姓名下方的彩色身份色带", "region": { "x": 0, "y": 560, "width": 708, "height": 90 } },
    { "file": "candidates/schema-session.json", "path": "title", "where": "底部场次表的第一列" }
  ],
  "pending": [
    {
      "file": "candidates/schema-badge.json",
      "path": "role",
      "candidate": ["讲者", "嘉宾", "工作人员"],
      "reason": "inferred",
      "note": "示例图只出现了“讲者”，其余身份是按会务常见分类推测的"
    },
    {
      "file": "candidates/schema-badge.json",
      "path": "seat",
      "reason": "unreadable",
      "note": "座位号区域印得很淡，放大后仍无法确认是否每张胸牌都有"
    }
  ],
  "notes": "关键取舍：……；仍有的差异：……"
}
```

## 键

| 键 | 必填 | 写法 |
|---|---|---|
| `candidates` | 是 | 候选文件路径的列表，至少一项，不能重复。文件必须放在 `candidates/` 下，是 `.json` 文件，种类要符合任务：数据定义提取只交数据定义 |
| `locations` | 否 | 字段在示例图上的位置，见下文 |
| `pending` | 是 | 待确认项列表，没有就写 `[]` |
| `notes` | 是 | 给审核人的说明：关键取舍的理由、仍有的差异 |

不能有其他键。

## 图上位置

审核人要对照示例图逐个核对字段。图上能看到的字段，每个写一项 `locations`，说明它对应图上的哪一部分；图上看不到的字段（如推测出的、只在业务中存在的）不写。

| 键 | 必填 | 写法 |
|---|---|---|
| `file` | 是 | 指向 `candidates` 中的一个文件 |
| `path` | 否 | 数据定义写字段名（必须存在于该定义中）；省略时表示整份文件 |
| `where` | 是 | 文字描述，如"顶部左侧的大号编号" |
| `region` | 否 | 示例图上的像素区域 `{ "x", "y", "width", "height" }`，左上角为原点，写法与 `view_image` 的 `region` 相同。先用 `view_image` 放大核对再写；字段在图上出现多处时，框住最有代表性的一处 |

## 待确认项

拿不准的值都列为待确认项，由人逐项处理。不要猜一个值当作确定的值交回。

| 键 | 必填 | 写法 |
|---|---|---|
| `file` | 是 | 指向 `candidates` 中的一个文件 |
| `path` | 否 | 文件内的位置。数据定义写字段名（必须存在于该定义中）；数据集写字段路径，如 `sessions[2].title`。省略时表示整份文件 |
| `candidate` | 否 | 候选值，任意 JSON；没有候选值就省略 |
| `reason` | 是 | 原因，四选一，见下表 |
| `note` | 是 | 说明为什么拿不准、依据是什么 |

| `reason` | 含义 |
|---|---|
| `unreadable` | 看不清：放大后仍无法辨认 |
| `inferred` | 推测：图上没有直接给出，按常识或上下文推断 |
| `conflicting` | 来源冲突：图上不同位置、或图与项目说明给出的信息互相矛盾 |
| `requiredMissing` | 必填未提供：必填的信息在素材中找不到 |

可选字段没有值，不算待确认项。
