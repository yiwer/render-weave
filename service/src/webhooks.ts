/**
 * webhook 的签名与投递（票据 11，M246）。
 * - 签名密钥：每个 webhook 一个，whsec_ 加 43 个 base64url 字符，只在注册时显示一次；库里只存用服务密钥（RW_SECRET_KEY）加密的密文；
 * - 签名：RenderWeave-Signature: t=<Unix 秒>,v1=<HMAC-SHA256(签名密钥, "<t>.<正文>") 的十六进制>；每次尝试用发送时的时间戳重签，
 *   接收端核对时间戳在容许范围内，挡住重放；
 * - 投递：接口进程的投递任务领取到期的投递，POST 正文，2xx 算成功，不跟随重定向；失败按指数退避重试，试满次数记失败；
 * - 出站地址：生产只投 https 与公网地址，注册时查 URL，连接时再查解析出的地址（DNS 改指内网也挡住）。本机开发与测试可放开。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { ClaimedDelivery, DeliveryOutcome, ServiceBackend, WebhookAttempt } from './backend.js';
import type { Logger } from './log.js';
import { every } from './periodic.js';

/** 投递的数值：缺省共试 8 次，间隔 1、2、4……64 分钟，约 2 小时后不再试。 */
export interface WebhookConfig {
  /** 隔多久看一次有没有到期的投递，毫秒。 */
  readonly pollMs: number;
  /** 第一次重试前等多久，毫秒；之后每次翻倍。 */
  readonly retryBaseMs: number;
  /** 最多试几次（含第一次）。 */
  readonly maxAttempts: number;
  /** 一次尝试等回答的时间，毫秒。 */
  readonly timeoutMs: number;
  /** 允许 http 与内网、回环地址：只用于本机开发与测试。 */
  readonly allowPrivate: boolean;
}

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = { pollMs: 1_000, retryBaseMs: 60_000, maxAttempts: 8, timeoutMs: 10_000, allowPrivate: false };

/** 第 attempt 次尝试失败后，隔多久再试。 */
export const retryDelayMs = (attempt: number, baseMs: number) => baseMs * 2 ** (attempt - 1);

// —— 签名密钥 ——

const SECRET_PREFIX = 'whsec_';

/** 新的签名密钥与它的前缀（列表里用来认出是哪一个）。 */
export function generateWebhookSecret(): { secret: string; prefix: string } {
  const secret = `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, SECRET_PREFIX.length + 6) };
}

/** 服务密钥：32 字节，环境变量里写成 64 位十六进制。 */
export const SECRET_KEY_SHAPE = /^[0-9a-f]{64}$/;

/** 用服务密钥加密签名密钥（AES-256-GCM），绑定租户：密文挪到别的租户名下解不开。 */
export function sealSecret(key: Uint8Array, tenantId: string, secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(tenantId));
  const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')}`;
}

export function openSecret(key: Uint8Array, tenantId: string, sealed: string): string {
  if (!sealed.startsWith('v1.')) throw new Error('签名密钥的密文格式不认识');
  const bytes = Buffer.from(sealed.slice(3), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(tenantId));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

/** 签名头的值：t=<Unix 秒>,v1=<HMAC-SHA256(签名密钥, "<t>.<正文>")>。 */
export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

// —— 出站地址 ——

/** 不投递的地址：本机、内网、链路本地、运营商 NAT、文档示例、组播与保留段（IPv4 映射的 IPv6 地址按其中的 IPv4 判断）。 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv6');

const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function blockedAddress(address: string): boolean {
  const mapped = MAPPED.exec(address);
  if (mapped) return BLOCKED.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6') || /^::ffff:/i.test(address);
  return true;
}

/** URL 主机名里的 IPv6 地址带方括号。 */
const bareHost = (hostname: string) => (hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname);

/** 注册时检查 URL；不合规时返回说明。 */
export function webhookUrlProblem(raw: string, allowPrivate: boolean): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return 'URL 不合规'; }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return 'webhook 只投递 https 地址';
  if (url.username || url.password) return 'URL 里不能带用户名与密码，接收端用签名认出 RenderWeave';
  if (url.hash) return 'URL 里不能带片段（#）';
  if (allowPrivate) return undefined;
  const host = bareHost(url.hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return `不投递本机地址 ${host}`;
  if (isIP(host) && blockedAddress(host)) return `不投递内网、回环或保留地址 ${host}`;
  return undefined;
}

/** 连接前核对解析出的地址；IP 字面量不经 DNS，另在发送前核对。 */
function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, options, (error, address: string | LookupAddress[], family?: number) => {
      if (error || allowPrivate) return (callback as (...args: unknown[]) => void)(error, address, family);
      const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
      const blocked = addresses.find(blockedAddress);
      if (blocked) return (callback as (...args: unknown[]) => void)(new Error(`地址 ${blocked} 是内网、回环或保留地址，不投递`), address, family);
      (callback as (...args: unknown[]) => void)(null, address, family);
    });
  };
}

// —— 发送 ——

/** 一次尝试的结果：收到的状态码，或没收到回答的原因（说明只写原因，不含正文与密钥）。 */
export interface SendResult { readonly statusCode?: number; readonly error?: string; readonly durationMs: number }

export async function sendDelivery(delivery: ClaimedDelivery, secret: string, options: { readonly timeoutMs: number; readonly allowPrivate: boolean; readonly now: Date }): Promise<SendResult> {
  const started = Date.now();
  const done = (result: Omit<SendResult, 'durationMs'>): SendResult => ({ ...result, durationMs: Date.now() - started });
  let url: URL;
  try { url = new URL(delivery.url); } catch { return done({ error: 'URL 不合规' }); }
  const host = bareHost(url.hostname);
  if (!options.allowPrivate && isIP(host) && blockedAddress(host)) return done({ error: `地址 ${host} 是内网、回环或保留地址，不投递` });
  const body = Buffer.from(delivery.body, 'utf8'), timestamp = Math.floor(options.now.getTime() / 1000);
  const headers = {
    'content-type': 'application/json', 'content-length': String(body.length), 'user-agent': 'RenderWeave-Webhooks/1',
    'renderweave-event-id': delivery.eventId, 'renderweave-event-type': delivery.eventType, 'renderweave-delivery-id': delivery.id,
    'renderweave-attempt': String(delivery.attempts + 1), 'renderweave-signature': signatureHeader(secret, timestamp, delivery.body),
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const finish = (result: Omit<SendResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(done(result));
    };
    const request = send(url, { method: 'POST', headers, agent: false, lookup: guardedLookup(options.allowPrivate) }, (response: IncomingMessage) => {
      // 只看状态码；正文读掉丢弃，不记。
      response.on('data', () => undefined);
      response.on('end', () => finish({ statusCode: response.statusCode ?? 0 }));
      response.on('error', () => finish({ statusCode: response.statusCode ?? 0 }));
    });
    const timer = setTimeout(() => {
      finish({ error: `超时：${options.timeoutMs} ms 内没有收到完整的回答` });
      request.destroy();
    }, options.timeoutMs);
    request.on('error', (error: NodeJS.ErrnoException) => finish({ error: `连接失败：${(error.code ? `${error.code} ` : '') + error.message}`.slice(0, 300) }));
    request.end(body);
  });
}

// —— 投递任务 ——

export interface WebhookDispatcher {
  /** 看一次到期的投递并发送，供测试直接驱动。 */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** 一次领取的投递数；各条并行发送。 */
const BATCH = 10;

/**
 * 定期领取到期的投递并发送（接口进程里，与对账任务并列）。每次尝试都记下；失败的按指数退避排下一次，试满次数记失败。
 * 每次失败记一行警告日志：租户、webhook、投递、第几次与原因，不记正文、URL 与密钥。
 */
export function startWebhookDispatcher(options: {
  readonly backend: ServiceBackend; readonly logger: Logger; readonly secretKey: Uint8Array; readonly config: WebhookConfig; readonly now?: () => Date;
}): WebhookDispatcher {
  const { backend, logger, secretKey, config } = options, now = options.now ?? (() => new Date());
  const attemptOnce = async (delivery: ClaimedDelivery) => {
    const at = now(), attempt = delivery.attempts + 1;
    let result: SendResult;
    try { result = await sendDelivery(delivery, openSecret(secretKey, delivery.tenantId, delivery.secretSealed), { timeoutMs: config.timeoutMs, allowPrivate: config.allowPrivate, now: at }); }
    catch (error) { result = { error: `投递失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 300), durationMs: 0 }; }
    const succeeded = result.statusCode !== undefined && result.statusCode >= 200 && result.statusCode < 300;
    const outcome: DeliveryOutcome = succeeded ? { status: 'succeeded' }
      : attempt >= config.maxAttempts ? { status: 'failed' }
      : { status: 'pending', nextAttemptAt: new Date(now().getTime() + retryDelayMs(attempt, config.retryBaseMs)) };
    const record: WebhookAttempt = { attempt, at: at.toISOString(), durationMs: result.durationMs,
      ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }), ...(result.error ? { error: result.error } : {}) };
    await backend.webhooks.record(delivery, record, outcome);
    if (!succeeded) {
      logger.warn({ tenantId: delivery.tenantId, webhookId: delivery.webhookId, deliveryId: delivery.id, attempt, statusCode: result.statusCode, reason: result.error,
        outcome: outcome.status }, outcome.status === 'failed' ? 'webhook 投递失败，不再重试' : 'webhook 投递失败，稍后重试');
    }
  };
  return every(config.pollMs, async () => {
    try {
      const at = now();
      // 租约比一次尝试的超时长：过了还没记下结果，说明投递任务中途退出了，别的投递任务可以再领。
      const claimed = await backend.webhooks.claim(at, new Date(at.getTime() + config.timeoutMs + 60_000), BATCH);
      await Promise.all(claimed.map((delivery) => attemptOnce(delivery).catch((error) => logger.warn({ err: error, deliveryId: delivery.id }, 'webhook 投递记录失败'))));
    } catch (error) { logger.warn({ err: error }, '领取 webhook 投递失败，下次再试'); }
  });
}
