/**
 * Excel 导入的写法（票据 13，M248、M285）：按静态数据定义的编译产物，把工作簿换成逐行的数据集，记下每个字段来自哪个单元格；
 * 空白表的列按同一份字段说明生成。
 * - 主表一行一个渲染项；首个非空行是表头，写显示名称或字段名称（不计空白与大小写）；可选的"渲染项 ID"列，不写时用"第 N 行"；
 * - 简单类型的列表写在一格里，用换行、顿号、逗号或分号分开；
 * - 引用与引用列表另起一张以字段显示名称命名的工作表：主表这一列写关联值，那张表里同名的列写同一个值，几行按顺序组成列表，
 *   主表的几行可以共用一个关联值；引用只能对应一行；第二层引用不能从 Excel 导入；
 * - 单元格按目标字段的类型转换，转换不了的原样交给引擎校验，问题与保存数据集时相同。
 */
import { columnName, WorkbookError, type BlankColumn, type BlankSheet, type CellValue, type Sheet, type SheetRow, type Workbook } from './xlsx.js';

/** 主表里可选的渲染项 ID 列。 */
export const ID_HEADER = '渲染项 ID';

/** 导入预览里的问题码（随 200 的预览返回，不是错误回答）。 */
export const ImportProblemCodes = {
  /** 主表没有数据行。 */
  noRows: 'import.noRows',
  /** 表头不对应任何字段，这一列忽略（提示）。 */
  columnUnknown: 'import.columnUnknown',
  /** 两列对应同一个字段：不知道用哪一列，整份不能提交。 */
  columnDuplicate: 'import.columnDuplicate',
  /** 必填字段没有对应的列（提示；各行另有必填缺失的问题）。 */
  columnMissing: 'import.columnMissing',
  /** 字段是第二层引用，不能从 Excel 导入，这一列忽略（提示）。 */
  fieldUnsupported: 'import.fieldUnsupported',
  /** 单元格是 Excel 的错误值，如 #N/A。 */
  cellError: 'import.cellError',
  /** 渲染项 ID 与前面的行重复。 */
  itemIdDuplicate: 'import.itemIdDuplicate',
  /** 关联值在引用的工作表里找不到，或没有那张工作表。 */
  referenceNotFound: 'import.referenceNotFound',
  /** 单个引用的关联值对应了不止一行。 */
  referenceTooManyRows: 'import.referenceTooManyRows',
  /** 引用的工作表里有没被主表引用的行，已忽略（提示）。 */
  rowOrphan: 'import.rowOrphan',
  /** 能提交的行合起来超过批量请求的字节上限，整份不能提交。 */
  batchTooLarge: 'import.batchTooLarge',
} as const;
export type ImportProblemCode = (typeof ImportProblemCodes)[keyof typeof ImportProblemCodes];

/** 工作簿里的位置：工作表、行号，以及列号与表头（整行的问题没有列）。 */
export interface WorkbookCell {
  readonly sheet: string;
  readonly row: number;
  readonly column?: string;
  readonly header?: string;
}

/** 导入的问题：与引擎的问题同一格式，另带单元格。关于某个字段的定位到字段路径，其余是 input: workbook。 */
export interface ImportProblem {
  readonly level: 'severe' | 'hint';
  readonly code: string;
  readonly location: { readonly kind: 'field'; readonly path: string } | { readonly kind: 'input'; readonly source: string };
  readonly message: string;
  readonly cell?: WorkbookCell;
}

export interface ImportedRow {
  /** 主表的行号。 */
  readonly row: number;
  readonly itemId: string;
  readonly data: Record<string, unknown>;
  /** 字段路径（与引擎的字段路径相同，列表序号从 1 起）到单元格。 */
  readonly cells: ReadonlyMap<string, WorkbookCell>;
  readonly problems: readonly ImportProblem[];
}

export interface ImportedWorkbook {
  /** 主表的名称。 */
  readonly sheet: string;
  readonly rows: readonly ImportedRow[];
  /** 整份的问题：表头、没人引用的行等。 */
  readonly problems: readonly ImportProblem[];
}

type Scalar = 'text' | 'number' | 'integer' | 'boolean' | 'date' | 'time' | 'datetime' | 'image';

/** 编译产物里的一个字段；引用与引用列表带元素的字段（只到一层）。 */
interface Field {
  readonly name: string;
  readonly title: string;
  readonly required: boolean;
  readonly kind: Scalar | 'list' | 'ref' | 'refList' | 'unsupported';
  /** 列表元素的类型。 */
  readonly item?: Scalar;
  readonly choices?: readonly unknown[];
  readonly fields?: readonly Field[];
  readonly schema: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function scalarOf(schema: Record<string, unknown>): Scalar | undefined {
  const special = schema['x-renderweave-type'];
  if (special === 'date' || special === 'time' || special === 'datetime' || special === 'image') return special;
  switch (schema['type']) {
    case 'string': return 'text';
    case 'number': return 'number';
    case 'integer': return 'integer';
    case 'boolean': return 'boolean';
    default: return undefined;
  }
}

function fieldsOf(schema: Record<string, unknown>, nested: boolean): Field[] {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  return Object.entries(properties).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])).map(([name, property]) => {
    const base = { name, title: typeof property['title'] === 'string' ? property['title'] : name, required: required.includes(name), schema: property };
    const scalar = scalarOf(property);
    if (scalar) return { ...base, kind: scalar, ...(Array.isArray(property['enum']) ? { choices: property['enum'] } : {}) };
    const items = property['items'];
    if (property['type'] === 'array' && isRecord(items)) {
      const item = scalarOf(items);
      if (item) return { ...base, kind: 'list', item, ...(Array.isArray(items['enum']) ? { choices: items['enum'] } : {}) };
      if (items['type'] === 'object' && !nested) return { ...base, kind: 'refList', fields: fieldsOf(items, true) };
    }
    if (property['type'] === 'object' && !nested) return { ...base, kind: 'ref', fields: fieldsOf(property, true) };
    return { ...base, kind: 'unsupported' };
  });
}

const isReference = (field: Field) => field.kind === 'ref' || field.kind === 'refList';
/** 表头与工作表名的比较：不计空白（含全角空格）与大小写。 */
const squash = (text: string) => text.replace(/[\s　]+/g, '').toLowerCase();

/** Excel 的工作表名：不能有 []:*?/\，至多 31 个字符。 */
export function sheetName(text: string): string {
  const name = text.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').trim().slice(0, 31);
  return name || 'Sheet';
}

// —— 单元格的值 ——

const isBlank = (cell: CellValue | undefined): cell is undefined => cell === undefined || (cell.kind === 'text' && !cell.text.trim());
/** 数值按 15 位有效数字取（与 Excel 显示的精度相同），去掉 0.1 + 0.2 这类二进制尾差（M112）。 */
const round15 = (value: number) => Number(value.toPrecision(15));

/** 单元格的文字写法：文字去掉首尾空白，数值按 15 位有效数字，是否写成 true / false。 */
function textOf(cell: CellValue): string {
  switch (cell.kind) {
    case 'text': return cell.text.trim();
    case 'number': return String(round15(cell.value));
    case 'boolean': return String(cell.value);
    case 'error': return cell.text;
  }
}

const pad = (value: number | string) => String(value).padStart(2, '0');
const DAY_MS = 86_400_000;

/** Excel 日期序号：1900 日期系统把 1900-02-29（序号 60）当作存在，61 起从 1899-12-30 起算；1904 日期系统从 1904-01-01 起算。 */
function fromSerial(serial: number, date1904: boolean): { date: string; hours: number; minutes: number; seconds: number } | undefined {
  if (!(serial >= 0) || serial >= 2_958_466) return undefined;
  let days = Math.floor(serial), seconds = Math.round((serial - days) * 86_400);
  if (seconds === 86_400) { days += 1; seconds = 0; }
  if (!date1904 && days === 60) return undefined;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const day = new Date(epoch + days * DAY_MS);
  return { date: `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`,
    hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds / 60) % 60, seconds: seconds % 60 };
}

const DATE_TEXT = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/;
const TIME_TEXT = /^(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?$/;
const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TRUE_TEXT = new Set(['是', 'true', '1', 'y', 'yes', '√']), FALSE_TEXT = new Set(['否', 'false', '0', 'n', 'no', '×']);

const dateText = (text: string) => {
  const match = DATE_TEXT.exec(text);
  return match ? `${match[1]}-${pad(match[2]!)}-${pad(match[3]!)}` : undefined;
};
const timeText = (text: string, seconds: boolean) => {
  const match = TIME_TEXT.exec(text);
  if (!match) return undefined;
  return `${pad(match[1]!)}:${match[2]}${match[3] !== undefined ? `:${match[3]}` : seconds ? ':00' : ''}`;
};

/** 按字段类型转换一个单元格；转换不了的原样返回，由引擎报类型或格式问题。 */
function convert(kind: Scalar, cell: CellValue, date1904: boolean): unknown {
  const text = textOf(cell);
  switch (kind) {
    case 'text': return text;
    case 'number': case 'integer':
      if (cell.kind === 'number') return round15(cell.value);
      return NUMBER_TEXT.test(text) && Number.isFinite(Number(text)) ? round15(Number(text)) : text;
    case 'boolean':
      if (cell.kind === 'boolean') return cell.value;
      if (TRUE_TEXT.has(text.toLowerCase())) return true;
      if (FALSE_TEXT.has(text.toLowerCase())) return false;
      return cell.kind === 'number' ? cell.value : text;
    case 'date': case 'time': case 'datetime': {
      if (cell.kind === 'number') {
        const at = fromSerial(cell.value, date1904);
        if (!at) return cell.value;
        const clock = `${pad(at.hours)}:${pad(at.minutes)}`;
        if (kind === 'date') return at.date;
        if (kind === 'time') return at.seconds ? `${clock}:${pad(at.seconds)}` : clock;
        return `${at.date} ${clock}:${pad(at.seconds)}`;
      }
      if (kind === 'date') return dateText(text) ?? text;
      if (kind === 'time') return timeText(text, false) ?? text;
      const split = /^(.+?)(?:\s+|T)(\d{1,2}\s*[:：].*)$/.exec(text);
      const date = split && dateText(split[1]!), time = split && timeText(split[2]!, true);
      return date && time ? `${date} ${time}` : text;
    }
    case 'image':
      return /^res:/.test(text) || /^https?:\/\//i.test(text) || !RESOURCE_ID.test(text) ? text : `res:${text}`;
  }
}

const SEPARATORS = /[\n\r、，,；;]+/;

// —— 表头与列 ——

interface Columns {
  readonly sheet: Sheet;
  readonly header: SheetRow | undefined;
  /** 表头在 sheet.rows 里的位置；数据行从它的下一行起。 */
  readonly start: number;
  readonly headers: ReadonlyMap<number, string>;
  /** 字段名到列序号。 */
  readonly fields: ReadonlyMap<string, number>;
  readonly id?: number;
  /** 引用工作表里关联值所在的列。 */
  readonly key?: number;
}

const cellAt = (columns: Columns, row: number, column?: number): WorkbookCell => (column === undefined ? { sheet: columns.sheet.name, row }
  : { sheet: columns.sheet.name, row, column: columnName(column), ...(columns.headers.has(column) ? { header: columns.headers.get(column)! } : {}) });

const importProblem = (level: ImportProblem['level'], code: ImportProblemCode, message: string, cell?: WorkbookCell, path?: string): ImportProblem =>
  ({ level, code, location: path === undefined ? { kind: 'input', source: 'workbook' } : { kind: 'field', path }, message, ...(cell ? { cell } : {}) });

/** 表头最多往下找几行：表格上方常有一两行标题。 */
const HEADER_SEARCH_ROWS = 5;

/**
 * 读表头：每一列对应渲染项 ID、某个字段、关联值，或者不认识。
 * 表头是前几行里第一个有认得出的列的行（上方的标题行忽略）；都认不出时取第一行，各列提示不认识。
 */
function readColumns(sheet: Sheet, fields: readonly Field[], options: { readonly id: boolean; readonly key?: Field }, problems: ImportProblem[]): Columns {
  const headers = new Map<number, string>(), byField = new Map<string, number>();
  let id: number | undefined, key: number | undefined;
  const byTitle = new Map<string, Field>(), byName = new Map<string, Field>();
  for (const field of fields) {
    if (!byTitle.has(squash(field.title))) byTitle.set(squash(field.title), field);
    byName.set(squash(field.name), field);
  }
  const known = (cell: CellValue) => {
    const squashed = squash(textOf(cell));
    return byTitle.has(squashed) || byName.has(squashed) || (options.id && squashed === squash(ID_HEADER))
      || (options.key !== undefined && (squashed === squash(options.key.title) || squashed === squash(options.key.name)));
  };
  const found = sheet.rows.slice(0, HEADER_SEARCH_ROWS).findIndex((row) => [...row.cells.values()].some(known));
  const start = Math.max(found, 0), header = sheet.rows[start];
  const partial: Columns = { sheet, header, start, headers, fields: byField };
  for (const [index, cell] of [...(header?.cells ?? [])].sort(([a], [b]) => a - b)) {
    const text = textOf(cell);
    if (!text) continue;
    headers.set(index, text);
    const at = cellAt(partial, header!.number, index);
    const squashed = squash(text);
    if (options.key && (squashed === squash(options.key.title) || squashed === squash(options.key.name))) {
      if (key === undefined) key = index;
      else problems.push(importProblem('severe', ImportProblemCodes.columnDuplicate, `工作表"${sheet.name}"有两列关联值"${text}"，不知道用哪一列`, at));
      continue;
    }
    if (options.id && squashed === squash(ID_HEADER)) {
      if (id === undefined) id = index;
      else problems.push(importProblem('severe', ImportProblemCodes.columnDuplicate, `工作表"${sheet.name}"有两列"${ID_HEADER}"，不知道用哪一列`, at));
      continue;
    }
    const field = byTitle.get(squashed) ?? byName.get(squashed);
    if (!field) {
      problems.push(importProblem('hint', ImportProblemCodes.columnUnknown, `工作表"${sheet.name}"的列"${text}"不对应任何字段，已忽略`, at));
    } else if (field.kind === 'unsupported') {
      problems.push(importProblem('hint', ImportProblemCodes.fieldUnsupported, `字段"${field.title}"是第二层引用，不能从 Excel 导入，这一列已忽略`, at));
    } else if (byField.has(field.name)) {
      problems.push(importProblem('severe', ImportProblemCodes.columnDuplicate, `工作表"${sheet.name}"有两列对应字段"${field.title}"，不知道用哪一列`, at));
    } else byField.set(field.name, index);
  }
  for (const field of fields) {
    if (field.required && field.kind !== 'unsupported' && !byField.has(field.name)) {
      problems.push(importProblem('hint', ImportProblemCodes.columnMissing, `工作表"${sheet.name}"没有必填字段"${field.title}"的列，各行都会缺这个字段`, header ? { sheet: sheet.name, row: header.number } : undefined));
    }
  }
  return { ...partial, ...(id === undefined ? {} : { id }), ...(key === undefined ? {} : { key }) };
}

/** 表头以下、在认得的列里有内容的行。 */
function dataRows(columns: Columns): SheetRow[] {
  const used = new Set<number>([...columns.fields.values(), ...(columns.id === undefined ? [] : [columns.id]), ...(columns.key === undefined ? [] : [columns.key])]);
  return columns.sheet.rows.slice(columns.start + 1).filter((row) => [...used].some((column) => !isBlank(row.cells.get(column))));
}

/** 引用的工作表：表头与按关联值分组的行（保持表里的先后）。 */
interface ReferenceSheet {
  readonly columns: Columns;
  readonly groups: ReadonlyMap<string, readonly SheetRow[]>;
}

/** 填一个对象的各字段（主表的一行，或引用表的一行）；cells 记下字段路径对应的单元格。 */
function fillObject(row: SheetRow, columns: Columns, fields: readonly Field[], prefix: string, context: {
  readonly date1904: boolean;
  readonly cells: Map<string, WorkbookCell>;
  readonly problems: ImportProblem[];
  readonly reference?: (field: Field, key: string, at: WorkbookCell, path: string) => unknown;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const column = columns.fields.get(field.name);
    if (column === undefined) continue;
    const path = `${prefix}${field.name}`, at = cellAt(columns, row.number, column), cell = row.cells.get(column);
    context.cells.set(path, at);
    if (isBlank(cell)) continue;
    if (cell.kind === 'error') {
      context.problems.push(importProblem('severe', ImportProblemCodes.cellError, `单元格是 Excel 的错误值 ${cell.text}，字段"${field.title}"按没填处理`, at, path));
      continue;
    }
    if (field.kind === 'list') {
      const items = cell.kind === 'text' ? cell.text.split(SEPARATORS).map((part) => part.trim()).filter(Boolean).map((part) => ({ kind: 'text' as const, text: part })) : [cell];
      data[field.name] = items.map((item) => convert(field.item!, item, context.date1904));
    } else if (isReference(field)) {
      const value = context.reference?.(field, textOf(cell), at, path);
      if (value !== undefined) data[field.name] = value;
    } else {
      data[field.name] = convert(field.kind as Scalar, cell, context.date1904);
    }
  }
  return data;
}

/** 数据定义的显示名称与名称：认主表、给空白表的主表命名。 */
export interface DefinitionNames { readonly name: string; readonly displayName: string }

/** 空白表的工作表名：主表用显示名称，引用与引用列表各用字段的显示名称；重名的加序号。 */
function blankNames(fields: readonly Field[], displayName: string): { readonly main: string; readonly references: ReadonlyMap<string, string> } {
  const main = sheetName(displayName), taken = new Set([squash(main)]), references = new Map<string, string>();
  for (const field of fields.filter(isReference)) {
    let name = sheetName(field.title);
    for (let n = 2; taken.has(squash(name)); n++) name = sheetName(`${field.title.slice(0, 26)} (${n})`);
    taken.add(squash(name));
    references.set(field.name, name);
  }
  return { main, references };
}

/**
 * 工作簿里哪张是主表、各引用字段对应哪张表。名称等于数据定义的显示名称或名称的是主表，否则取第一张不是引用表的；
 * 引用表按空白表给的名称、字段的显示名称或名称认，不计空白与大小写。
 */
function planSheets(names: readonly string[], fields: readonly Field[], definition: DefinitionNames): { readonly main: string; readonly references: ReadonlyMap<string, string> } {
  const blank = blankNames(fields, definition.displayName), byName = new Map<string, Field>();
  for (const field of fields.filter(isReference)) {
    for (const name of [blank.references.get(field.name)!, sheetName(field.title), field.title, field.name]) if (!byName.has(squash(name))) byName.set(squash(name), field);
  }
  const own = new Set([blank.main, definition.displayName, definition.name].map(squash));
  const main = names.find((name) => own.has(squash(name))) ?? names.find((name) => !byName.has(squash(name))) ?? names[0]!;
  const references = new Map<string, string>();
  for (const name of names) {
    const field = name === main ? undefined : byName.get(squash(name));
    if (field && !references.has(field.name)) references.set(field.name, name);
  }
  return { main, references };
}

/** 读工作簿时只需解开的工作表：主表与各引用表（交给 readWorkbook 的 choose）。 */
export function sheetsToRead(compiled: Record<string, unknown>, definition: DefinitionNames): (names: readonly string[]) => ReadonlySet<string> {
  const fields = fieldsOf(compiled, false);
  return (names) => {
    const plan = planSheets(names, fields, definition);
    return new Set([plan.main, ...plan.references.values()]);
  };
}

/**
 * 把工作簿换成逐行的数据：主表一行一项。整份拒绝（抛 WorkbookError tooLarge）的情形：主表的数据行超过 maxRows；
 * 各行引用展开的行数合计超过 maxReferenceRows——主表的几行共用一大组关联值时，展开会成倍放大。
 */
export function importRows(workbook: Workbook, compiled: Record<string, unknown>, definition: DefinitionNames,
  limits: { readonly maxRows: number; readonly maxReferenceRows: number }): ImportedWorkbook {
  const fields = fieldsOf(compiled, false), references = fields.filter(isReference), problems: ImportProblem[] = [];
  const plan = planSheets(workbook.names, fields, definition);
  const sheetNamed = (name: string | undefined) => workbook.sheets.find((sheet) => sheet.name === name);
  const main = sheetNamed(plan.main);
  if (!main) throw new WorkbookError('unreadable', `主表"${plan.main}"没有读出来`);
  const columns = readColumns(main, fields, { id: true }, problems);
  const rows = dataRows(columns);
  if (rows.length > limits.maxRows) {
    throw new WorkbookError('tooLarge', `主表"${main.name}"有 ${rows.length.toLocaleString('zh-CN')} 行数据，一次最多导入 ${limits.maxRows.toLocaleString('zh-CN')} 行；请分成几个文件`);
  }
  let expanded = 0;

  // 引用的工作表：按需读一次；记下用过的关联值，最后提示没人引用的行。
  const sheets = new Map<string, ReferenceSheet | null>(), used = new Map<string, Set<string>>();
  const referenceSheet = (field: Field): ReferenceSheet | null => {
    if (sheets.has(field.name)) return sheets.get(field.name)!;
    const sheet = sheetNamed(plan.references.get(field.name));
    let found: ReferenceSheet | null = null;
    if (sheet) {
      const sub = readColumns(sheet, field.fields!, { id: false, key: field }, problems);
      const groups = new Map<string, SheetRow[]>();
      // 缺关联值的列只提示：没有行引用它时不妨碍提交；引用了它的行各自报找不到。
      if (sub.key === undefined) {
        problems.push(importProblem('hint', ImportProblemCodes.columnMissing, `工作表"${sheet.name}"没有关联值的列"${field.title}"，对不上主表的行`, sub.header ? { sheet: sheet.name, row: sub.header.number } : undefined));
      } else {
        for (const row of dataRows(sub)) {
          const cell = row.cells.get(sub.key), key = isBlank(cell) ? '' : textOf(cell);
          const group = groups.get(key);
          if (group) group.push(row); else groups.set(key, [row]);
        }
      }
      found = { columns: sub, groups };
    }
    sheets.set(field.name, found);
    used.set(field.name, new Set());
    return found;
  };

  const ids = new Set<string>(), imported: ImportedRow[] = [];
  for (const row of rows) {
    const cells = new Map<string, WorkbookCell>(), rowProblems: ImportProblem[] = [];
    const plain = { date1904: workbook.date1904, cells, problems: rowProblems };
    const context = {
      ...plain,
      reference: (field: Field, key: string, at: WorkbookCell, path: string): unknown => {
        const sheet = referenceSheet(field);
        const group = sheet?.groups.get(key);
        if (!sheet || !group) {
          rowProblems.push(importProblem('severe', ImportProblemCodes.referenceNotFound, !sheet
            ? `没有名为"${sheetName(field.title)}"的工作表，字段"${field.title}"的关联值"${key}"对不上`
            : sheet.columns.key === undefined ? `工作表"${sheet.columns.sheet.name}"没有关联值的列"${field.title}"，关联值"${key}"对不上`
            : `关联值"${key}"在工作表"${sheet.columns.sheet.name}"里没有对应的行`, at, path));
          return undefined;
        }
        used.get(field.name)!.add(key);
        expanded += group.length;
        if (expanded > limits.maxReferenceRows) {
          throw new WorkbookError('tooLarge', `各行引用展开后超过 ${limits.maxReferenceRows.toLocaleString('zh-CN')} 行（几行共用一个关联值时按行重复计）；请分成几个文件`);
        }
        if (field.kind === 'ref') {
          if (group.length > 1) {
            rowProblems.push(importProblem('severe', ImportProblemCodes.referenceTooManyRows,
              `字段"${field.title}"只能对应一行，关联值"${key}"在工作表"${sheet.columns.sheet.name}"里有 ${group.length} 行`, at, path));
            return undefined;
          }
          return fillObject(group[0]!, sheet.columns, field.fields!, `${path}.`, plain);
        }
        return group.map((sub, i) => {
          cells.set(`${path}[${i + 1}]`, cellAt(sheet.columns, sub.number));
          return fillObject(sub, sheet.columns, field.fields!, `${path}[${i + 1}].`, plain);
        });
      },
    };
    const data = fillObject(row, columns, fields, '', context);
    const idCell = columns.id === undefined ? undefined : row.cells.get(columns.id);
    const idAt = cellAt(columns, row.number, columns.id);
    let itemId = `第 ${row.number} 行`;
    if (idCell?.kind === 'error') rowProblems.push(importProblem('severe', ImportProblemCodes.cellError, `渲染项 ID 是 Excel 的错误值 ${idCell.text}`, idAt));
    else if (!isBlank(idCell)) itemId = textOf(idCell);
    if (ids.has(itemId)) rowProblems.push(importProblem('severe', ImportProblemCodes.itemIdDuplicate, `渲染项 ID"${itemId}"与前面的行重复`, idAt));
    ids.add(itemId);
    imported.push({ row: row.number, itemId, data, cells, problems: rowProblems });
  }

  for (const field of references) {
    // 没有一行引用到的表也读一遍：里面的行要提示没人引用，不能悄悄丢掉。
    const sheet = referenceSheet(field);
    if (!sheet) continue;
    for (const [key, group] of sheet.groups) {
      if (used.get(field.name)!.has(key)) continue;
      problems.push(importProblem('hint', ImportProblemCodes.rowOrphan, key
        ? `工作表"${sheet.columns.sheet.name}"里关联值"${key}"的 ${group.length} 行没有主表的行引用，已忽略`
        : `工作表"${sheet.columns.sheet.name}"里有 ${group.length} 行没写关联值，已忽略`, { sheet: sheet.columns.sheet.name, row: group[0]!.number }));
    }
  }
  if (!imported.length) problems.push(importProblem('severe', ImportProblemCodes.noRows, `主表"${main.name}"在表头下面没有数据行`, { sheet: main.name, row: columns.header?.number ?? 1 }));
  return { sheet: main.name, rows: imported, problems };
}

/** 字段路径对应的单元格：找不到就往上找（stops[3].name → stops[3] → stops），都没有就是整行。 */
export function cellOf(row: ImportedRow, sheet: string, path: string): WorkbookCell {
  for (let current = path; current;) {
    const cell = row.cells.get(current);
    if (cell) return cell;
    current = current.endsWith(']') ? current.slice(0, current.lastIndexOf('[')) : current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : '';
  }
  return { sheet, row: row.row };
}

// —— 空白表 ——

/** 显示宽度：中文算两个字符。 */
const displayWidth = (text: string) => [...text].reduce((width, char) => width + (char.charCodeAt(0) > 0xff ? 2 : 1), 0);
const widthOf = (header: string) => Math.min(Math.max(displayWidth(header) + 4, 10), 40);

function rangeText(schema: Record<string, unknown>): string {
  const min = schema['minimum'], max = schema['maximum'];
  if (typeof min === 'number' && typeof max === 'number') return `，${min}–${max}`;
  if (typeof min === 'number') return `，不小于 ${min}`;
  if (typeof max === 'number') return `，不大于 ${max}`;
  return '';
}

function kindText(kind: Scalar, schema: Record<string, unknown>, choices?: readonly unknown[]): string {
  const options = choices ? `，可选：${choices.join('、')}` : '';
  switch (kind) {
    case 'text': {
      const max = schema['maxLength'], pattern = schema['pattern'];
      return `文本${options}${typeof max === 'number' ? `，至多 ${max} 字` : ''}${typeof pattern === 'string' ? `，格式 ${pattern}` : ''}`;
    }
    case 'number': return `数值${rangeText(schema)}${options}`;
    case 'integer': return `整数${rangeText(schema)}${options}`;
    case 'boolean': return '是 或 否';
    case 'date': return '日期，如 2026-11-20';
    case 'time': return '时刻，如 08:30，可带秒';
    case 'datetime': return '日期时间，如 2026-11-20 08:30';
    case 'image': return '图片资源 ID，如 logo（也可写 res:logo）';
  }
}

/** 普通字段的一列：文字类的列设为文本格式，可选值固定的给下拉选择，选中单元格时提示怎么填。 */
function fieldColumn(field: Field, subSheet: string | undefined): BlankColumn {
  const need = field.required ? '必填' : '可选';
  const prompt = (text: string) => ({ title: field.title, text: `${need}。${text}` });
  if (field.kind === 'ref') return { header: field.title, width: widthOf(field.title), text: true, prompt: prompt(`写一个关联值，在工作表"${subSheet}"里用同一个值写一行内容`) };
  if (field.kind === 'refList') {
    return { header: field.title, width: widthOf(field.title), text: true, prompt: prompt(`写一个关联值，在工作表"${subSheet}"里用同一个值逐行列出各项；几行可以共用一个关联值`) };
  }
  if (field.kind === 'list') {
    const max = field.schema['maxItems'];
    return { header: field.title, width: Math.max(widthOf(field.title), 20), text: true,
      prompt: prompt(`多项写在一格里，用顿号、逗号、分号或换行分开${typeof max === 'number' ? `，至多 ${max} 项` : ''}；每项是${kindText(field.item!, isRecord(field.schema['items']) ? field.schema['items'] : {}, field.choices)}`) };
  }
  const kind = field.kind as Scalar;
  const choices = kind === 'boolean' ? ['是', '否'] : field.choices?.map(String);
  return { header: field.title, width: widthOf(field.title), text: kind !== 'number' && kind !== 'integer' && kind !== 'boolean',
    ...(choices ? { choices } : {}), prompt: prompt(kindText(kind, field.schema, field.choices)) };
}

/** 按数据定义生成空白表：主表以数据定义的显示名称命名，引用与引用列表各一张表；第二层引用不出现。 */
export function blankSheets(compiled: Record<string, unknown>, displayName: string): BlankSheet[] {
  const fields = fieldsOf(compiled, false).filter((field) => field.kind !== 'unsupported');
  const { main, references: subNames } = blankNames(fields, displayName);
  return [
    { name: main, columns: [
      { header: ID_HEADER, width: 14, text: true, prompt: { title: ID_HEADER, text: '可选。批次内不能重复；不写时用"第 N 行"。' } },
      ...fields.map((field) => fieldColumn(field, subNames.get(field.name))),
    ] },
    ...fields.filter(isReference).map((field) => ({ name: subNames.get(field.name)!, columns: [
      { header: field.title, width: widthOf(field.title), text: true,
        prompt: { title: field.title, text: field.kind === 'ref' ? `对应主表"${main}"里"${field.title}"列的关联值，一个值只写一行`
          : `对应主表"${main}"里"${field.title}"列的关联值；同一个值的几行按顺序组成一个列表` } },
      ...field.fields!.filter((sub) => sub.kind !== 'unsupported').map((sub) => fieldColumn(sub, undefined)),
    ] })),
  ];
}
