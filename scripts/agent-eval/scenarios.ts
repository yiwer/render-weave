/**
 * 评估配置（config.json）：场景、通过线与最少计划次数。通过线以 M213–M217 的实测为基线（第三阶段 PRD 第 17 条）。
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const REPO = join(import.meta.dirname, '../..');

interface ScenarioBase {
  readonly id: string;
  readonly name: string;
  /** 示例图、项目说明等路径相对仓库根目录。 */
  readonly sample: string;
  readonly brief: string;
  readonly domain?: string;
  readonly reference?: string;
  readonly contentBaseline?: string;
}

/** 数据定义提取一轮，按专家字段与 6 项约定评分。 */
export interface DefinitionScenario extends ScenarioBase {
  readonly kind: 'definition';
  readonly pass: { readonly conventions: number; readonly expertFields: number };
}

/** 模板辅助设计一轮：工作区只放专家版数据定义与数据集，不放专家模板。 */
export interface TemplateScenario extends ScenarioBase {
  readonly kind: 'template';
  readonly workspace: { readonly from: string; readonly files: readonly string[] };
  readonly dataset: string;
  readonly request: string;
  readonly pass: { readonly stress: number; readonly layoutChecks: number };
}

/** 模板辅助修改一轮：从固定的已保存模板出发，只允许修改要求点名的模板。 */
export interface RevisionScenario extends Omit<TemplateScenario, 'kind' | 'pass'> {
  readonly kind: 'revision';
  readonly savedTemplates: { readonly from: string; readonly files: readonly string[] };
  readonly requirement: string;
  readonly allowedTemplates: readonly string[];
  readonly pass: { readonly stress: number; readonly layoutChecks: number; readonly scopeViolations: number };
}

/** 数据定义提取、模拟审核（全部采纳）并应用，再做数据集提取；按人工转录评分。 */
export interface TranscriptionScenario extends ScenarioBase {
  readonly kind: 'transcription';
  readonly datasetBrief: string;
  readonly truth: string;
  readonly pass: { readonly names: number; readonly landmarks: number; readonly facilities: number; readonly orderViolations: number; readonly insertions: number; readonly duplicates: number; readonly landmarkExtra: number; readonly facilityExtra: number };
}

/** 已知可修初始成果的反馈接续；seed 是受控初始状态，不冒充首次模型产物。 */
export interface FeedbackScenario extends ScenarioBase {
  readonly kind: 'feedback';
  readonly language: 'zh' | 'en';
  readonly task: import('../../src/index.js').AgentTaskId;
  readonly seedRound: string;
  readonly feedback: string;
  readonly policy: string;
  readonly pass: {readonly targetCorrection: true; readonly nonTargetPreservation: true; readonly unknownRetained: true};
}
export type Scenario = DefinitionScenario | TemplateScenario | RevisionScenario | TranscriptionScenario | FeedbackScenario;

export const stageNames = (scenario: Scenario): readonly string[] => scenario.kind === 'transcription' ? ['definition', 'dataset'] : [scenario.kind];

export interface EvalConfig {
  readonly format: 'renderweave-agent-eval-config/2';
  /** 每个场景至少预登记几次；字段名沿用旧配置。 */
  readonly consecutivePasses: number;
  readonly resources: string;
  readonly evidence?: 'mechanism' | 'real-model';
  readonly scenarios: readonly Scenario[];
}

export const CONFIG_FILE = join(REPO, 'scripts/agent-eval/config.json');

export async function readConfig(file = CONFIG_FILE): Promise<EvalConfig> {
  const config = JSON.parse(await readFile(file, 'utf8')) as EvalConfig;
  if (config.format !== 'renderweave-agent-eval-config/2') throw new Error(`评估配置需 renderweave-agent-eval-config/2 的核准评分政策：${file}；评估未完成，不自动迁移旧通过线`);
  for (const scenario of config.scenarios) {
    if (scenario.kind === 'feedback') {
      if (!['zh', 'en'].includes(scenario.language) || !['definition-extraction', 'dataset-extraction', 'template-design', 'template-revision'].includes(scenario.task) || !Number.isSafeInteger(config.consecutivePasses) || config.consecutivePasses < 2) throw new Error('可信反馈需要中英四种任务和每类至少两次的完整计划');
    }
    if (scenario.kind !== 'transcription') continue;
    const required = ['names', 'landmarks', 'facilities', 'orderViolations', 'insertions', 'duplicates', 'landmarkExtra', 'facilityExtra'] as const;
    if (required.some((key) => !Number.isSafeInteger(scenario.pass?.[key]) || scenario.pass[key] < 0)) {
      throw new Error(`转录案例 ${scenario.id} 缺少完整核准评分政策；评估未完成，补齐通过线后再运行`);
    }
    let truth: { stops?: { name?: unknown; landmark?: unknown; facilities?: unknown }[] } | null;
    try { truth = JSON.parse(await readFile(repoPath(scenario.truth), 'utf8')); }
    catch { throw new Error(`转录案例 ${scenario.id} 无法读取核准真值；评估未完成，核对 truth 路径与文件`); }
    if (!truth || !Array.isArray(truth.stops) || truth.stops.length === 0 || truth.stops.some((stop) => !stop || typeof stop.name !== 'string' || stop.name.trim() === '' ||
      (stop.landmark !== undefined && (!Number.isSafeInteger(stop.landmark) || Number(stop.landmark) < 1)) ||
      (stop.facilities !== undefined && (!Array.isArray(stop.facilities) || stop.facilities.some((value) => typeof value !== 'string'))))) {
      throw new Error(`转录案例 ${scenario.id} 缺少有效核准真值；评估未完成，需非空的逐次停靠站点事实`);
    }
  }
  return config;
}

/** 配置中的路径相对仓库根目录。 */
export function repoPath(path: string): string {
  return isAbsolute(path) ? path : join(REPO, path);
}
