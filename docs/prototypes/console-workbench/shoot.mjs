// 用无头 Edge 按 1440 × 900 给每个场景截图：node docs/prototypes/console-workbench/shoot.mjs
// 浏览器路径取 RW_BROWSER，缺省是 Windows 上 Edge 的安装位置。截图里不带原型自己的场景条（shot=1）。
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
  ['01-总览', '/overview'],
  ['02-数据定义', '/definitions'],
  ['03-数据定义-编辑', '/definitions/route-sign'],
  ['04-数据定义-发布', '/definitions/route-sign?publish=1'],
  ['05-模板-画廊', '/templates'],
  ['06-模板-列表', '/templates?view=list&sel=route-sign-night'],
  ['07-数据集', '/datasets'],
  ['08-数据集-有问题的一份', '/datasets?def=route-sign&sel=ds-18路-a'],
  ['09-数据集-多选', '/datasets?def=route-sign&checked=1'],
  ['10-数据集-编辑', '/datasets/ds-m402-wanguocheng?stop=4'],
  ['11-出图-批次', '/batches'],
  ['12-出图-出图记录', '/batches?cell=5'],
  ['13-出图-全部记录', '/records'],
  ['14-用量', '/usage'],
  ['15-资源', '/resources'],
  ['16-管理', '/admin'],
  ['17-搜索与跳转', '/overview?k=M402'],
  ['18-左栏收起', '/datasets?rail=min'],
];
const only = process.argv.slice(2);
for (const [name, hash] of shots) {
  if (only.length && !only.some((p) => name.startsWith(p))) continue;
  const url = `${page}#${encodeURI(hash)}${hash.includes('?') ? '&' : '?'}shot=1`;
  execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1440,900',
    '--virtual-time-budget=1500', `--screenshot=${join(out, `${name}.png`)}`, url], { stdio: 'ignore' });
  console.log(name);
}
