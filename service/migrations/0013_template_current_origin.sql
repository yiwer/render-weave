-- 0013 当前修订的来历（P1 票据 10，M348）：推送要知道当前修订是不是推送产生的，冲突时要说明由谁在何时产生。
-- current_source：push 是推送产生的，或代建工程师自己指回的；web 是网页与接口上保存工作副本，或客户管理员指回的。
-- current_action：revision 是记了新修订，setCurrent 是指回已有的修订。
-- 已有的行都是推送产生的；current_by、current_at 空着时取当前修订自己的主体与时间。

ALTER TABLE templates
  ADD COLUMN current_source text NOT NULL DEFAULT 'push' CHECK (current_source IN ('push', 'web')),
  ADD COLUMN current_action text NOT NULL DEFAULT 'revision' CHECK (current_action IN ('revision', 'setCurrent')),
  ADD COLUMN current_by text,
  ADD COLUMN current_at timestamptz;
