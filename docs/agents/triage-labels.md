# Triage 标签

技能用五个规范的 triage 角色描述状态。下表把这些角色对应到本仓库的写法：票据的 `**Status:**` 行，或规格的 `Status:` 行。

| 技能中的角色 | 本仓库写法 | 含义 |
|---|---|---|
| `needs-triage` | `needs-triage` | 待维护者评估 |
| `needs-info` | `needs-info` | 等待报告人补充信息 |
| `ready-for-agent` | `ready-for-agent` | 规格完整，可交给 AFK agent |
| `ready-for-human` | `ready-for-human` | 需要人来实施 |
| `wontfix` | `wontfix` | 不处理 |

本地 tracker 没有"关闭"动作，另用 `resolved` 表示已完成：验收通过并写好 `## Answer`（见 `issue-tracker.md`「关闭票据」）。它不是 triage 角色。

分类角色写在文件顶部的 `Category:` 行，取 `bug` 或 `enhancement`。

技能提到某个角色时（例如"打上 AFK-ready 标签"），就写入上表对应的字符串。
