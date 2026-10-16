/**
 * 评估配置（config.json）：场景、通过线与连续达线次数。通过线以 M213–M217 的实测为基线（第三阶段 PRD 第 17 条）。
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

/** 数据定义提取、模拟审核（全部采纳）并应用，再做数据集提取；按人工转录评分。 */
export interface TranscriptionScenario extends ScenarioBase {
  readonly kind: 'transcription';
  readonly datasetBrief: string;
  readonly truth: string;
  readonly pass: { readonly names: number; readonly landmarks: number; readonly facilities: number };
}

export type Scenario = DefinitionScenario | TemplateScenario | TranscriptionScenario;

export interface EvalConfig {
  readonly format: 'renderweave-agent-eval-config/1';
  /** 每个场景要连续达线的次数。 */
  readonly consecutivePasses: number;
  readonly resources: string;
  readonly scenarios: readonly Scenario[];
}

export const CONFIG_FILE = join(REPO, 'scripts/agent-eval/config.json');

export async function readConfig(file = CONFIG_FILE): Promise<EvalConfig> {
  const config = JSON.parse(await readFile(file, 'utf8')) as EvalConfig;
  if (config.format !== 'renderweave-agent-eval-config/1') throw new Error(`评估配置格式不对：${file}`);
  return config;
}

/** 配置中的路径相对仓库根目录。 */
export function repoPath(path: string): string {
  return isAbsolute(path) ? path : join(REPO, path);
}
