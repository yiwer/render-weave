-- 工作簿提取使用统一 Agent 任务记录。素材/轮次字节仍在租户内容存储。
CREATE TABLE agent_jobs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON agent_jobs USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
GRANT SELECT, INSERT, UPDATE ON agent_jobs TO renderweave_app;
