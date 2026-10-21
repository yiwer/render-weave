/**
 * 静态数据定义的只读端点（票据 12，M278）：出图控制台按编译产物生成表单（M248），开放 API 的客户读到的是同一份。
 * 静态数据定义与编译产物由代建推送（M264），这里只读；引擎内置的空数据定义与单值数据定义不列，没有编译产物的也不列（表单要按它生成）。
 * 租户由身份决定；别的租户的与不存在的同样答 404。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { StoredDocument, TenantStorage } from '../backend.js';
import { parseJsonKeepingPrecision } from '../engine.js';
import { blankSheets } from '../excel-import.js';
import { writeBlankWorkbook } from '../xlsx.js';
import { identityOf, ownTenant, type ApiContext } from './app.js';
import { notFound } from './problems.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 列表里的一项：身份与说明，取自静态数据定义的原文。 */
export interface StaticSchemaSummary {
  readonly name: string;
  readonly version: number;
  readonly displayName: string;
  readonly description?: string;
}

const VERSION = /^[1-9][0-9]{0,8}$/;

/** 键是"名称@版本"；名称里也可以有 @，按最后一个分开。 */
function parseKey(key: string): { name: string; version: number } | undefined {
  const at = key.lastIndexOf('@'), version = key.slice(at + 1);
  return at > 0 && VERSION.test(version) ? { name: key.slice(0, at), version: Number(version) } : undefined;
}

async function readJson(storage: TenantStorage, stored: StoredDocument): Promise<Record<string, unknown> | undefined> {
  const bytes = await storage.contents.get(stored.sha256);
  if (!bytes) return undefined;
  try {
    const value = parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), []);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function summaryOf(name: string, version: number, definition: Record<string, unknown> | undefined): StaticSchemaSummary {
  const displayName = definition?.['displayName'], description = definition?.['description'];
  return { name, version, displayName: typeof displayName === 'string' ? displayName : name, ...(typeof description === 'string' ? { description } : {}) };
}

export function registerStaticSchemaRoutes(app: FastifyInstance, context: ApiContext): void {
  const storageOf = (request: FastifyRequest) => context.backend.tenant(ownTenant(identityOf(request))).storage;

  app.get('/v1/static-schemas', { config: { access: 'tenant.read' } }, async (request) => {
    const storage = storageOf(request), documents = (await storage.authoringState()).documents;
    const compiled = new Set(documents.filter((stored) => stored.kind === 'compiled').map((stored) => stored.key));
    const definitions = documents.flatMap((stored) => {
      const key = stored.kind === 'definition' && compiled.has(stored.key) ? parseKey(stored.key) : undefined;
      return key ? [{ ...key, stored }] : [];
    }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version));
    return { staticSchemas: await Promise.all(definitions.map(async ({ name, version, stored }) => summaryOf(name, version, await readJson(storage, stored)))) };
  });

  /** 路径里的静态数据定义：原文与编译产物都在才算有。 */
  const staticSchemaOf = async (request: FastifyRequest) => {
    const params = request.params as { name: string; version: string };
    if (!VERSION.test(params.version)) throw notFound();
    const storage = storageOf(request), key = `${params.name}@${params.version}`;
    const documents = (await storage.authoringState()).documents;
    const definition = documents.find((stored) => stored.kind === 'definition' && stored.key === key);
    const compiled = documents.find((stored) => stored.kind === 'compiled' && stored.key === key);
    const [definitionJson, compiledJson] = await Promise.all([definition && readJson(storage, definition), compiled && readJson(storage, compiled)]);
    if (!definitionJson || !compiledJson) throw notFound();
    return { summary: summaryOf(params.name, Number(params.version), definitionJson), definition: definitionJson, compiled: compiledJson };
  };

  /** 一个静态数据定义：原文与编译产物。控制台按编译产物生成表单，字段用它的 title（显示名称）。 */
  app.get('/v1/static-schemas/:name/versions/:version', { config: { access: 'tenant.read' } }, async (request) => {
    const { summary, definition, compiled } = await staticSchemaOf(request);
    return { ...summary, definition, compiled };
  });

  /** Excel 导入的空白表（票据 13）：按编译产物生成，主表一行表头，引用与引用列表各一张表。 */
  app.get('/v1/static-schemas/:name/versions/:version/workbook', { config: { access: 'tenant.read' } }, async (request, reply) => {
    const { summary, compiled } = await staticSchemaOf(request);
    const bytes = await writeBlankWorkbook(blankSheets(compiled, summary.displayName));
    // 文件名带中文：filename* 按 RFC 6266 与 RFC 5987 编码，filename 给只认 ASCII 的客户端。
    const file = `${summary.name.replace(/[\\/:*?"<>|]/g, '_')}-v${summary.version}.xlsx`;
    const encoded = encodeURIComponent(file).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.type(XLSX_TYPE).header('content-disposition', `attachment; filename="workbook.xlsx"; filename*=UTF-8''${encoded}`).send(Buffer.from(bytes));
  });
}
