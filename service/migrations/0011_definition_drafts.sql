-- 0011 数据定义草案（P1 票据 04，M297、M298、M346）：服务端为一个数据定义名称存下的、还没发布的那一份。
-- 每个名称至多一份；base_version 记它基于哪个静态版本，新名称没有。内容按原始字节存进本租户的内容，这里只登记哈希。
-- 草案可以改、可以删，发布后删除（票据 05），所以应用账号有 UPDATE 与 DELETE。

CREATE TABLE definition_drafts (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  base_version integer CHECK (base_version >= 1),
  sha256 char(64) NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

ALTER TABLE definition_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON definition_drafts USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON definition_drafts TO renderweave_app;
