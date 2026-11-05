/** 本机 Docker 环境的共用步骤：生成不进版本库的 .env、调用 docker compose、以构建标识给镜像打标签。 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hex = (bytes) => randomBytes(bytes).toString('hex');

/** 本机服务需要的凭据：数据库属主、应用账号、对象存储，与加密 webhook 签名密钥的服务密钥（票据 11）。 */
const CREDENTIALS = {
  RW_POSTGRES_PASSWORD: () => hex(24),
  RW_APP_DB_PASSWORD: () => hex(24),
  RW_S3_ACCESS_KEY_ID: () => `rw${hex(8)}`,
  RW_S3_SECRET_ACCESS_KEY: () => hex(24),
  RW_SECRET_KEY: () => hex(32),
};

/** 没有 .env 时生成随机凭据；已有时只补上缺少的项，不改已有的值。凭据只写进这个文件，不打印。返回补上的变量名。 */
export function ensureEnv() {
  const file = join(root, '.env');
  const header = '# 本机出图服务的凭据：由 service/scripts/up.mjs 随机生成，不进版本库（M259）。';
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = Object.keys(CREDENTIALS).filter((name) => !new RegExp(`^${name}=`, 'm').test(existing));
  if (!missing.length) return [];
  const lines = [...(existing ? [existing.trimEnd()] : [header]), ...missing.map((name) => `${name}=${CREDENTIALS[name]()}`)];
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return missing;
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

/** 比较工作目录用：Windows 上路径不分大小写，盘符可能写成小写。 */
const checkoutKey = (dir) => (process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir));

/**
 * 动 Compose 项目之前先调（M386）：项目名写死在 compose.yaml，端口也有缺省值，同一个项目一台机器上只能有一个检出在用。
 * 这个项目有容器在跑且属于别的检出时，打印占用的目录并以退出码 3 结束，什么也不动。
 * 只看在跑的容器：这个检出自己的残留、别的检出停着的容器不算占用，由调用方照旧清掉。
 * 设了 COMPOSE_PROJECT_NAME 的隔离跑只查它自己的项目，不碰、也不管 renderweave。
 */
export function ensureProjectFree() {
  const project = process.env.COMPOSE_PROJECT_NAME || 'renderweave';
  const rows = capture('docker', ['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}|{{.Label "com.docker.compose.project.working_dir"}}']);
  const held = new Map();
  for (const row of rows.split('\n').filter((line) => line.trim())) {
    const [name, dir] = row.trim().split('|');
    if (!dir || checkoutKey(dir) !== checkoutKey(root)) held.set(dir, [...(held.get(dir) ?? []), name]);
  }
  if (!held.size) return;
  console.error(`Compose 项目 ${project} 正被别的检出占用，这次什么也没动：`);
  for (const [dir, names] of held) console.error(`  ${dir || '（容器没有记工作目录）'}：${names.join('、')}`);
  console.error('等那边跑完再来；要同时跑就换项目名与端口：COMPOSE_PROJECT_NAME=rw-test RW_API_PORT=18080 RW_WORKER_PORT=18081。');
  console.error(`确认那边没人在用、数据也不要了，才清掉（连数据卷一起删）：docker compose -p ${project} down -v --remove-orphans`);
  process.exit(3);
}

/** 构建要几分钟，这段时间还没有 api、worker 的容器，别的检出查不到占用：构建之前先起不用构建的 postgres 占住项目（M386）。 */
export function holdProject() {
  run('docker', ['compose', 'up', '-d', 'postgres']);
}

/** 起服务并等到全部就绪，再以构建标识给镜像打标签（ADR-0019），返回构建标识与标签。 */
export function up() {
  holdProject();
  run('docker', ['compose', 'up', '-d', '--build', '--wait', 'api', 'worker']);
  const build = capture('docker', ['run', '--rm', '--entrypoint', 'cat', 'renderweave-service:local', '/app/BUILD_ID']).trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(build)) throw new Error('镜像里的构建标识格式不对');
  const image = `renderweave-service:${build.replace(':', '-')}`;
  run('docker', ['tag', 'renderweave-service:local', image]);
  return { build, image };
}
