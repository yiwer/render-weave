// 用无头 Edge 按 1440 × 900 给每个场景截图：node docs/prototypes/template-design-v3/shoot.mjs
// 浏览器路径取 RW_BROWSER，缺省是 Windows 上 Edge 的安装位置。
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const browser = process.env.RW_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const page = pathToFileURL(join(here, 'index.html')).href;
const out = join(here, 'screenshots');
mkdirSync(out, { recursive: true });

const shots = [
  ['01-选中站名', 'scene=done&sel=name'],
  ['02-名称区的自动排布', 'scene=done&sel=area'],
  ['03-标识行', 'scene=done&sel=badges'],
  ['04-地标与按字段显示', 'scene=done&sel=mark'],
  ['05-新建的空模板', 'scene=blank'],
  ['06-新建参数', 'scene=param'],
  ['07-快捷操作', 'scene=quick'],
  ['08-插入菜单', 'scene=insert&sel=name'],
  ['09-Agent', 'scene=agent'],
];
for (const [name, hash] of shots) {
  execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1440,900',
    '--virtual-time-budget=1500', `--screenshot=${join(out, `${name}.png`)}`, `${page}#${hash}`], { stdio: 'ignore' });
  console.log(name);
}
