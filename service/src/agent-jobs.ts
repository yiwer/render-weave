/** Agent 任务的持久化合同。任务进度与候选独立于正式工作区，只有应用事务写数据集。 */
import type { StaticSchemaRef } from './engine.js';
import type { Actor, AuthoringState, NewAuditEvent, StoredDocument, RoundUsageEntry } from './backend.js';

export interface AgentArtifact { readonly file: string; readonly sha256: string; readonly byteLength: number }
export interface AgentJob {
  readonly id: string;
  readonly revision: number;
  readonly kind: 'dataset-extraction';
  readonly status: 'queued' | 'running' | 'needsReview' | 'applied' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly actor: Actor;
  readonly staticSchema: StaticSchemaRef;
  readonly filename: string;
  readonly source: AgentArtifact;
  readonly brief: string;
  /** 入队时固定的工作区文档，不从浏览器接收。 */
  readonly workspace: readonly StoredDocument[];
  readonly events: readonly { readonly sequence: number; readonly at: string; readonly message: string }[];
  readonly lease?: { readonly token: string; readonly until: string };
  readonly artifacts?: readonly AgentArtifact[];
  readonly diagnostics?: readonly AgentArtifact[];
  readonly datasetIds?: readonly string[];
  readonly message?: string;
  readonly usage?: RoundUsageEntry;
}

export interface AgentCommit {
  readonly datasets?: readonly { readonly id: string; readonly bytes: Uint8Array }[];
  /** 应用前在同一把租户锁下重核工作区，避免检查后数据或资源被并发改写。 */
  readonly basis?: string;
  readonly audit?: NewAuditEvent;
  readonly usage?: RoundUsageEntry;
}
export interface AgentJobStore {
  list(): Promise<readonly AgentJob[]>;
  get(id: string): Promise<AgentJob | undefined>;
  /** expectedRevision=0 表示创建；版本、工作区或任一数据集 ID 冲突时整组拒绝。 */
  save(job: AgentJob, expectedRevision: number, commit?: AgentCommit): Promise<void>;
}
export class AgentJobConflict extends Error {}
export function authoringBasis(state: AuthoringState): string {
  return JSON.stringify({
    documents: [...state.documents].map(d => [d.kind, d.key, d.sha256]).sort(),
    resources: [...state.resources].map(r => [r.id, r.currentVersion, r.versions.map(v => [v.version, v.sha256])]).sort(),
  });
}
export function advanceJob(job: AgentJob, change: Partial<AgentJob>, message: string, now = new Date()): AgentJob {
  return { ...job, ...change, revision: job.revision + 1, updatedAt: now.toISOString(),
    events: [...job.events, { sequence: (job.events.at(-1)?.sequence ?? 0) + 1, at: now.toISOString(), message }].slice(-200) };
}
