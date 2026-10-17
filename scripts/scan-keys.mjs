// 在给定的目录与文件中搜索环境变量里的 key（第三阶段验收 A05）：完整值，以及前后各 12 个字符的片段。
// 只输出命中的文件路径与计数，不输出 key 本身。
//
//   node scripts/scan-keys.mjs [--env 变量名 …] <目录或文件> …
//
// 缺省检查 OPEN_CODE_API_KEY；可以重复 --env 检查多个变量。退出码：0 没有命中；1 有命中；2 用法错误或变量为空。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const names = [];
const targets = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--env') names.push(args[++index]);
  else targets.push(args[index]);
}
if (names.length === 0) names.push('OPEN_CODE_API_KEY');
if (targets.length === 0 || names.some((name) => !name)) {
  console.error('用法：node scripts/scan-keys.mjs [--env 变量名 …] <目录或文件> …');
  process.exit(2);
}
const needles = [];
for (const name of names) {
  const key = process.env[name];
  if (!key) {
    console.error(`环境变量 ${name} 为空：没有可搜索的 key`);
    process.exit(2);
  }
  needles.push({ name, parts: [key, key.slice(0, 12), key.slice(-12)].map((part) => Buffer.from(part)) });
}

let files = 0;
let hits = 0;
const walk = (path) => {
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry));
    return;
  }
  files++;
  const bytes = readFileSync(path);
  for (const { name, parts } of needles) {
    if (parts.some((part) => bytes.includes(part))) {
      hits++;
      console.log(`命中 ${name}：${path}`);
    }
  }
};
for (const target of targets) walk(target);
console.log(`扫描 ${files} 个文件，检查 ${needles.length} 个 key，命中 ${hits}`);
process.exit(hits > 0 ? 1 : 0);
