-- 0017 数据定义是独立的实体（ADR-0030，M389）：主键是（租户, 名称），发布只产出静态数据定义，不往这一行写任何东西，所以不再记基于的版本。
-- 存量里只有静态版本的名称要补一行，内容是最新版本去掉版本号。内容在对象存储里，SQL 读不到，由部署步骤（main.ts 的 setup）在迁移之后补，全部补完才删掉这个标记。
-- 这张表只有属主账号用：应用账号没有权限。
ALTER TABLE definition_drafts RENAME TO definitions;
ALTER TABLE definitions DROP COLUMN base_version;

CREATE TABLE pending_data_steps (step text PRIMARY KEY);
INSERT INTO pending_data_steps (step) VALUES ('definitions-backfill');
