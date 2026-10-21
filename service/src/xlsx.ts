/**
 * .xlsx 的读与写（票据 13，M284）：Excel 导入读客户的工作簿，空白表由这里写出。
 * - 读：yauzl（MIT）在内存里解压，分三遍只解开用得到的部件：关系、工作簿、共享字符串与调用方选中的工作表，
 *   样式、图形、数据透视缓存与没选中的工作表都不解开。按 zip 里登记的解压大小累计，超过解压上限就停在解开之前；
 *   yauzl 另核对实际解出的字节不多于登记的大小（validateEntrySizes），登记得小、解开很大的文件读不了；
 *   工作表、共享字符串与关系由本文件的 XML 扫描器读取：不接受 DTD，只认 XML 预定义实体与字符引用；部件按 BOM 认 UTF-8 或 UTF-16；
 *   单元格只取值（数值、文字、是否、错误值），不读样式与数字格式——日期按目标字段的类型从序号换算（excel-import.ts）。
 * - 写：yazl（MIT）打包，内联字符串，表头加粗并冻结，列宽、文本格式、下拉选择与输入提示按调用方给的列说明。
 * 只支持 Office Open XML 的 .xlsx；旧版 .xls 与加了密码的工作簿（OLE 复合文档）读不了，提示另存。
 */
import yauzl from 'yauzl';
import yazl from 'yazl';

/** 读取时的上限：解压后的 XML 总字节数与非空单元格总数（ADR-0017 的入队前检查同理：先拒绝，不占 worker）。 */
export interface WorkbookLimits {
  readonly maxUnzippedBytes: number;
  readonly maxCells: number;
}

/** 单元格的值：文字（共享字符串、内联字符串、公式的文字结果）、数值（raw 是文件里的写法）、是否、错误值（如 #N/A）。 */
export type CellValue =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'error'; readonly text: string };

export interface SheetRow {
  /** Excel 里看到的行号，从 1 开始。 */
  readonly number: number;
  /** 列序号（从 0 开始）到值；空单元格不在其中。 */
  readonly cells: ReadonlyMap<number, CellValue>;
}

export interface Sheet {
  readonly name: string;
  readonly rows: readonly SheetRow[];
}

export interface Workbook {
  /** 全部工作表的名称，按工作簿里的顺序。 */
  readonly names: readonly string[];
  /** 读出来的工作表（调用方选中的），按工作簿里的顺序。 */
  readonly sheets: readonly Sheet[];
  /** 1904 日期系统（Mac 上的老工作簿）：日期序号从 1904-01-01 起算。 */
  readonly date1904: boolean;
}

/** 读不了（unreadable）或超出上限（tooLarge）；message 是给客户看的中文说明。 */
export class WorkbookError extends Error {
  constructor(readonly reason: 'unreadable' | 'tooLarge', message: string) { super(message); }
}

const unreadable = (message: string) => new WorkbookError('unreadable', message);

/** 列序号（从 0 开始）的字母写法：0 → A，26 → AA。 */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Excel 最多 16,384 列（XFD）、1,048,576 行。 */
const MAX_COLUMN = 16_384, MAX_ROW = 1_048_576;

function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  if (index < 1 || index > MAX_COLUMN) throw unreadable(`单元格坐标的列 ${letters} 超出范围`);
  return index - 1;
}

// —— XML 扫描 ——

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);|&/g, (whole, name: string | undefined) => {
    if (name === undefined) throw unreadable('XML 里有未转义的 &');
    if (name.startsWith('#')) {
      const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) throw unreadable(`XML 字符引用 ${whole} 不合法`);
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[name];
    if (value === undefined) throw unreadable(`XML 里有未定义的实体 ${whole}`);
    return value;
  });
}

/** OOXML 的字符串转义：控制字符写成 _xHHHH_（如换行回车 _x000D_）。 */
const decodeOoxml = (text: string) => text.replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

interface XmlHandlers {
  open?(name: string, attributes: ReadonlyMap<string, string>, empty: boolean): void;
  close?(name: string): void;
  /** 原文（未解码），由处理者按需解码。 */
  text?(raw: string): void;
}

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const localName = (name: string) => name.slice(name.indexOf(':') + 1);

/** 按顺序报告开始、结束标签与文字；元素名与属性名去掉命名空间前缀。 */
function scanXml(xml: string, on: XmlHandlers): void {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { on.text?.(xml.slice(i)); return; }
    if (lt > i) on.text?.(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw unreadable('XML 注释没有结束');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw unreadable('XML 的 CDATA 没有结束');
      on.text?.(xml.slice(lt + 9, end).replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;')));
      i = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw unreadable('XML 声明没有结束');
      i = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      throw unreadable('工作簿的 XML 带有文档类型声明（DTD），不予读取');
    } else {
      TAG.lastIndex = lt;
      const match = TAG.exec(xml);
      if (!match) throw unreadable('工作簿的 XML 格式不正确');
      const [, closing, name, attributeText, empty] = match;
      if (closing) on.close?.(localName(name!));
      else {
        const attributes = new Map<string, string>();
        for (const [, key, double, single] of attributeText!.matchAll(ATTRIBUTE)) attributes.set(localName(key!), decodeXml(double ?? single ?? ''));
        on.open?.(localName(name!), attributes, empty === '/');
        if (empty === '/') on.close?.(localName(name!));
      }
      i = TAG.lastIndex;
    }
  }
}

/** 富文本与内联字符串的文字：各段 <t> 连起来，注音（<rPh>）不算。 */
function stringItemCollector() {
  let depthPhonetic = 0, inText = false, parts: string[] = [];
  return {
    open(name: string) {
      if (name === 'rPh') depthPhonetic++;
      else if (name === 't' && depthPhonetic === 0) inText = true;
    },
    close(name: string) {
      if (name === 'rPh') depthPhonetic--;
      else if (name === 't') inText = false;
    },
    text(raw: string) { if (inText) parts.push(raw); },
    take(): string { const text = decodeOoxml(decodeXml(parts.join(''))); parts = []; return text; },
  };
}

function readSharedStrings(xml: string): string[] {
  const strings: string[] = [], item = stringItemCollector();
  let inItem = false;
  scanXml(xml, {
    open(name) { if (name === 'si') inItem = true; else if (inItem) item.open(name); },
    close(name) { if (name === 'si') { strings.push(item.take()); inItem = false; } else if (inItem) item.close(name); },
    text(raw) { if (inItem) item.text(raw); },
  });
  return strings;
}

function readSheet(name: string, xml: string, shared: readonly string[], counter: { cells: number; readonly max: number }): Sheet {
  const rows: SheetRow[] = [], item = stringItemCollector();
  let inData = false, rowNumber = 0, column = -1, cells = new Map<number, CellValue>();
  let cell: { type: string; value: string[]; inValue: boolean; inInline: boolean } | undefined;
  const finishCell = () => {
    if (!cell) return;
    const raw = decodeXml(cell.value.join(''));
    let value: CellValue | undefined;
    switch (cell.type) {
      case 's': {
        if (!raw.trim()) break;
        const index = Number(raw);
        const text = Number.isInteger(index) ? shared[index] : undefined;
        if (text === undefined) throw unreadable(`工作表"${name}"的单元格引用了不存在的共享字符串 ${raw}`);
        value = { kind: 'text', text };
        break;
      }
      case 'inlineStr': value = { kind: 'text', text: item.take() }; break;
      case 'str': case 'd': value = { kind: 'text', text: decodeOoxml(raw) }; break;
      case 'b': if (raw.trim()) value = { kind: 'boolean', value: raw.trim() === '1' || raw.trim().toLowerCase() === 'true' }; break;
      case 'e': if (raw.trim()) value = { kind: 'error', text: raw.trim() }; break;
      default: {
        if (!raw.trim()) break;
        const number = Number(raw);
        if (!Number.isFinite(number)) throw unreadable(`工作表"${name}"有读不了的数值 ${raw.slice(0, 40)}`);
        value = { kind: 'number', value: number };
      }
    }
    if (value) {
      if (++counter.cells > counter.max) {
        throw new WorkbookError('tooLarge', `工作簿的非空单元格超过 ${counter.max.toLocaleString('zh-CN')} 个`);
      }
      cells.set(column, value);
    }
    cell = undefined;
  };
  scanXml(xml, {
    open(element, attributes) {
      if (element === 'sheetData') { inData = true; return; }
      if (!inData) return;
      if (element === 'row') {
        const r = attributes.get('r');
        rowNumber = r === undefined ? rowNumber + 1 : Number(r);
        if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROW) throw unreadable(`工作表"${name}"的行号 ${r} 不合法`);
        column = -1;
        cells = new Map();
      } else if (element === 'c') {
        const r = attributes.get('r');
        if (r === undefined) column++;
        else {
          const match = /^([A-Z]{1,3})([0-9]+)$/.exec(r);
          if (!match) throw unreadable(`工作表"${name}"的单元格坐标 ${r} 不合法`);
          column = columnIndex(match[1]!);
        }
        cell = { type: attributes.get('t') ?? 'n', value: [], inValue: false, inInline: false };
      } else if (cell) {
        if (element === 'v') cell.inValue = true;
        else if (element === 'is') cell.inInline = true;
        else if (cell.inInline) item.open(element);
      }
    },
    close(element) {
      if (element === 'sheetData') { inData = false; return; }
      if (!inData) return;
      if (element === 'row') {
        if (cells.size) rows.push({ number: rowNumber, cells });
      } else if (element === 'c') finishCell();
      else if (cell) {
        if (element === 'v') cell.inValue = false;
        else if (element === 'is') cell.inInline = false;
        else if (cell.inInline) item.close(element);
      }
    },
    text(raw) {
      if (!cell) return;
      if (cell.inValue) cell.value.push(raw);
      else if (cell.inInline) item.text(raw);
    },
  });
  return { name, rows };
}

/** 部件的文字：按 BOM 认 UTF-16（小端或大端），否则按 UTF-8。 */
function partText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

/**
 * 解开 zip 里选中的部件，键是去掉开头 / 的小写路径。budget 是几遍共用的解压余量：
 * 按登记的解压大小扣，不够就停在解开之前（WorkbookError tooLarge）。
 */
function unzipParts(bytes: Uint8Array, budget: { remaining: number; readonly limit: number }, wanted: (key: string) => boolean): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(unreadable('不是 .xlsx 文件：无法按 zip 读取'));
      const parts = new Map<string, string>();
      let settled = false;
      const fail = (failure: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(failure);
      };
      zip.on('error', () => fail(unreadable('不是 .xlsx 文件：zip 内容损坏')));
      zip.on('end', () => { if (!settled) { settled = true; resolve(parts); } });
      zip.on('entry', (entry: yauzl.Entry) => {
        const key = entry.fileName.replace(/^\/+/, '').toLowerCase();
        if (!wanted(key)) return zip.readEntry();
        if (entry.uncompressedSize > budget.remaining) {
          return fail(new WorkbookError('tooLarge', `工作簿解压后超过 ${(budget.limit / 1024 / 1024).toFixed(0)} MiB`));
        }
        budget.remaining -= entry.uncompressedSize;
        zip.openReadStream(entry, (failed, stream) => {
          if (failed || !stream) return fail(unreadable(`工作簿的部件 ${entry.fileName} 读不出来`));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', () => fail(unreadable(`工作簿的部件 ${entry.fileName} 读不出来`)));
          stream.on('end', () => {
            if (settled) return;
            parts.set(key, partText(Buffer.concat(chunks)));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** 关系部件：Id 到目标路径（相对于源部件所在目录解析成包内的绝对路径，小写）与类型。 */
function readRelationships(xml: string | undefined, sourceDir: string): Map<string, { readonly target: string; readonly type: string }> {
  const relationships = new Map<string, { target: string; type: string }>();
  if (xml === undefined) return relationships;
  scanXml(xml, {
    open(name, attributes) {
      if (name !== 'Relationship' || attributes.get('TargetMode') === 'External') return;
      const id = attributes.get('Id'), target = attributes.get('Target');
      if (!id || !target) return;
      const segments = (target.startsWith('/') ? target.slice(1) : `${sourceDir}${target}`).split('/');
      const resolved: string[] = [];
      for (const segment of segments) {
        if (segment === '..') resolved.pop();
        else if (segment !== '.' && segment !== '') resolved.push(segment);
      }
      relationships.set(id, { target: resolved.join('/').toLowerCase(), type: attributes.get('Type') ?? '' });
    },
  });
  return relationships;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * 读出工作簿：全部工作表的名称，以及 choose 选中的工作表（缺省全选）。读不了或超出上限时抛 WorkbookError。
 * 先解开关系部件找到工作簿与各工作表的部件，再解开工作簿部件读出表名，最后只解开共享字符串与选中的工作表。
 */
export async function readWorkbook(bytes: Uint8Array, limits: WorkbookLimits,
  choose: (names: readonly string[]) => ReadonlySet<string> = (names) => new Set(names)): Promise<Workbook> {
  if (OLE_MAGIC.every((byte, i) => bytes[i] === byte)) {
    throw unreadable('这是旧版 .xls 或加了打开密码的工作簿，读不了；请在 Excel 或 WPS 里另存为不加密的 .xlsx');
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw unreadable('不是 .xlsx 文件；请上传 Excel 或 WPS 保存的 .xlsx');
  const budget = { remaining: limits.maxUnzippedBytes, limit: limits.maxUnzippedBytes };
  const rels = await unzipParts(bytes, budget, (key) => key.endsWith('.rels'));
  const root = readRelationships(rels.get('_rels/.rels'), '');
  const workbookPath = [...root.values()].find((relationship) => relationship.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  const workbookDir = workbookPath.includes('/') ? workbookPath.slice(0, workbookPath.lastIndexOf('/') + 1) : '';
  const relationships = readRelationships(rels.get(`${workbookDir}_rels/${workbookPath.slice(workbookDir.length)}.rels`), workbookDir);
  const workbookXml = (await unzipParts(bytes, budget, (key) => key === workbookPath)).get(workbookPath);
  if (workbookXml === undefined) throw unreadable('不是 .xlsx 文件：缺少工作簿部件');

  const declared: { name: string; id: string }[] = [];
  let date1904 = false;
  scanXml(workbookXml, {
    open(name, attributes) {
      if (name === 'workbookPr') date1904 = ['1', 'true'].includes(attributes.get('date1904') ?? '');
      else if (name === 'sheet') declared.push({ name: attributes.get('name') ?? '', id: attributes.get('id') ?? '' });
    },
  });
  // 图表工作表、对话框工作表没有单元格，不算。
  const worksheets = declared.flatMap(({ name, id }) => {
    const relationship = relationships.get(id);
    return relationship?.type.endsWith('/worksheet') ? [{ name, target: relationship.target }] : [];
  });
  if (!worksheets.length) throw unreadable('工作簿里没有工作表');
  const names = worksheets.map((sheet) => sheet.name), chosen = choose(names);
  const sharedPath = [...relationships.values()].find((relationship) => relationship.type.endsWith('/sharedStrings'))?.target ?? `${workbookDir}sharedstrings.xml`;
  const targets = new Set([sharedPath, ...worksheets.filter((sheet) => chosen.has(sheet.name)).map((sheet) => sheet.target)]);
  const parts = await unzipParts(bytes, budget, (key) => targets.has(key));
  const sharedXml = parts.get(sharedPath);
  const shared = sharedXml === undefined ? [] : readSharedStrings(sharedXml);
  const counter = { cells: 0, max: limits.maxCells };
  const sheets: Sheet[] = [];
  for (const { name, target } of worksheets) {
    if (!chosen.has(name)) continue;
    const xml = parts.get(target);
    if (xml === undefined) throw unreadable(`工作表"${name}"的部件缺失`);
    sheets.push(readSheet(name, xml, shared, counter));
  }
  return { names, sheets, date1904 };
}

// —— 写空白表 ——

/** 空白表的一列：表头、列宽（字符数）、是否设为文本格式，可选的下拉选择与输入提示（选中单元格时显示）。 */
export interface BlankColumn {
  readonly header: string;
  readonly width: number;
  readonly text: boolean;
  readonly choices?: readonly string[];
  readonly prompt?: { readonly title: string; readonly text: string };
}

export interface BlankSheet {
  readonly name: string;
  readonly columns: readonly BlankColumn[];
}

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** 下拉选择与提示覆盖的行：表头下面 1,000 行（与一次导入的行数上限相同）。 */
const VALIDATION_ROWS = 1000;
const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Excel 的限制：提示标题 32 个字符、提示 255 个字符、下拉选项连起来 255 个字符。 */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function worksheetXml(sheet: BlankSheet): string {
  const cols = sheet.columns.map((column, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${column.width}" customWidth="1"${column.text ? ' style="2"' : ''}/>`).join('');
  const header = sheet.columns.map((column, i) => `<c r="${columnName(i)}1" s="1" t="inlineStr"><is><t>${escapeXml(column.header)}</t></is></c>`).join('');
  const validations = sheet.columns.flatMap((column, i) => {
    const range = `${columnName(i)}2:${columnName(i)}${VALIDATION_ROWS + 1}`;
    const list = column.choices && !column.choices.some((choice) => /[",]/.test(choice)) ? column.choices.join(',') : undefined;
    const dropdown = list !== undefined && list.length <= 255;
    if (!dropdown && !column.prompt) return [];
    const prompt = column.prompt
      ? ` showInputMessage="1" promptTitle="${escapeXml(clip(column.prompt.title, 32))}" prompt="${escapeXml(clip(column.prompt.text, 255))}"` : '';
    return [dropdown
      ? `<dataValidation type="list" allowBlank="1" showErrorMessage="1"${prompt} sqref="${range}"><formula1>"${escapeXml(list!)}"</formula1></dataValidation>`
      : `<dataValidation allowBlank="1"${prompt} sqref="${range}"/>`];
  });
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData><row r="1">${header}</row></sheetData>`
    + (validations.length ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>` : '')
    + '</worksheet>';
}

/** 写出空白表：每张工作表一行表头。时间戳是常量且只写 DOS 时间，同一份数据定义在哪个时区都得到同样的字节。 */
export function writeBlankWorkbook(sheets: readonly BlankSheet[]): Promise<Uint8Array> {
  const parts: [string, string][] = [
    ['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>'],
    ['_rels/.rels', `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>`
      + sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`],
    // 样式 0 常规，1 表头（加粗、浅灰底），2 文本格式（@），保证货号、编号这类数字串的前导零不丢。
    ['xl/styles.xml', `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">`
      + '<fonts count="2"><font><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font>'
      + '<font><b/><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font></fonts>'
      + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FFEFEDE8"/><bgColor indexed="64"/></patternFill></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      + '<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>'
      + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ...sheets.map((sheet, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, worksheetXml(sheet)]),
  ];
  // DOS 时间按本地时间的年月日时分取值：用本地时间构造常量，不写带 UTC 秒数的扩展时间戳。
  const zip = new yazl.ZipFile(), mtime = new Date(2026, 0, 1);
  for (const [name, xml] of parts) zip.addBuffer(Buffer.from(xml, 'utf8'), name, { mtime, forceDosTimestamp: true });
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });
}
