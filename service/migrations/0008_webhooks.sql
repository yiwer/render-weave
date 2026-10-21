-- 0008 webhook（票据 11，M246）。
-- 客户管理员与 API 密钥注册 webhook；每个 webhook 有自己的签名密钥，只在注册时显示一次，库里只存用服务密钥加密的密文。
-- 批次结束时，在发布批次清单的同一个事务里记一个事件，并给当时启用、订阅了它的每个 webhook 各记一条投递（每个批次只记一次）。
-- 接口进程的投递任务领取到期的投递，签名后发送；每次尝试都记下来，失败按指数退避重试有限次。

CREATE TABLE webhooks (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
  description text CHECK (char_length(description) BETWEEN 1 AND 200),
  events text[] NOT NULL CHECK (cardinality(events) >= 1 AND events <@ ARRAY['batch.finished']),
  secret_sealed text NOT NULL,
  secret_prefix text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);

-- 事件正文在记事件时定下，每次尝试原样发送，签名按它计算。
CREATE TABLE webhook_events (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('batch.finished')),
  batch_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, batch_id, type),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, batch_id)
);

-- pending 的投递有下一次尝试的时间；领取时设租约，记下尝试后清除。
CREATE TABLE webhook_deliveries (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  webhook_id uuid NOT NULL,
  event_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (tenant_id, webhook_id, event_id),
  FOREIGN KEY (tenant_id, webhook_id) REFERENCES webhooks (tenant_id, id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES webhook_events (tenant_id, id),
  CHECK ((status = 'pending') = (next_attempt_at IS NOT NULL)),
  CHECK ((status = 'pending') = (finished_at IS NULL))
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_list ON webhook_deliveries (tenant_id, webhook_id, id);

-- 每次尝试：收到的 HTTP 状态，或没收到回答的原因；不记回答的正文。
CREATE TABLE webhook_attempts (
  delivery_id bigint NOT NULL REFERENCES webhook_deliveries (id),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  status_code integer CHECK (status_code BETWEEN 100 AND 599),
  error text CHECK (char_length(error) <= 300),
  PRIMARY KEY (delivery_id, attempt),
  CHECK (status_code IS NOT NULL OR error IS NOT NULL)
);

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON webhooks USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON webhook_events USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON webhook_deliveries USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
ALTER TABLE webhook_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON webhook_attempts USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());

-- webhook 不删除，只停用；事件与尝试只追加。
GRANT SELECT, INSERT, UPDATE ON webhooks, webhook_deliveries TO renderweave_app;
GRANT SELECT, INSERT ON webhook_events, webhook_attempts TO renderweave_app;
GRANT USAGE ON SEQUENCE webhook_deliveries_id_seq TO renderweave_app;

-- 投递任务领取到期的投递（跨租户）：所属 webhook 仍启用、没有别人的租约。正被别的事务锁住的下次再领。
CREATE FUNCTION rw_claim_webhook_deliveries(p_now timestamptz, p_lease_until timestamptz, p_limit integer)
RETURNS TABLE (id bigint, tenant_id uuid, webhook_id uuid, url text, secret_sealed text, event_id uuid, event_type text, body text, attempts integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH due AS (
    SELECT d.id FROM webhook_deliveries d
      JOIN webhooks w ON w.tenant_id = d.tenant_id AND w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= p_now AND (d.lease_until IS NULL OR d.lease_until < p_now) AND w.active
     ORDER BY d.next_attempt_at, d.id
     LIMIT p_limit
     FOR NO KEY UPDATE OF d SKIP LOCKED
  ), claimed AS (
    UPDATE webhook_deliveries d SET lease_until = p_lease_until FROM due WHERE d.id = due.id
    RETURNING d.id, d.tenant_id, d.webhook_id, d.event_id, d.attempts
  )
  SELECT c.id, c.tenant_id, c.webhook_id, w.url, w.secret_sealed, c.event_id, e.type, e.body, c.attempts
    FROM claimed c
    JOIN webhooks w ON w.tenant_id = c.tenant_id AND w.id = c.webhook_id
    JOIN webhook_events e ON e.tenant_id = c.tenant_id AND e.id = c.event_id
   ORDER BY c.id
$$;

REVOKE ALL ON FUNCTION rw_claim_webhook_deliveries(timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rw_claim_webhook_deliveries(timestamptz, timestamptz, integer) TO renderweave_app;
