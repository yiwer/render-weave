-- 0002 账号、鉴权、审计与行级安全（ADR-0018、M247、M261、M262）。
-- 接口进程与 worker 用非属主的应用账号 renderweave_app 连库，行级安全对它生效；迁移由属主在部署步骤里执行。
-- 每个事务设置当前租户（app.tenant_id）。平台级操作显式开启平台模式（app.platform），只对平台需要的表有效。
-- 按邮箱登录、按令牌解析身份要跨租户查找，由属主身份执行的两个函数完成，只返回鉴权需要的列。

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'renderweave_app') THEN
    CREATE ROLE renderweave_app NOLOGIN;
  END IF;
END $$;

CREATE FUNCTION rw_current_tenant() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION rw_platform_mode() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.platform', true), '') = 'on' $$;

-- 成员属于一个租户（管理员或操作员）；平台用户不属于任何租户。邮箱全局唯一，存小写。
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants (id),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  role text NOT NULL CHECK ((tenant_id IS NULL AND role = 'platformAdmin') OR (tenant_id IS NOT NULL AND role IN ('admin', 'operator'))),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 令牌只存 SHA-256。
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  tenant_id uuid REFERENCES tenants (id),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  prefix text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE authoring_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  prefix text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE authoring_token_tenants (
  token_id uuid NOT NULL REFERENCES authoring_tokens (id),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  PRIMARY KEY (token_id, tenant_id)
);

-- 审计只追加：应用账号只有插入与查询权限。不属于任何租户的事件（建平台用户、签发代建令牌）tenant_id 为空。
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants (id),
  at timestamptz NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  actor_label text NOT NULL,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  cross_tenant boolean NOT NULL
);
CREATE INDEX audit_events_by_tenant ON audit_events (tenant_id, id DESC);

-- 行级安全。租户数据只认当前租户；账号、会话与审计另认平台模式；代建令牌只在平台模式下可见。
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON tenants USING (id = rw_current_tenant() OR rw_platform_mode()) WITH CHECK (rw_platform_mode());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_documents', 'resource_stores', 'resources', 'resource_versions', 'batches', 'batch_items', 'batch_item_files', 'api_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = rw_current_tenant()) WITH CHECK (tenant_id = rw_current_tenant())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['users', 'sessions', 'audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_rows ON %I USING (tenant_id = rw_current_tenant() OR rw_platform_mode()) WITH CHECK (tenant_id = rw_current_tenant() OR rw_platform_mode())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['authoring_tokens', 'authoring_token_tenants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_rows ON %I USING (rw_platform_mode()) WITH CHECK (rw_platform_mode())', t);
  END LOOP;
END $$;

-- 按邮箱找登录账号（不分租户）。
CREATE FUNCTION rw_find_login(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, email text, role text, password_hash text, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT id, tenant_id, email, role, password_hash, active FROM users WHERE email = lower(p_email) $$;

-- 按令牌哈希解析身份：未过期、未吊销的会话（账号启用），未吊销的 API 密钥，未过期、未吊销的代建令牌。
CREATE FUNCTION rw_resolve_token(p_hash text, p_now timestamptz)
RETURNS TABLE (kind text, id uuid, user_id uuid, tenant_id uuid, role text, label text, tenant_ids uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN u.tenant_id IS NULL THEN 'platformUser' ELSE 'member' END, s.id, u.id, u.tenant_id, u.role, u.email, NULL::uuid[]
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > p_now AND u.active
  UNION ALL
  SELECT 'apiKey', k.id, NULL, k.tenant_id, 'apiKey', k.name, NULL
    FROM api_keys k WHERE k.token_hash = p_hash AND k.revoked_at IS NULL
  UNION ALL
  SELECT 'authoringToken', a.id, NULL, NULL, 'authoringEngineer', a.label,
         ARRAY(SELECT t.tenant_id FROM authoring_token_tenants t WHERE t.token_id = a.id ORDER BY t.tenant_id)
    FROM authoring_tokens a WHERE a.token_hash = p_hash AND a.revoked_at IS NULL AND a.expires_at > p_now
$$;

REVOKE ALL ON FUNCTION rw_find_login(text), rw_resolve_token(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rw_find_login(text), rw_resolve_token(text, timestamptz) TO renderweave_app;

-- 应用账号的权限：不能改表结构，审计与内容登记只能追加。
GRANT USAGE ON SCHEMA public TO renderweave_app;
GRANT SELECT ON schema_migrations TO renderweave_app;
GRANT SELECT, INSERT ON tenants, resources, resource_versions, batch_items, batch_item_files, authoring_token_tenants, audit_events TO renderweave_app;
GRANT SELECT, INSERT, UPDATE ON workspace_documents, resource_stores, batches, users, sessions, api_keys, authoring_tokens TO renderweave_app;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO renderweave_app;
