export { render, measureRender, preloadRenderer, type RenderResult, type RenderOptions, type RenderMeasure, type RenderEvidence } from './render.js';
export { compareReference, type VisualReport, type ReferenceImage, type ComparisonPanel } from './agent/visual-comparison.js';
/** 模板的对外信息：名称、基准、适用尺寸范围与对外参数；不出图（出图服务的模板列表）。 */
export { describeTemplate, type TemplateDescription } from './template/describe.js';
export {
  deliverBatch, readOutputRecord, replayOutputRecord, MAX_BATCH_ITEMS,
  freezeBatch, deliverBatchItem, runFrozenBatch, summarizeBatch, readRecord, replayRecord,
  type BatchSnapshot, type PinnedContents, type ReplayManifest,
  type BatchRenderRequest, type BatchDeliveryResult, type BatchItemResult, type BatchItemEntry, type BatchItemFiles, type BatchItemStatus,
  type BatchManifest, type BatchProgress, type BatchSummary, type PreviewManifest, type OutputRecord, type RecordedResource,
} from './output-records.js';
export { readBatch, readBatchFrom, type BatchReading, type FoundBatchItem } from './batch-read.js';
/** 渲染器构建标识：引擎文件、锁文件与实际安装的生产依赖的哈希；出图记录只由同一构建重放（ADR-0013）。 */
export { rendererBuildId } from './renderer-build.js';
export {
  createLocalBatchOutput, createMemoryBatch, localRecordSource, localBatchSource, itemDirectory,
  type BatchOutput, type BatchItemContents, type RecordSource, type BatchSource, type MemoryBatch,
} from './record-stores.js';
/** 完成清单与批次清单的字节写法（record.json、preview.json、batch.json），各存储实现写法一致。 */
export { jsonBytes as manifestBytes } from './record-files.js';
export { publishStaticSchema, compileStaticSchema, type PublishedStaticSchema } from './schema/publish.js';
export { checkDslDocument, dslDocumentKind, type DslDocumentCheck, type DslDocumentKind } from './dsl.js';
export { parseRenderRequest, type RenderRequest, type RenderMode, type OutputFormat } from './request.js';
export {
  loadWorkspace,
  readWorkspaceDocuments,
  localWorkspaceDocuments,
  memoryWorkspaceDocuments,
  classifyWorkspaceDocument,
  parseJsonKeepingPrecision,
  formatStaticSchemaRef,
  type WorkspaceDocumentClass,
  type WorkspaceDocumentSource,
  type WorkspaceDocumentEntry,
  type Workspace,
  type StaticSchemaRef,
  type StaticSchemaEntry,
  type TemplateEntry,
  type DatasetEntry,
  type DatasetDocument,
} from './workspace.js';
export {
  openResourceRepository,
  createMemoryResourceRepository,
  parseResourceRef,
  ResourceReadError,
  type ResourceRepository,
  type ResourceInfo,
  type ResourceKind,
} from './resources.js';
export {
  initializeResourceStore, importResources, openVersionedResourceStore,
  checkResourceReplacement, applyResourceReplacement, type ResourceReplacementCheck,
  localResourceBackend, createMemoryResourceBackend, resourceBackend, type ResourceVersionBackend, type ResourceChange,
  type ResourceManifestEntry, type ResourceManifestStorage,
  type VersionedResourceStore, type VersionedResourceInfo, type ResourceVersionMap, type PinnedResources,
} from './versioned-resources.js';
export { resourceImpact, type ResourceImpact, type ResourceConfigurationImpact, type ResourceWorkspaceImpact } from './resource-impact.js';
/** 校验一份数据集的原始字节，问题与渲染时对数据集的检查相同（出图服务保存数据集与表单实时提示）。 */
export { checkDataset, type DatasetCheck } from './dataset-validation.js';
export { ProblemCodes, type Problem, type ProblemCode, type ProblemLevel, type ProblemLocation } from './problems.js';
export { formatElementPath, type ElementPath, type ElementPathSegment } from './element-path.js';
export type { LayoutSummary, LayoutNode, TextSummary, QrCodeSummary, BarcodeSummary } from './layout/index.js';
export type { EncodedImage } from './draw.js';
export { readPngInfo, readJpegDpi } from './image-metadata.js';
export { mmToPx } from './units.js';
export {
  runAgentTask, workspaceFingerprint, AgentUsageError, DEFAULT_MODEL, DEFAULT_ENDPOINT, DEFAULT_KEY_ENV,
  type AgentRunOptions, type AgentRunResult, type RoundRecord, type RoundOutcome, type RoundInputs, type RoundUsage, type PreviousRef, type TemplateBasis,
} from './agent/run.js';
export {
  checkAgentOutcome, PENDING_REASONS,
  type OutcomeCheck, type CandidateCheck, type PendingItem, type PendingReason, type SubmittedOutcome, type FieldLocation,
} from './agent/outcome.js';
export {
  readReview, changeReview, applyAgentRound, readPreviousRound, readRoundChain, REVIEW_FILE, APPLIED_FILE, REVIEW_ACTIONS,
  type ReviewAction, type ReviewStatus, type ReviewDecision, type ReviewRecord, type ReviewChange, type ReviewView, type PendingView,
  type CandidateView, type FieldView, type EntryView, type ElementView, type ParameterView, type ItemState, type PreviewView,
  type CompiledSummary, type WorkspaceDrift, type NewerDefinition, type AppliedRecord,
  type AgentApplyOptions, type AgentApplyResult, type RoundLink, type RevisionView, type TemplateConflict, type PreviousRound,
} from './agent/review.js';
export { diffTemplate, revisionDiff, templateCallTree, type TemplateChange, type PropertyChange, type RevisionDiff } from './agent/diff.js';
export type { CheckpointView, CheckpointSignal, CandidateSelectionView, CandidateComparisonView, CandidateDifference, CheckpointCandidateView } from './agent/checkpoints.js';
export type { CandidateComparison, CandidateChange, ComparisonBasis } from './agent/candidate-comparison.js';
export {
  verifyElementStyles, hashCandidatesAndRequest, isVerificationValid, matchPath,
  type ApprovedRegion, type ReferenceBaseline, type StyleAnomaly, type StyleVerificationRecord, type BusinessState,
} from './agent/style-verification.js';
export {
  verifyExtractionCoverage, scoreExtractionCoverage, ROUTE_SIGN_BUSINESS_BASELINE,
  type ContentCoverageItem, type BusinessContentBaseline, type BusinessContentBaselineItem,
  type CoverageAnomaly, type CoverageAnomalyCode, type CoverageAssessment,
  type CoverageVerificationRecord, type ExtractionCoverageScore, type CoverageKind,
} from './agent/coverage-verification.js';
export { startReviewServer, type ReviewServer } from './agent/review-server.js';
export type { RoundExecution, RoundStart, ExecutionEvent, ExecutionPhase, ExecutionStatus } from './agent/execution.js';
export { AGENT_TASKS, findAgentTask, type AgentTask, type AgentTaskId, type CandidateKind } from './agent/tasks.js';

export {initializeOrderScope, recordOrderEvent, reportOrders, shareOrders, type OrderScope, type OrderDefinition, type OrderPlan} from './agent/orders.js';
