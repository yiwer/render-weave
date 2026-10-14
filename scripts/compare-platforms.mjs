/**
 * 比较两个平台由 scripts/accept-stage2.mjs 生成的 fingerprints.json：构建标识必须相同，
 * 两边文件集合必须相同，且每个文件的 SHA-256 一致。时间、绝对路径与平台信息不在指纹内。
 * 用法：node scripts/compare-platforms.mjs <甲/fingerprints.json> <乙/fingerprints.json>
 */
import { readFile } from 'node:fs/promises';

const [first, second] = process.argv.slice(2);
if (!first || !second) throw new Error('用法：node scripts/compare-platforms.mjs <甲/fingerprints.json> <乙/fingerprints.json>');
const [a, b] = await Promise.all([first, second].map(async file => JSON.parse(await readFile(file, 'utf8'))));
const onlyA = Object.keys(a.files).filter(key => !(key in b.files));
const onlyB = Object.keys(b.files).filter(key => !(key in a.files));
const differ = Object.keys(a.files).filter(key => key in b.files && a.files[key] !== b.files[key]);
const sameBuild = a.environment.builds.length === 1 && JSON.stringify(a.environment.builds) === JSON.stringify(b.environment.builds);
const report = {
  environments: [a.environment, b.environment],
  sameBuild, compared: Object.keys(a.files).length - onlyA.length, identical: Object.keys(a.files).length - onlyA.length - differ.length,
  differ, onlyFirst: onlyA, onlySecond: onlyB,
};
console.log(JSON.stringify(report, null, 2));
const ok = sameBuild && !differ.length && !onlyA.length && !onlyB.length;
console.log(ok ? `PASS：${report.identical} 个文件逐字节一致，构建标识相同` : 'FAIL：两平台成果不一致，见上方 differ/onlyFirst/onlySecond');
if (!ok) process.exitCode = 1;
