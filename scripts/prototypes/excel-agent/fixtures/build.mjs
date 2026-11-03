import fs from 'node:fs/promises';
import {Workbook, SpreadsheetFile} from '@oai/artifact-tool';
const workbook = Workbook.create();
for (const direction of ['上行', '下行']) {
  const sheet = workbook.worksheets.add(direction);
  sheet.getRange('A1').values = [['示例线路']];
  sheet.getRange('A2').values = [[direction]];
  sheet.getRange('B4').values = [['站名']];
  const down = direction === '下行';
  sheet.getRange(down ? 'C4:E4' : 'C4:D4').merge();
  sheet.getRange('C4').values = [['周一至周四']];
  sheet.getRange(down ? 'F4:G4' : 'E4:F4').merge();
  sheet.getRange(down ? 'F4' : 'E4').values = [['周五']];
  sheet.getRange(down ? 'H4' : 'G4').values = [['站点编码']];
  sheet.getRange(down ? 'B5:H6' : 'B5:G6').values = down ? [
    ['田贝②', 400/1440, 410/1440, 415/1440, 420/1440, 420/1440, '00007'],
    ['田贝②', 480/1440, null, 490/1440, 500/1440, 510/1440, '00008'],
  ] : [
    ['田贝②', 400/1440, 410/1440, 420/1440, 420/1440, '00007'],
    ['田贝②', 480/1440, null, 500/1440, 510/1440, '00008'],
  ];
  sheet.getRange(down ? 'C5:G6' : 'C5:F6').setNumberFormat('hh:mm');
  sheet.getRange('B4:G4').format.fill = '#E7EDF3';
  sheet.getRange('B4:G6').format.columnWidth = 18;
  sheet.getRange('B4:G6').format.rowHeight = 26;
  sheet.showGridLines = true;
}
const notes = workbook.worksheets.add('说明');
notes.getRange('A1').values = [['验证样例，非客户数据']];
notes.getRange('A2').values = [['公式缓存单独验证']];
notes.getRange('B2').formulas = [['=1+2']];
notes.getRange('A1:B2').format.columnWidth = 30;
workbook.recalculate();
const out = process.argv[2];
if (!out) throw new Error('请传入夹具输出目录');
await fs.mkdir(out, {recursive: true});
const file = await SpreadsheetFile.exportXlsx(workbook);
await file.save(`${out}/route-table.xlsx`);
// 本机 render 原生进程退出码 1；夹具内容另用独立读取器核对。
console.log((await workbook.inspect({kind:'table',range:'上行!B4:G6',include:'values',tableMaxRows:3,tableMaxCols:6})).ndjson);
