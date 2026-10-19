/** 本机 Docker 环境的共用步骤：生成不进版本库的 .env、调用 docker compose、以构建标识给镜像打标签。 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hex = (bytes) => randomBytes(bytes).toString('hex');

/** 没有 .env 时生成随机凭据；已有时不动。凭据只写进这个文件，不打印。 */
export function ensureEnv() {
  const file = join(root, '.env');
  if (existsSync(file)) return false;
  writeFileSync(file, [
    '# 本机出图服务的凭据：由 service/scripts/up.mjs 随机生成，不进版本库（M259）。',
    `RW_POSTGRES_PASSWORD=${hex(24)}`,
    `RW_S3_ACCESS_KEY_ID=rw${hex(8)}`,
    `RW_S3_SECRET_ACCESS_KEY=${hex(24)}`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  return true;
}

/** 运行命令，输出直接给终端；失败即抛错。 */
export function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`);
}

export function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}：${result.stderr}`);
  return result.stdout;
}

/** 起服务并等到全部就绪，再以构建标识给镜像打标签（ADR-0019），返回构建标识与标签。 */
export function up() {
  run('docker', ['compose', 'up', '-d', '--build', '--wait', 'api', 'worker']);
  const build = capture('docker', ['run', '--rm', '--entrypoint', 'cat', 'renderweave-service:local', '/app/BUILD_ID']).trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(build)) throw new Error('镜像里的构建标识格式不对');
  const image = `renderweave-service:${build.replace(':', '-')}`;
  run('docker', ['tag', 'renderweave-service:local', image]);
  return { build, image };
}
