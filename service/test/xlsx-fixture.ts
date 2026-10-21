/**
 * 测试用的 .xlsx（票据 13）：按 Excel 的写法拼出工作簿——字符串进共享字符串表、日期是带日期样式的序号、关系用相对路径；
 * 选项模仿别的程序的写法：内联字符串、元素名带命名空间前缀（.NET Open XML SDK）、不写行号与单元格坐标、1904 日期系统。
 * 与服务里写空白表的代码无关，只用来核对服务读得懂各种写法。
 */
import yazl from 'yazl';

export type FixtureCell =
  | null | undefined | string | number | boolean
  /** Excel 的错误值，如 #N/A。 */
  | { readonly error: string }
  /** 公式与 Excel 存下的计算结果。 */
  | { readonly formula: string; readonly value: string | number | boolean }
  /** 富文本：几段不同格式的文字，可带注音（注音不是单元格的值）。 */
  | { readonly runs: readonly string[]; readonly phonetic?: string }
  /** 日期序号，带日期样式。 */
  | { readonly date: number };

export interface FixtureSheet {
  readonly name: string;
  /** 第 i 个是第 i + 1 行；undefined 的单元格不写。 */
  readonly rows: readonly (readonly FixtureCell[])[];
}

export interface FixtureOptions {
  /** false 时字符串写成内联字符串（openpyxl 3.1 的写法）；缺省进共享字符串表。 */
  readonly sharedStrings?: boolean;
  /** 元素名的命名空间前缀，如 x。 */
  readonly prefix?: string;
  /** 不写行号与单元格坐标（规范允许，按出现顺序排列）。 */
  readonly omitReferences?: boolean;
  readonly date1904?: boolean;
  /** 工作表的 XML 带一段文档类型声明（DTD），服务应当拒绝读取。 */
  readonly doctype?: boolean;
  /** 工作表与共享字符串写成带 BOM 的 UTF-16LE（OPC 允许）。 */
  readonly utf16?: boolean;
  /** 另放进 zip 的部件，如数据透视缓存。 */
  readonly extraParts?: readonly (readonly [string, Uint8Array])[];
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export async function xlsxOf(sheets: readonly FixtureSheet[], options: FixtureOptions = {}): Promise<Uint8Array> {
  const shared: string[] = [], sharedIndex = new Map<string, number>();
  const p = options.prefix ? `${options.prefix}:` : '';
  const ns = options.prefix ? `xmlns:${options.prefix}="${MAIN}"` : `xmlns="${MAIN}"`;
  const strings = options.sharedStrings ?? true;
  const intern = (key: string, xml: string) => {
    let index = sharedIndex.get(key);
    if (index === undefined) { index = shared.length; shared.push(xml); sharedIndex.set(key, index); }
    return index;
  };
  const text = (value: string) => `<${p}t xml:space="preserve">${escape(value)}</${p}t>`;

  const cellXml = (cell: FixtureCell, ref: string): string => {
    const r = options.omitReferences ? '' : ` r="${ref}"`;
    // 不写坐标时单元格按顺序排列，空着的位置要占一个空单元格。
    if (cell === null || cell === undefined) return options.omitReferences ? `<${p}c/>` : '';
    if (typeof cell === 'number') return `<${p}c${r}><${p}v>${cell}</${p}v></${p}c>`;
    if (typeof cell === 'boolean') return `<${p}c${r} t="b"><${p}v>${cell ? 1 : 0}</${p}v></${p}c>`;
    if (typeof cell === 'string') {
      return strings ? `<${p}c${r} t="s"><${p}v>${intern(`s:${cell}`, text(cell))}</${p}v></${p}c>`
        : `<${p}c${r} t="inlineStr"><${p}is>${text(cell)}</${p}is></${p}c>`;
    }
    if ('error' in cell) return `<${p}c${r} t="e"><${p}v>${escape(cell.error)}</${p}v></${p}c>`;
    if ('date' in cell) return `<${p}c${r} s="1"><${p}v>${cell.date}</${p}v></${p}c>`;
    if ('formula' in cell) {
      const { value } = cell, f = `<${p}f>${escape(cell.formula)}</${p}f>`;
      if (typeof value === 'number') return `<${p}c${r}>${f}<${p}v>${value}</${p}v></${p}c>`;
      if (typeof value === 'boolean') return `<${p}c${r} t="b">${f}<${p}v>${value ? 1 : 0}</${p}v></${p}c>`;
      return `<${p}c${r} t="str">${f}<${p}v>${escape(value)}</${p}v></${p}c>`;
    }
    const runs = cell.runs.map((run, i) => `<${p}r>${i % 2 ? `<${p}rPr><${p}b/></${p}rPr>` : ''}${text(run)}</${p}r>`).join('');
    const phonetic = cell.phonetic ? `<${p}rPh sb="0" eb="1">${text(cell.phonetic)}</${p}rPh>` : '';
    if (!strings) return `<${p}c${r} t="inlineStr"><${p}is>${runs}${phonetic}</${p}is></${p}c>`;
    return `<${p}c${r} t="s"><${p}v>${intern(`r:${JSON.stringify(cell)}`, runs + phonetic)}</${p}v></${p}c>`;
  };

  const sheetXml = (sheet: FixtureSheet) => {
    const rows = sheet.rows.map((row, i) => {
      const cells = row.map((cell, j) => cellXml(cell, `${columnName(j)}${i + 1}`)).join('');
      return options.omitReferences ? `<${p}row>${cells}</${p}row>` : `<${p}row r="${i + 1}">${cells}</${p}row>`;
    }).join('');
    const doctype = options.doctype ? '<!DOCTYPE worksheet [<!ENTITY big "很长很长的文字">]>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${doctype}<${p}worksheet ${ns} xmlns:r="${REL}"><${p}sheetData>${rows}</${p}sheetData></${p}worksheet>`;
  };
  const sheetParts = sheets.map(sheetXml);

  const files: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}workbook ${ns} xmlns:r="${REL}">`
      + `<${p}workbookPr${options.date1904 ? ' date1904="1"' : ''}/><${p}sheets>`
      + sheets.map((sheet, i) => `<${p}sheet name="${escape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + `</${p}sheets></${p}workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/>`
      + `<Relationship Id="rId${sheets.length + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}styleSheet ${ns}><${p}fonts count="1"><${p}font/></${p}fonts>`
      + `<${p}fills count="1"><${p}fill/></${p}fills><${p}borders count="1"><${p}border/></${p}borders>`
      + `<${p}cellXfs count="2"><${p}xf numFmtId="0"/><${p}xf numFmtId="14" applyNumberFormat="1"/></${p}cellXfs></${p}styleSheet>`],
    // 共享字符串表在工作表之后才知道内容：工作表的 XML 已经拼好。
    ['xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}sst ${ns} count="${shared.length}" uniqueCount="${shared.length}">`
      + shared.map((xml) => `<${p}si>${xml}</${p}si>`).join('') + `</${p}sst>`],
    ...sheetParts.map((xml, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
  ];
  const utf16 = (name: string) => options.utf16 && (name.startsWith('xl/worksheets/') || name === 'xl/sharedStrings.xml');
  const encode = (name: string, xml: string) => (utf16(name)
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')]) : Buffer.from(xml, 'utf8'));
  return zipOf([...files.map(([name, xml]): [string, Uint8Array] => [name, encode(name, xml)]), ...(options.extraParts ?? [])]);
}

/** 把几个文件打成 zip。 */
export function zipOf(files: readonly (readonly [string, Uint8Array])[]): Promise<Uint8Array> {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of files) zip.addBuffer(Buffer.from(bytes), name, { mtime: new Date(Date.UTC(2026, 9, 20)) });
  zip.end();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });
}
