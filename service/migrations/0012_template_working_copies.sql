-- 0012 模板工作副本与修订来源（P1 票据 07，M346）。
-- 工作副本是服务端为一个模板名称存下的、还没保存的那一份：每个名称至多一份，base_revision 记它基于哪个修订，复制出来的新模板没有。
-- 内容按原始字节存进本租户的内容，这里只登记哈希；出图照旧读当前修订，工作副本不进 workspace_documents。
-- 修订记来源：推送，或保存工作副本。已有的修订都是推送产生的。

CREATE TABLE template_working_copies (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  base_revision integer CHECK (base_revision >= 1),
  sha256 char(64) NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

ALTER TABLE template_working_copies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON template_working_copies USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON template_working_copies TO renderweave_app;

ALTER TABLE template_revisions ADD COLUMN source text NOT NULL DEFAULT 'push' CHECK (source IN ('push', 'web'));
