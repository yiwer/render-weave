/**
 * M247 的权限矩阵：五种身份各能做什么。路由只声明需要的权限，由鉴权钩子统一判断。
 * 后续票据的端点（数据集、资源、预览、交付、记录、webhook、用量、推送、套餐）沿用这张表里已有的权限名。
 */
import type { Identity } from '../backend.js';

export type Permission =
  | 'tenant.read' | 'datasets.write' | 'resources.upload' | 'preview' | 'deliver' | 'records.read' | 'usage.summary'
  | 'members.manage' | 'apiKeys.manage' | 'webhooks.manage' | 'resources.replace' | 'usage.read' | 'audit.read'
  | 'authoring.read' | 'authoring.push' | 'authoring.preview'
  | 'platform.tenants' | 'platform.members' | 'platform.authoringTokens' | 'platform.plans';

export type IdentityRole = 'admin' | 'operator' | 'apiKey' | 'authoringEngineer' | 'platformAdmin';

/**
 * 客户操作员：管理数据集，上传新的图片与字体资源，预览、交付与查询记录；
 * 另看本租户一个周期的用量合计（已用、预占、剩余，M300），用量明细（usage.read）仍只给客户管理员。
 */
const OPERATOR: readonly Permission[] = ['tenant.read', 'datasets.write', 'resources.upload', 'preview', 'deliver', 'records.read', 'usage.summary'];

export const ROLE_PERMISSIONS: Readonly<Record<IdentityRole, readonly Permission[]>> = {
  operator: OPERATOR,
  /** 客户管理员：操作员的全部权限，另管成员、API 密钥与 webhook，替换已有资源，查看用量明细与审计。 */
  admin: [...OPERATOR, 'members.manage', 'apiKeys.manage', 'webhooks.manage', 'resources.replace', 'usage.read', 'audit.read'],
  /** API 密钥：操作员的全部权限加 webhook 管理；不能管成员与密钥，也不能替换已有资源。 */
  apiKey: [...OPERATOR, 'webhooks.manage'],
  /** 代建工程师：只对被指定的租户读取、推送与预览。 */
  authoringEngineer: ['authoring.read', 'authoring.push', 'authoring.preview'],
  /** 平台管理员：租户、成员账号、代建令牌与套餐。 */
  platformAdmin: ['platform.tenants', 'platform.members', 'platform.authoringTokens', 'platform.plans'],
};

export function identityRole(identity: Identity): IdentityRole {
  switch (identity.kind) {
    case 'member': return identity.role;
    case 'apiKey': return 'apiKey';
    case 'authoringToken': return 'authoringEngineer';
    case 'platformUser': return 'platformAdmin';
  }
}

export const can = (identity: Identity, permission: Permission) => ROLE_PERMISSIONS[identityRole(identity)].includes(permission);

/** 路由的访问要求：公开、任何已鉴权身份、持有会话（成员或平台用户），或某项权限。 */
export type Access = 'public' | 'authenticated' | 'session' | Permission;
