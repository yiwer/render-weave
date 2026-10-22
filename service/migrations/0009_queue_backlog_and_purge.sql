-- 0009 队列积压与任务行的清理（票据 15，ADR-0017）。
-- 积压：跨租户只给计数，经接口进程与 worker 的就绪检查可见；只看排队与渲染中的行，走 render_tasks_open。
-- 清理：预览与重放的结果由接口进程同步取走，之后没人再读，过了保留期就删；批次项的行是批次逐项状态与出图记录列表的来源，不删。
-- 应用账号没有 render_tasks 的删除权限，只能经属主身份执行的 rw_purge_tasks 删。

CREATE FUNCTION rw_queue_backlog() RETURNS TABLE (kind text, status text, tasks bigint, oldest timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT kind, status, count(*), min(created_at) FROM render_tasks WHERE status IN ('queued', 'running') GROUP BY kind, status $$;

REVOKE ALL ON FUNCTION rw_queue_backlog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rw_queue_backlog() TO renderweave_app;

CREATE INDEX render_tasks_transient ON render_tasks (created_at) WHERE kind IN ('preview', 'replay');

CREATE FUNCTION rw_purge_tasks(p_before timestamptz) RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH gone AS (DELETE FROM render_tasks WHERE kind IN ('preview', 'replay') AND created_at < p_before RETURNING 1)
  SELECT count(*) FROM gone
$$;

REVOKE ALL ON FUNCTION rw_purge_tasks(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rw_purge_tasks(timestamptz) TO renderweave_app;
