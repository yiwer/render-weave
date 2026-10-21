-- 0007 计量与额度（票据 09，ADR-0020、M242）。
-- 套餐由平台管理员设置；当期计数每个租户每个周期一行（限额、已用、预占）；用量事件追加写入，不改不删。
-- 批次记下接受时的计费周期与剩余预占：逐项结算、批次结束与对账都从这里退回，退回的总数不超过预占的总数。

CREATE TABLE tenant_plans (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  monthly_images integer NOT NULL CHECK (monthly_images >= 0),
  max_pixels bigint NOT NULL CHECK (max_pixels BETWEEN 1 AND 100000000),
  concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 64),
  updated_at timestamptz NOT NULL
);

-- 周期是按 UTC+8 切分的自然月，写作 YYYY-MM；限额在建行时取套餐，改套餐时一并改当期的。
CREATE TABLE usage_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  image_limit integer NOT NULL CHECK (image_limit >= 0),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (tenant_id, period)
);

-- 出处：正式交付成功的一项（批次与项序号），或代建的一轮（round.json 的 SHA-256、任务与轮次）。
CREATE TABLE usage_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind text NOT NULL CHECK (kind IN ('image', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  batch_id uuid,
  item_index integer,
  round_sha256 char(64),
  round_task text,
  round_number integer,
  at timestamptz NOT NULL,
  CHECK ((kind = 'image') = (batch_id IS NOT NULL AND item_index IS NOT NULL AND round_sha256 IS NULL)),
  CHECK ((kind <> 'image') = (round_sha256 IS NOT NULL AND round_task IS NOT NULL AND round_number IS NOT NULL))
);
-- 同一项只计一次（重领、重试都不重复计费）；同一轮的同一种 token 只记一次（重复推送）。
CREATE UNIQUE INDEX usage_events_item ON usage_events (tenant_id, batch_id, item_index) WHERE kind = 'image';
CREATE UNIQUE INDEX usage_events_round ON usage_events (tenant_id, round_sha256, kind) WHERE round_sha256 IS NOT NULL;
CREATE INDEX usage_events_period ON usage_events (tenant_id, period, id);

-- 接口进程建的批次才有周期；之前建的与存储合同用例直接建的批次不计量。
ALTER TABLE batches
  ADD COLUMN period text CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD COLUMN reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0);
CREATE INDEX batches_reserved ON batches (tenant_id, batch_id) WHERE reserved > 0;

ALTER TABLE tenant_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON tenant_plans USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON usage_counters USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON usage_events USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());

-- 用量事件只能追加：应用账号没有改与删的权限。
GRANT SELECT, INSERT, UPDATE ON tenant_plans, usage_counters TO renderweave_app;
GRANT SELECT, INSERT ON usage_events TO renderweave_app;
GRANT USAGE ON SEQUENCE usage_events_id_seq TO renderweave_app;

-- 对账（跨租户）：退回崩溃后遗留的预占。批次已结束还有预占的全部退回；没结束的，接受它的构建在 p_online_since 之后没有 worker 报到、
-- 批次在 p_idle_before 之后也没有动静（建批次、领取、写回），视为没人再交付，退回剩余预占。正被别的事务锁住的批次下次再看。
CREATE FUNCTION rw_reconcile_reservations(p_online_since timestamptz, p_idle_before timestamptz)
RETURNS TABLE (tenant_id uuid, batch_id uuid, released integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH candidates AS (
    SELECT b.tenant_id, b.batch_id, b.period, b.reserved FROM batches b
     WHERE b.reserved > 0 AND b.period IS NOT NULL
       AND (b.finished_at IS NOT NULL OR (
         NOT EXISTS (SELECT 1 FROM workers w WHERE w.build = b.build AND w.seen_at >= p_online_since)
         AND b.created_at < p_idle_before
         AND NOT EXISTS (SELECT 1 FROM render_tasks t WHERE t.tenant_id = b.tenant_id AND t.batch_id = b.batch_id
                          AND (t.started_at >= p_idle_before OR t.finished_at >= p_idle_before))))
     FOR NO KEY UPDATE OF b SKIP LOCKED
  ), cleared AS (
    UPDATE batches b SET reserved = 0 FROM candidates c
     WHERE b.tenant_id = c.tenant_id AND b.batch_id = c.batch_id
    RETURNING c.tenant_id, c.batch_id, c.period, c.reserved
  ), counted AS (
    UPDATE usage_counters u SET reserved = greatest(u.reserved - s.released, 0)
      FROM (SELECT cl.tenant_id, cl.period, sum(cl.reserved)::integer AS released FROM cleared cl GROUP BY cl.tenant_id, cl.period) s
     WHERE u.tenant_id = s.tenant_id AND u.period = s.period
    RETURNING u.tenant_id
  )
  SELECT cl.tenant_id, cl.batch_id, cl.reserved FROM cleared cl ORDER BY cl.tenant_id, cl.batch_id
$$;

REVOKE ALL ON FUNCTION rw_reconcile_reservations(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rw_reconcile_reservations(timestamptz, timestamptz) TO renderweave_app;
