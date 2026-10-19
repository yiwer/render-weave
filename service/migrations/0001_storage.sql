-- 0001 存储（ADR-0018、ADR-0019）：租户、工作区文档、版本化资源仓库、批次与出图记录。
-- 数据库只记元数据与提交点；内容是对象存储里按 SHA-256 寻址的不可变字节，先写对象、再在事务里登记。
-- 每张租户表都带 tenant_id；行级安全随租户与鉴权一起开启。

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 工作区文档按原始字节存（M112 的精度检查与出图记录都依赖原文），这里只登记来源与哈希。
CREATE TABLE workspace_documents (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  source text NOT NULL,
  sha256 char(64) NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source)
);

-- 每个租户一行，提交资源变更时加锁，同一租户的提交依次进行。
CREATE TABLE resource_stores (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id)
);

-- renderweave-resources/1 的语义：资源 ID 与种类固定，内容版本从 1 连续递增，当前版本是最大的版本号。
CREATE TABLE resources (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  resource_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'font')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, resource_id)
);

CREATE TABLE resource_versions (
  tenant_id uuid NOT NULL,
  resource_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  sha256 char(64) NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, resource_id, version),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resources (tenant_id, resource_id)
);

-- 批次清单（batch.json）在全部项结束后登记。
CREATE TABLE batches (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  batch_id uuid NOT NULL DEFAULT gen_random_uuid(),
  manifest_sha256 char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, batch_id)
);

-- 一项的成果在一个事务里登记，"批次加项序号"唯一：重领同一项也只登记一次（ADR-0019）。
-- completion 是完成清单：正式成功项为 record.json，草稿项为 preview.json，失败项没有。
CREATE TABLE batch_items (
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  item_index integer NOT NULL CHECK (item_index BETWEEN 1 AND 1000),
  completion text CHECK (completion IN ('record.json', 'preview.json')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id, item_index),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches (tenant_id, batch_id)
);

CREATE TABLE batch_item_files (
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  item_index integer NOT NULL,
  name text NOT NULL,
  sha256 char(64) NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  PRIMARY KEY (tenant_id, batch_id, item_index, name),
  FOREIGN KEY (tenant_id, batch_id, item_index) REFERENCES batch_items (tenant_id, batch_id, item_index)
);
