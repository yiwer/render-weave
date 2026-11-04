-- 静态数据定义的版本可以自定义（ADR-0028）：基于的版本与申请的版本改成文本，编号写成十进制，读回时还原成整数。
-- 发布说明记在发布的审计事件里；发布要批准时先存在申请上，批准时才写进审计。
ALTER TABLE definition_drafts DROP CONSTRAINT IF EXISTS definition_drafts_base_version_check;
ALTER TABLE definition_drafts ALTER COLUMN base_version TYPE text USING base_version::text;
ALTER TABLE publish_requests ALTER COLUMN base_version TYPE text USING base_version::text;
ALTER TABLE publish_requests ALTER COLUMN version TYPE text USING version::text;
ALTER TABLE publish_requests ADD COLUMN note text;
