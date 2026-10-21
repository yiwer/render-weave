/**
 * Excel 导入（票据 13，M248、M283–M286）：客户上传一份 .xlsx，服务端解析，答导入预览——逐行的数据集与问题清单，
 * 以及只含没有严重问题的行的批量请求。预览不保存任何东西；客户确认后把其中的批量请求原样提交到 POST /v1/batches。
 * - 数据集内联在批量请求的各项里（每张图的出图记录自带数据），不另存为数据集；
 * - 每行按模板所用的静态数据定义由引擎的 checkDataset 校验，问题与保存数据集时相同，另带单元格；
 * - 出图参数与对外参数用引擎的 measureRender 按第一行能提交的数据检查一次，不合规时作为整份的严重问题，回答里没有批量请求；
 * - 文件、解压后的大小、单元格数、主表行数与引用展开的行数超出上限整份拒绝（413），读不了的文件答 400。
 * 租户由身份决定；别的租户的模板与不存在的同样答 400 input.templateNotFound（与批量交付相同）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { checkDataset, describeTemplate, measureRender, ProblemCodes, type Problem } from '../engine.js';
import { cellOf, ImportProblemCodes, importRows, sheetsToRead, type ImportProblem, type WorkbookCell } from '../excel-import.js';
import { loadTenantWorkspace } from '../preview.js';
import { readWorkbook, WorkbookError } from '../xlsx.js';
import { identityOf, ownTenant, type ApiContext } from './app.js';
import { ApiError, fail, ServiceProblemCodes } from './problems.js';

/** 预览里的一行：主表的行号、渲染项 ID、能不能进批次、读出的数据集与问题。 */
export interface ImportRow {
  readonly row: number;
  readonly itemId: string;
  readonly status: 'accepted' | 'rejected';
  readonly dataset: { readonly dataset: Record<string, unknown>; readonly data: unknown };
  readonly problems: readonly (ImportProblem | (Problem & { readonly cell: WorkbookCell }))[];
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const IMPORT_BODY = {
  type: 'object', additionalProperties: false, required: ['template', 'workbook', 'output'],
  properties: {
    template: { type: 'string', minLength: 1, maxLength: 200, description: '模板名称：按它所用的静态数据定义读取各行' },
    workbook: { type: 'string', minLength: 1, description: '.xlsx 文件内容的 base64' },
    parameters: { type: 'object', description: '对外参数，原样写进批量请求的每一项' },
    output: { type: 'object', description: '出图参数，原样写进批量请求的每一项' },
  },
} as const;

const severe = (problems: readonly { readonly level: string }[]) => problems.some((problem) => problem.level === 'severe');
/** 引擎的问题落在某个导入问题的字段之内：原因已由导入问题说明（如关联值找不到导致的必填缺失），不再重复。 */
const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`);
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MiB`;

export function registerExcelImportRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, limits } = context;
  const scopeOf = (request: FastifyRequest) => backend.tenant(ownTenant(identityOf(request)));
  // base64 比原文长三分之一；另留出模板名、对外参数与出图参数的余量。
  const bodyLimit = Math.ceil(limits.maxWorkbookBytes / 3) * 4 + 64 * 1024;

  app.post('/v1/excel-imports', { config: { access: 'deliver' }, bodyLimit, schema: { body: IMPORT_BODY } }, async (request) => {
    const body = request.body as { template: string; workbook: string; parameters?: Record<string, unknown>; output: Record<string, unknown> };
    if (body.workbook.length % 4 !== 0 || !BASE64.test(body.workbook)) {
      throw fail(400, ServiceProblemCodes.requestInvalid, 'request.workbook', 'workbook 要是 .xlsx 文件内容的 base64');
    }
    const bytes = new Uint8Array(Buffer.from(body.workbook, 'base64'));
    if (bytes.length > limits.maxWorkbookBytes) {
      throw fail(413, ServiceProblemCodes.limitWorkbookTooLarge, 'request.workbook', `文件有 ${mib(bytes.length)}，超出上限 ${mib(limits.maxWorkbookBytes)}；请分成几个文件`);
    }

    const workspace = await loadTenantWorkspace(scopeOf(request).storage);
    const template = workspace.templates.find((entry) => entry.name === body.template);
    if (!template) {
      throw new ApiError(400, [{ level: 'severe', code: ProblemCodes.templateNotFound, location: { kind: 'input', source: 'request.template' }, message: `模板 ${body.template} 不存在` }]);
    }
    const described = describeTemplate(template.document);
    if (!described.template) throw new ApiError(400, described.problems);
    const base = described.template.base;
    const schema = workspace.staticSchemas.find((entry) => entry.ref.name === base.name && entry.ref.version === base.version && entry.compiled);
    if (!schema?.compiled) {
      throw fail(400, ServiceProblemCodes.requestInvalid, 'request.template',
        `模板 ${body.template} 用的数据定义 ${base.name} v${base.version} 是引擎内置的或不在本租户，没有可以从 Excel 导入的字段`);
    }
    const staticSchema = schema.ref, compiled = schema.compiled;
    const displayName = (schema.definition as { displayName?: unknown } | undefined)?.displayName;
    const definition = { name: staticSchema.name, displayName: typeof displayName === 'string' ? displayName : staticSchema.name };

    let imported;
    try {
      const workbook = await readWorkbook(bytes, { maxUnzippedBytes: limits.maxWorkbookUnzippedBytes, maxCells: limits.maxWorkbookCells }, sheetsToRead(compiled, definition));
      imported = importRows(workbook, compiled, definition, { maxRows: limits.maxImportRows, maxReferenceRows: limits.maxImportReferenceRows });
    } catch (error) {
      if (!(error instanceof WorkbookError)) throw error;
      throw error.reason === 'tooLarge' ? fail(413, ServiceProblemCodes.limitWorkbookTooLarge, 'request.workbook', error.message)
        : fail(400, ServiceProblemCodes.importWorkbookUnreadable, 'request.workbook', error.message);
    }

    const rows: ImportRow[] = imported.rows.map((row) => {
      const dataset = { dataset: { staticSchema: { name: staticSchema.name, version: staticSchema.version }, origin: { kind: 'excel', sheet: imported.sheet, row: row.row } }, data: row.data };
      const covered = row.problems.flatMap((problem) => (problem.location.kind === 'field' ? [problem.location.path] : []));
      const checked = checkDataset(new Uint8Array(Buffer.from(JSON.stringify(dataset))), workspace).problems
        .filter((problem) => problem.location.kind !== 'field' || !covered.some((path) => within((problem.location as { path: string }).path, path)))
        .map((problem) => ({ ...problem, cell: cellOf(row, imported.sheet, problem.location.kind === 'field' ? problem.location.path : '') }));
      const problems = [...row.problems, ...checked];
      return { row: row.row, itemId: row.itemId, status: severe(problems) ? 'rejected' : 'accepted', dataset, problems };
    });

    const problems: (ImportProblem | Problem)[] = [...imported.problems];
    const accepted = rows.filter((row) => row.status === 'accepted');
    // 出图参数与对外参数对每一项都一样：按第一行能提交的数据检查一次，只取请求本身的问题——参数、出图参数，以及尺寸超出模板的适用范围；
    // 数据集与检查项的问题随数据而变，各行已经有了。
    if (accepted[0]) {
      const measured = measureRender(workspace, { template: body.template, mode: 'final', dataset: { inline: accepted[0].dataset },
        ...(body.parameters ? { parameters: body.parameters } : {}), output: body.output });
      problems.push(...measured.problems.filter((problem) => problem.level === 'severe' && (problem.location.kind === 'parameter'
        || problem.code === ProblemCodes.renderSizeOutOfRange
        || (problem.location.kind === 'input' && problem.location.source.startsWith('request.') && !problem.location.source.startsWith('request.dataset')))));
    }
    let batch: Record<string, unknown> | undefined;
    if (accepted.length && !severe(problems)) {
      batch = { template: body.template, mode: 'final', items: accepted.map((row) => ({
        id: row.itemId, dataset: { inline: row.dataset }, ...(body.parameters ? { parameters: body.parameters } : {}), output: body.output,
      })) };
      const size = Buffer.byteLength(JSON.stringify(batch));
      if (size > limits.maxBatchRequestBytes) {
        problems.push({ level: 'severe', code: ImportProblemCodes.batchTooLarge, location: { kind: 'input', source: 'workbook' },
          message: `能提交的 ${accepted.length} 行合起来有 ${mib(size)}，超出批量请求的上限 ${mib(limits.maxBatchRequestBytes)}；请分成几个文件` });
        batch = undefined;
      }
    }
    return {
      template: body.template, staticSchema: { name: staticSchema.name, version: staticSchema.version }, sheet: imported.sheet,
      summary: { rows: rows.length, accepted: accepted.length, rejected: rows.length - accepted.length },
      rows, problems, ...(batch ? { batch } : {}),
    };
  });
}
