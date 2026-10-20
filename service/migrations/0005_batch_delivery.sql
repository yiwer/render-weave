-- 0005 批量正式交付（票据 07，ADR-0017、ADR-0019）：批次行记快照、构建与幂等键，批次项按项进任务队列。
-- 一个批次只由接受它的那个构建的 worker 交付；批次项有租约，worker 中途退出时同构建的 worker 过了租约重领。
-- 写回结果以领取次数作凭据：重领之后，旧的写回不生效。最后结束的那一项在同一个事务里发布批次清单。

ALTER TABLE batches
  ADD COLUMN snapshot_sha256 char(64),
  ADD COLUMN build text,
  ADD COLUMN template text,
  ADD COLUMN mode text CHECK (mode IN ('final', 'draft')),
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_sha256 char(64),
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN summary jsonb,
  ADD COLUMN problems jsonb;
-- 同一租户内幂等键唯一：重试拿回同一批次。
CREATE UNIQUE INDEX batches_idempotency ON batches (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE render_tasks DROP CONSTRAINT render_tasks_kind_check;
ALTER TABLE render_tasks
  ADD CONSTRAINT render_tasks_kind_check CHECK (kind IN ('preview', 'batchItem')),
  ADD COLUMN batch_id uuid,
  ADD COLUMN item_index integer,
  ADD COLUMN build text,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT render_tasks_batch_item CHECK ((kind = 'batchItem') = (batch_id IS NOT NULL AND item_index IS NOT NULL AND build IS NOT NULL)),
  ADD CONSTRAINT render_tasks_batch FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, batch_id);
CREATE UNIQUE INDEX render_tasks_by_batch ON render_tasks (tenant_id, batch_id, item_index) WHERE batch_id IS NOT NULL;
-- 领取只看排队与渲染中的任务；做完的行留在表里（清理留给票据 15），不进这个索引。
CREATE INDEX render_tasks_open ON render_tasks (kind, build, item_index, created_at) WHERE status IN ('queued', 'running');

-- 领取：预览没有项序号，排在最前（停止前的 worker 不领预览）；批次项只领本构建的，按项序号轮转，各批次的第 1 项先于任何批次的第 2 项；
-- 过了租约还在渲染中的批次项可以重领。被别的 worker 锁住的跳过。
DROP FUNCTION rw_claim_task(text, timestamptz);
CREATE FUNCTION rw_claim_task(p_worker text, p_now timestamptz, p_build text, p_lease_until timestamptz, p_previews boolean)
RETURNS TABLE (id uuid, tenant_id uuid, kind text, request jsonb, batch_id uuid, item_index integer, attempts integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE render_tasks t SET status = 'running', worker = p_worker, started_at = p_now, attempts = t.attempts + 1,
         lease_until = CASE WHEN t.kind = 'batchItem' THEN p_lease_until END
   WHERE t.id = (
     SELECT q.id FROM render_tasks q
      WHERE q.status IN ('queued', 'running')
        AND ((q.kind = 'preview' AND q.status = 'queued' AND p_previews)
          OR (q.kind = 'batchItem' AND q.build = p_build AND (q.status = 'queued' OR q.lease_until < p_now)))
      ORDER BY q.item_index NULLS FIRST, q.created_at, q.id
      LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING t.id, t.tenant_id, t.kind, t.request, t.batch_id, t.item_index, t.attempts
$$;

REVOKE ALL ON FUNCTION rw_claim_task(text, timestamptz, text, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rw_claim_task(text, timestamptz, text, timestamptz, boolean) TO renderweave_app;
