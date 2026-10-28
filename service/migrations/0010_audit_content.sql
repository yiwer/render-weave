-- 0010 审计的内容哈希与差异摘要（P1 票据 03，M347、ADR-0022）：代建写入记写入前后的内容哈希与差异摘要，P2 的 Agent 另记轮次与理由。
-- 全部可空：旧行与不是代建写入的事件保持空。差异摘要是 JSON：增删改计数，加至多 50 个路径（各带前后内容哈希）。
-- 审计照旧只追加：应用账号对这张表只有插入与查询权限，新列随表授权。
-- 差异摘要用 json 不用 jsonb：按写入的原文保存，键的顺序不变，两种后端读回与导出的 CSV 逐字相同；审计不按它的内容查询。

ALTER TABLE audit_events
  ADD COLUMN before_sha256 char(64),
  ADD COLUMN after_sha256 char(64),
  ADD COLUMN diff json,
  ADD COLUMN round text,
  ADD COLUMN reason text;

-- 审计接口按主体种类筛选。
CREATE INDEX audit_events_by_actor_kind ON audit_events (tenant_id, actor_kind, id DESC);
