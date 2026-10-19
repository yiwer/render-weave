/**
 * 一条命令起本机出图服务（M240、M259）：没有 .env 时生成随机凭据，再构建镜像、起 PostgreSQL、S3 兼容存储、接口进程与 worker，
 * 等全部就绪后以构建标识给镜像打标签。用法：node service/scripts/up.mjs
 */
import { ensureEnv, up } from './docker.mjs';

if (ensureEnv()) console.error('已生成 .env（随机凭据，不进版本库）');
const { build, image } = up();
console.log(JSON.stringify({ api: `http://127.0.0.1:${process.env.RW_API_PORT ?? 8080}`, worker: `http://127.0.0.1:${process.env.RW_WORKER_PORT ?? 8081}`, build, image }, null, 2));
