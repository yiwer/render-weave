export { render, type RenderResult } from './render.js';
export { parseRenderRequest, type RenderRequest, type RenderMode, type OutputFormat } from './request.js';
export {
  loadWorkspace,
  formatStaticSchemaRef,
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
  type ResourceRepository,
  type ResourceInfo,
  type ResourceKind,
} from './resources.js';
export { ProblemCodes, type Problem, type ProblemCode, type ProblemLevel, type ProblemLocation } from './problems.js';
export { formatElementPath, type ElementPath, type ElementPathSegment } from './element-path.js';
export type { LayoutSummary, LayoutNode, TextSummary } from './layout/index.js';
export type { EncodedImage } from './draw.js';
export { readPngInfo, readJpegDpi } from './image-metadata.js';
export { mmToPx } from './units.js';
