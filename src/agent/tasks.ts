/**
 * 业务 Agent 任务的四种类型（M43）。每种任务产出一种成果，交给 Agent 的 DSL 参考与可用工具随任务而定。
 * 第三阶段票据 04 实现数据定义提取，票据 06 实现数据集提取与模板辅助设计，票据 07 实现模板辅助修改。
 */
export type AgentTaskId = 'definition-extraction' | 'dataset-extraction' | 'template-design' | 'template-revision';
export type CandidateKind = 'definition' | 'dataset' | 'template';

export interface AgentTask {
  readonly id: AgentTaskId;
  /** 命令行与文档中的中文名称。 */
  readonly name: string;
  readonly implemented: boolean;
  /** 成果中允许的候选文档种类。 */
  readonly candidateKinds: readonly CandidateKind[];
  /** 发起前必须已有的输入（M43）：数据集提取要已发布的数据定义，模板辅助设计要已保存的数据集，模板辅助修改要已保存的模板。 */
  readonly requires: 'none' | 'definition' | 'dataset' | 'template';
  /** 示例图对应的出图请求：模板辅助设计必须给，数据集提取可选（工作区已有模板时用来预览），数据定义提取不用。 */
  readonly request: 'none' | 'optional' | 'required';
  /** 复制进轮次 docs/ 的 Agent 参考：agent/reference/<名称>.md。 */
  readonly references: readonly string[];
  /** Claude Code 的内置工具与本仓库 MCP 服务开放的工具。 */
  readonly tools: string;
  readonly mcpTools: readonly string[];
  readonly maxTurns: number;
}

export const AGENT_TASKS: Readonly<Record<AgentTaskId, AgentTask>> = {
  'definition-extraction': {
    id: 'definition-extraction', name: '数据定义提取', implemented: true, candidateKinds: ['definition'], requires: 'none', request: 'none',
    references: ['data-definition', 'outcome'], tools: 'Read,Write,Edit,Glob',
    mcpTools: ['list_documents', 'read_document', 'list_resources', 'check_definitions', 'check_dataset', 'view_image', 'dsl_reference'],
    maxTurns: 40,
  },
  'dataset-extraction': {
    id: 'dataset-extraction', name: '数据集提取', implemented: true, candidateKinds: ['dataset'], requires: 'definition', request: 'optional',
    references: ['data-definition', 'outcome'], tools: 'Read,Write,Edit,Glob',
    mcpTools: ['list_documents', 'read_document', 'list_resources', 'check_dataset', 'view_image', 'dsl_reference', 'render_draft'],
    maxTurns: 40,
  },
  'template-design': {
    id: 'template-design', name: '模板辅助设计', implemented: true, candidateKinds: ['template'], requires: 'dataset', request: 'required',
    references: ['template', 'outcome'], tools: 'Read,Write,Edit,Glob',
    mcpTools: ['list_documents', 'read_document', 'list_resources', 'check_templates', 'render_draft', 'inspect_layout', 'view_image', 'dsl_reference'],
    // 票据 03 的模板步骤在 60 轮上限处停下，改为 80。
    maxTurns: 80,
  },
  'template-revision': {
    id: 'template-revision', name: '模板辅助修改', implemented: true, candidateKinds: ['template'], requires: 'template', request: 'required',
    references: ['template', 'outcome'], tools: 'Read,Write,Edit,Glob',
    mcpTools: ['list_documents', 'read_document', 'list_resources', 'check_templates', 'render_draft', 'inspect_layout', 'view_image', 'dsl_reference'],
    maxTurns: 80,
  },
};

/** 按中文名称或英文标识找任务。 */
export function findAgentTask(value: string): AgentTask | undefined {
  return Object.values(AGENT_TASKS).find((task) => task.id === value || task.name === value);
}
