/**
 * 第二阶段收尾验收（票据 13）：在已 npm ci、下载字体并构建的检出中，依次运行全部验收脚本与资源提交压测，
 * 记录各脚本退出码与耗时，再收集可跨平台比较的成果指纹（图片、布局摘要、问题清单与出图记录清单的 SHA-256）。
 * 两个平台各跑一次后，用 scripts/compare-platforms.mjs 比较两份 fingerprints.json。
 * 用法：node scripts/accept-stage2.mjs <输出目录> [长批次项数，默认 1000]
 *       node scripts/accept-stage2.mjs <输出目录> --collect-only   （不重跑，只从已有成果重新收集指纹）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? `out/stage2/acceptance-${process.platform === 'win32' ? 'windows' : 'linux'}`);
const collectOnly = process.argv[3] === '--collect-only', longItems = collectOnly ? '1000' : process.argv[3] ?? '1000';
await mkdir(join(out, 'logs'), { recursive: true });

// 取消验收会在随机时刻强杀进程、长批次只在自身证据中核对一致性，二者的目录内容不作跨平台比较。
const steps = [
  ['accept-stage1', ['scripts/accept-stage1.mjs', join(out, 'stage1')], true],
  ['accept-m402', ['scripts/accept-m402.mjs', join(out, 'm402')], true],
  ['check-svg-platform', ['scripts/check-svg-platform.mjs', join(out, 'svg')], true],
  ['accept-qrcode', ['scripts/accept-qrcode.mjs', join(out, 'qrcode')], true],
  ['accept-barcode', ['scripts/accept-barcode.mjs', join(out, 'barcode')], true],
  ['accept-retail-barcodes', ['scripts/accept-retail-barcodes.mjs', join(out, 'retail')], true],
  ['accept-versioned-resources', ['scripts/accept-versioned-resources.mjs', join(out, 'resources')], true],
  ['accept-resource-replacement', ['scripts/accept-resource-replacement.mjs', join(out, 'replacement')], true],
  ['accept-output-record', ['scripts/accept-output-record.mjs', join(out, 'record')], true],
  ['accept-record-closure', ['scripts/accept-record-closure.mjs', join(out, 'closure')], true],
  ['accept-batch', ['scripts/accept-batch.mjs', join(out, 'batch')], true],
  ['accept-batch-cancel', ['scripts/accept-batch-cancel.mjs', join(out, 'cancel')], false],
  ['accept-coded-sign', ['scripts/accept-coded-sign.mjs', join(out, 'coded')], true],
  ['stress-resource-commit', ['scripts/stress-resource-commit.mjs'], false],
  ['accept-long-batch', ['scripts/accept-long-batch.mjs', join(out, 'long'), longItems], false],
];

const results = collectOnly ? JSON.parse(await readFile(join(out, 'stage2-run.json'), 'utf8')).steps : [];
for (const [name, args] of collectOnly ? [] : steps) {
  const started = performance.now();
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  await writeFile(join(out, 'logs', `${name}.log`), `${run.stdout ?? ''}\n--- stderr ---\n${run.stderr ?? ''}`);
  const last = `${run.stdout ?? ''}`.trim().split('\n').at(-1) ?? '';
  results.push({ name, exit: run.status, signal: run.signal, seconds, last: last.slice(0, 300) });
  console.log(`${run.status === 0 ? 'PASS' : 'FAIL'} ${name}（${seconds} 秒，退出码 ${run.status}）`);
  await writeFile(join(out, 'stage2-run.json'), JSON.stringify({ steps: results }, null, 2) + '\n');
}

// 指纹只取内容由输入决定的文件；mkdtemp 产生的随机目录名归一为 *，输出根目录以外的路径不参与。
const compared = new Set(['image.png', 'image.jpg', 'draft.png', 'draft.jpg', 'layout.json', 'problems.json', 'record.json',
  'input.json', 'batch.json', 'preview.json', 'replay.json', 'hashes.json', 'decoding.json', 'summary.json', 'inputs.sha256.json']);
// 出图记录的 input.json 为每份文档保存交付时的文件路径（source，绝对或相对，分隔符随平台），record.json 又含 input.json 的哈希；
// 二者先把文档路径替换为占位符再取指纹，其余内容逐字节比较（PRD A14：记录时间与路径不参与比较）。
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PATH = '<路径>';
const withoutSource = list => list.map(entry => entry.source === undefined ? entry : { ...entry, source: PATH });
function withoutPaths(input) {
  const { templates, datasets, staticSchemas, problems } = input.documents;
  return { ...input, documents: { ...input.documents, templates: withoutSource(templates), datasets: withoutSource(datasets),
    staticSchemas: withoutSource(staticSchemas), problems: problems.map(p => p.location?.kind === 'input' ? { ...p, location: { ...p.location, source: PATH } } : p) } };
}
function normalized(name, bytes, dir) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (name === 'input.json') return JSON.stringify(withoutPaths(value));
  const input = join(dir, 'input.json');
  return JSON.stringify({ ...value, files: value.files.map(entry => entry.file === 'input.json' ? { file: entry.file, normalized: true } : entry) }) +
    sha256(normalized('input.json', readFileSync(input), dir));
}
const fingerprints = {}, normalizedKeys = [], builds = new Set();
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile() && compared.has(entry.name)) {
      const bytes = await readFile(file);
      const key = relative(out, file).replaceAll('\\', '/').replace(/\b(run|workspace|resources)-[A-Za-z0-9]{6}(?=\/)/g, '$1-*');
      if (key in fingerprints) throw new Error(`归一后的路径重复：${key}`);
      const record = entry.name === 'input.json' || (entry.name === 'record.json' && existsSync(join(dir, 'input.json')));
      fingerprints[key] = record ? sha256(normalized(entry.name, bytes, dir)) : sha256(bytes);
      if (record) normalizedKeys.push(key);
      // 只认批次清单；验收脚本的请求文件也可能叫 batch.json。
      const manifest = entry.name === 'batch.json' ? JSON.parse(bytes.toString('utf8')) : undefined;
      if (manifest?.format === 'renderweave-batch/1') builds.add(manifest.build);
    }
  }
}
for (const [, args, comparable] of steps) if (comparable) await walk(args[1]);

const environment = { platform: process.platform, arch: process.arch, node: process.version, builds: [...builds] };
const sorted = Object.fromEntries(Object.entries(fingerprints).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
await writeFile(join(out, 'fingerprints.json'), JSON.stringify({ environment, normalized: normalizedKeys.sort(), files: sorted }, null, 2) + '\n');
await writeFile(join(out, 'stage2-run.json'), JSON.stringify({ environment, steps: results }, null, 2) + '\n');
const failed = results.filter(result => result.exit !== 0);
console.log(`${failed.length ? 'FAIL' : 'PASS'}：${results.length - failed.length}/${results.length} 个验收步骤通过；` +
  `指纹 ${Object.keys(sorted).length} 个文件，构建标识 ${[...builds].join('、') || '无'}（${process.platform}，Node ${process.version}）`);
if (failed.length || builds.size !== 1) process.exitCode = 1;
