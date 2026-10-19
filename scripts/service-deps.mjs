/**
 * npm test 之前确保出图服务的依赖已安装。服务是单独的 npm 包（M259），它的快速测试（内存后端）进 npm test（M263）。
 * 已安装且锁文件没变时什么也不做。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const service = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'service');
const installed = join(service, 'node_modules', '.package-lock.json');
if (existsSync(installed) && statSync(installed).mtimeMs >= statSync(join(service, 'package-lock.json')).mtimeMs) process.exit(0);
console.error('安装出图服务的依赖（service/）');
const result = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: service, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
