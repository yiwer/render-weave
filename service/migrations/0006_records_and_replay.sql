-- 0006 出图记录的重放与在线的 worker（票据 08，ADR-0019）。
-- 重放是一种任务：记录在 request 里（批次与项序号），build 是记录所属的构建，只由那个构建的 worker 领取；
-- 它不是批次项，batch_id 与 item_index 留空，批次的进度、取消与发布都不受它影响。
-- worker 定期报到自己的构建；重放前据此判断记录所属的构建有没有 worker，没有就拒绝。

ALTER TABLE render_tasks DROP CONSTRAINT render_tasks_kind_check;
ALTER TABLE render_tasks
  ADD CONSTRAINT render_tasks_kind_check CHECK (kind IN ('preview', 'batchItem', 'replay')),
  ADD CONSTRAINT render_tasks_replay CHECK (kind <> 'replay' OR (build IS NOT NULL AND batch_id IS NULL AND item_index IS NULL));

-- 领取：预览与重放没有项序号，排在最前，停止前的 worker 都不领；重放只领本构建的。其余同 0005。
CREATE OR REPLACE FUNCTION rw_claim_task(p_worker text, p_now timestamptz, p_build text, p_lease_until timestamptz, p_previews boolean)
RETURNS TABLE (id uuid, tenant_id uuid, kind text, request jsonb, batch_id uuid, item_index integer, attempts integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE render_tasks t SET status = 'running', worker = p_worker, started_at = p_now, attempts = t.attempts + 1,
         lease_until = CASE WHEN t.kind = 'batchItem' THEN p_lease_until END
   WHERE t.id = (
     SELECT q.id FROM render_tasks q
      WHERE q.status IN ('queued', 'running')
        AND ((q.kind = 'preview' AND q.status = 'queued' AND p_previews)
          OR (q.kind = 'replay' AND q.status = 'queued' AND p_previews AND q.build = p_build)
          OR (q.kind = 'batchItem' AND q.build = p_build AND (q.status = 'queued' OR q.lease_until < p_now)))
      ORDER BY q.item_index NULLS FIRST, q.created_at, q.id
      LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING t.id, t.tenant_id, t.kind, t.request, t.batch_id, t.item_index, t.attempts
$$;

-- 在线的 worker：不属于任何租户，应用账号只能经下面的函数报到、离开与查询。
CREATE TABLE workers (
  worker text PRIMARY KEY,
  build text NOT NULL,
  seen_at timestamptz NOT NULL
);
REVOKE ALL ON workers FROM PUBLIC;

CREATE FUNCTION rw_worker_heartbeat(p_worker text, p_build text, p_now timestamptz) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO workers (worker, build, seen_at) VALUES (p_worker, p_build, p_now)
  ON CONFLICT (worker) DO UPDATE SET build = EXCLUDED.build, seen_at = EXCLUDED.seen_at
$$;

CREATE FUNCTION rw_worker_leave(p_worker text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM workers WHERE worker = p_worker $$;

CREATE FUNCTION rw_online_workers(p_since timestamptz) RETURNS TABLE (build text, workers bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT build, count(*) FROM workers WHERE seen_at >= p_since GROUP BY build $$;

-- 被出图记录引用的构建（跨租户，平台管理员看）：只要还有记录引用某个构建，就保留它的镜像。
CREATE FUNCTION rw_record_builds() RETURNS TABLE (build text, records bigint, last_delivered_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT b.build, count(*), max(i.created_at)
    FROM batch_items i JOIN batches b USING (tenant_id, batch_id)
   WHERE i.completion = 'record.json' AND b.build IS NOT NULL
   GROUP BY b.build ORDER BY b.build
$$;

REVOKE ALL ON FUNCTION rw_worker_heartbeat(text, text, timestamptz), rw_worker_leave(text), rw_online_workers(timestamptz), rw_record_builds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rw_worker_heartbeat(text, text, timestamptz), rw_worker_leave(text), rw_online_workers(timestamptz), rw_record_builds() TO renderweave_app;
