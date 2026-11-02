-- 0014 审批策略与发布申请（P1 票据 11，ADR-0022）。
-- 审批策略：两个范围各一个开关，没有行就是关（直发）。
-- 发布申请固定内容哈希与基准：草案、工作副本、要指回的修订，或推送清单（清单存在本租户的内容里，没有登记，读不到）。
-- subject 是申请的对象：数据定义或模板的名称；推送是发起者的 ID，同一对象同一种申请同时最多一份待处理。

CREATE TABLE approval_policies (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  scope text NOT NULL CHECK (scope IN ('definitions', 'templates')),
  required boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  PRIMARY KEY (tenant_id, scope)
);

CREATE TABLE publish_requests (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('definitionPublish', 'templateSave', 'templateSetCurrent', 'push')),
  subject text NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  sha256 char(64) NOT NULL,
  before_sha256 char(64),
  base_version integer,
  version integer,
  base_revision integer,
  revision integer,
  overwrite boolean NOT NULL DEFAULT false,
  diff jsonb NOT NULL,
  requested_by_kind text NOT NULL,
  requested_by_id text NOT NULL,
  requested_by_label text NOT NULL,
  requested_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  message text,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX publish_requests_one_pending ON publish_requests (tenant_id, kind, subject) WHERE status = 'pending';
CREATE INDEX publish_requests_recent ON publish_requests (tenant_id, requested_at DESC);

ALTER TABLE approval_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON approval_policies USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_policies TO renderweave_app;

ALTER TABLE publish_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON publish_requests USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON publish_requests TO renderweave_app;
