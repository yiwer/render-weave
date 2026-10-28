/**
 * 控制台的模块（P1 票据 01，M208、M341）：标题栏的模块下拉、Ctrl+数字与 Ctrl+K 都从这张表来。
 * - 一个模块是一组 # 路由的第一段：路由不变，旧链接照旧能打开（出图记录、批次、Excel 导入等仍在原来的地址）；
 * - 按角色只列能进的模块，Ctrl+数字按列出的顺序编号；
 * - 平台管理员的"平台"模块与 Agent 的左栏在后续票据加入（P1 票据 12、P2）。
 */
import type { Identity } from './types.js';

export type ModuleId = 'definitions' | 'templates' | 'datasets' | 'deliver' | 'resources' | 'usage' | 'admin';

export interface ConsoleModule {
  readonly id: ModuleId;
  readonly label: string;
  /** 打开模块时去的地址（路由的各段）。 */
  readonly home: readonly string[];
  /** 属于这个模块的路由第一段。 */
  readonly sections: readonly string[];
  readonly roles: readonly string[];
  /** 24 × 24 的描线图标。 */
  readonly icon: string;
}

const MEMBERS = ['admin', 'operator'];

export const MODULES: readonly ConsoleModule[] = [
  { id: 'definitions', label: '数据定义', home: ['definitions'], sections: ['definitions'], roles: MEMBERS,
    icon: 'M4.5 5.5c0-1.4 3.4-2.5 7.5-2.5s7.5 1.1 7.5 2.5-3.4 2.5-7.5 2.5-7.5-1.1-7.5-2.5zM4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5' },
  { id: 'templates', label: '模板', home: ['templates'], sections: ['templates'], roles: MEMBERS, icon: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 9h18M9 9v11' },
  // 选几份数据集出图（#/deliver）是数据集列表上开的侧栏，算数据集；批次与出图记录算出图。
  { id: 'datasets', label: '数据集', home: ['datasets'], sections: ['datasets', 'import', 'deliver'], roles: MEMBERS,
    icon: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M3 15h18M10 4v16' },
  { id: 'deliver', label: '出图', home: ['records'], sections: ['records', 'batches'], roles: MEMBERS, icon: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5' },
  { id: 'resources', label: '资源', home: ['resources'], sections: ['resources'], roles: MEMBERS, icon: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM11 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM21 16l-5-5-9 9' },
  { id: 'usage', label: '用量', home: ['usage'], sections: ['usage'], roles: MEMBERS, icon: 'M3 20h18M6 16v-5M11 16V6M16 16v-8' },
  { id: 'admin', label: '管理', home: ['admin'], sections: ['admin'], roles: ['admin'],
    icon: 'M12.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2' },
];

/** 这个身份能进的模块，按下拉里的顺序。 */
export const modulesFor = (identity: Identity): readonly ConsoleModule[] => MODULES.filter((module) => module.roles.includes(identity.role));

/** 路由第一段所属的模块；首页（没有路由）是数据集。 */
export const moduleOf = (section: string | undefined): ConsoleModule | undefined =>
  MODULES.find((module) => module.sections.includes(section ?? 'datasets'));

export interface ConsoleAction {
  readonly id: string;
  readonly label: string;
  readonly path: readonly string[];
  /** 打开之后把焦点放到这个元素上（元素 ID）。 */
  readonly focus?: string;
  readonly roles: readonly string[];
}

/** Ctrl+K 里的常用动作：只是去哪一页、做哪一步，不搜数据集、模板这类对象。 */
export const ACTIONS: readonly ConsoleAction[] = [
  { id: 'new-dataset', label: '新建数据集', path: ['datasets'], focus: 'new-dataset-template', roles: MEMBERS },
  { id: 'import', label: '从 Excel 导入', path: ['import'], roles: MEMBERS },
  { id: 'upload', label: '上传资源', path: ['resources'], focus: 'upload-kind', roles: MEMBERS },
  { id: 'members', label: '管理成员', path: ['admin', 'members'], roles: ['admin'] },
  { id: 'api-keys', label: '创建 API 密钥', path: ['admin', 'api-keys'], roles: ['admin'] },
  { id: 'audit', label: '查看审计日志', path: ['admin', 'audit'], roles: ['admin'] },
];

export const actionsFor = (identity: Identity): readonly ConsoleAction[] => ACTIONS.filter((action) => action.roles.includes(identity.role));
