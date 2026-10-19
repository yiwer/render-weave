/**
 * 密码与令牌（M261）。
 * - 密码用 scrypt 慢哈希，参数随哈希保存：scrypt$N$r$p$盐$哈希；
 * - 令牌是 32 字节随机数，前缀区分种类（会话 rws_、API 密钥 rwk_、代建令牌 rwa_），服务端只存 SHA-256；
 * - 初始密码与重置后的密码随机生成，只在响应里出现一次。
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, length: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key))));

/** 生产参数约 100 ms、32 MB；测试用低成本参数，参数随哈希保存，校验时按哈希里的参数算。 */
export const PASSWORD_COST = { production: { N: 2 ** 15, r: 8, p: 1 }, test: { N: 2 ** 10, r: 8, p: 1 } } as const;
export type PasswordCost = keyof typeof PASSWORD_COST;

export async function hashPassword(password: string, cost: PasswordCost = 'production'): Promise<string> {
  const { N, r, p } = PASSWORD_COST[cost], salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password.normalize('NFC'), Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * Number(n) * Number(r) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 找不到账号时也算一次哈希，响应时间不暴露邮箱是否存在。 */
let dummy: Promise<string> | undefined;
export async function dummyVerify(password: string, cost: PasswordCost): Promise<void> {
  await verifyPassword(password, await (dummy ??= hashPassword('not-a-real-password', cost)));
}

/** 随机密码：24 个字符，管理员转交给成员。 */
export const generatePassword = () => randomBytes(18).toString('base64url');

export type TokenKind = 'session' | 'apiKey' | 'authoring';
const PREFIX: Record<TokenKind, string> = { session: 'rws_', apiKey: 'rwk_', authoring: 'rwa_' };

export function generateToken(kind: TokenKind): { token: string; hash: string; prefix: string } {
  const token = `${PREFIX[kind]}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, PREFIX[kind].length + 6) };
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 令牌格式：前缀加 43 个 base64url 字符。格式不对的直接当作无效，不查库。 */
export const tokenShape = /^rw[ska]_[A-Za-z0-9_-]{43}$/;
