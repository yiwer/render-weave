-- 0004 渲染任务队列（票据 06，ADR-0017）：接口进程入队，worker 用 SELECT … FOR UPDATE SKIP LOCKED 领取。
-- 入队、查结果与写回结果都在租户的事务里，行级安全照常生效；领取要跨租户，由属主身份执行的 rw_claim_task 完成，只返回渲染需要的列。
-- 结果是引擎 render 的结果：问题清单与布局摘要放在 result，图片放在 image。接口进程取走后清掉图片与布局。

CREATE TABLE render_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('preview')),
  request jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'cancelled')),
  worker text,
  result jsonb,
  image bytea,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX render_tasks_queued ON render_tasks (created_at, id) WHERE status = 'queued';
CREATE INDEX render_tasks_by_tenant ON render_tasks (tenant_id, kind, created_at);

ALTER TABLE render_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON render_tasks USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
GRANT SELECT, INSERT, UPDATE ON render_tasks TO renderweave_app;

-- 领取最早排队的一项，标为渲染中；被别的 worker 锁住的跳过。
CREATE FUNCTION rw_claim_task(p_worker text, p_now timestamptz)
RETURNS TABLE (id uuid, tenant_id uuid, kind text, request jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE render_tasks t SET status = 'running', worker = p_worker, started_at = p_now
   WHERE t.id = (SELECT q.id FROM render_tasks q WHERE q.status = 'queued' ORDER BY q.created_at, q.id LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING t.id, t.tenant_id, t.kind, t.request
$$;

REVOKE ALL ON FUNCTION rw_claim_task(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rw_claim_task(text, timestamptz) TO renderweave_app;
