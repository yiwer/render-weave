-- 仅用于合并前已经执行 0015_agent_jobs.sql 的内部测试库。
-- 停止 API 和所有 worker、完成备份后，用数据库属主运行；再以新构建执行 setup。
-- 只改迁移登记编号，原 SQL 与哈希不变；普通安装或已完成转换的库会拒绝。
BEGIN;
SELECT pg_advisory_xact_lock(1381453127);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 15 AND name = 'agent_jobs' AND sha256 = '44fe2d532aa6805e6efab146b2476d09249e6b59b0f9d9f00825c25594bbf8a5')
     OR EXISTS (SELECT 1 FROM schema_migrations WHERE version >= 16)
     OR to_regclass('agent_jobs') IS NULL THEN
    RAISE EXCEPTION '不是待转换的 0015_agent_jobs 测试库；未做修改';
  END IF;
  UPDATE schema_migrations SET version = 16 WHERE version = 15;
END $$;
COMMIT;
