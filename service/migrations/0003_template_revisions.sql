-- 0003 代建推送的模板修订（票据 05，M264）。
-- 推送进来的工作区文档仍登记在 workspace_documents，来源写成"种类:键"（definition:名称@版本、compiled:名称@版本、template:模板名、dataset:数据集ID）。
-- 模板每次推送改了内容就记一个新修订，修订只追加；templates 按名称指向当前修订，workspace_documents 里模板那一行跟着指向当前修订的内容。

CREATE TABLE template_revisions (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  sha256 char(64) NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  pushed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name, revision)
);

CREATE TABLE templates (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  current_revision integer NOT NULL,
  PRIMARY KEY (tenant_id, name),
  FOREIGN KEY (tenant_id, name, current_revision) REFERENCES template_revisions (tenant_id, name, revision)
);

ALTER TABLE template_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON template_revisions USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON templates USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());

-- 修订只能追加；当前修订可以改。
GRANT SELECT, INSERT ON template_revisions TO renderweave_app;
GRANT SELECT, INSERT, UPDATE ON templates TO renderweave_app;
