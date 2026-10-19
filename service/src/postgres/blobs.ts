/**
 * 对象存储（ADR-0018）：只存不可变字节，按 SHA-256 寻址，键在租户前缀下：tenants/<租户>/blobs/sha256/<哈希>。
 * 服务只用 S3 的基础对象操作：读、写、取头信息、列举（M240）。建桶属于部署，由 setup 命令做。
 */
import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Config } from '../config.js';

export interface BlobStore {
  /** 写入一份内容并返回它的 SHA-256；同一租户内相同字节只存一份。 */
  put(tenant: string, bytes: Uint8Array): Promise<string>;
  /** 按哈希读出原始字节，不核对：核对由读取方负责，好让引擎报出各自的完整性问题。 */
  get(tenant: string, sha256: string): Promise<Uint8Array>;
  /** 存储可用：能列举租户前缀。 */
  available(): Promise<boolean>;
}

const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** 对象键只由租户 ID 与哈希生成，客户端不能提交键或路径（ADR-0018）。 */
export function blobKey(tenant: string, sha256: string): string {
  if (!TENANT.test(tenant)) throw new Error('租户 ID 不合法');
  if (!SHA256.test(sha256)) throw new Error('内容哈希不合法');
  return `tenants/${tenant}/blobs/sha256/${sha256}`;
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // 自建的 S3 兼容存储不一定支持 SDK 缺省附加的流式校验和；完整性由内容哈希保证。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

const notFound = (error: unknown) => {
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return name === 'NotFound' || name === 'NoSuchKey' || $metadata?.httpStatusCode === 404;
};

export function s3Blobs(client: S3Client, bucket: string): BlobStore {
  return {
    async put(tenant, bytes) {
      const sha256 = sha256Hex(bytes), Key = blobKey(tenant, sha256);
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
        if (head.ContentLength === bytes.length) return sha256;
      } catch (error) { if (!notFound(error)) throw error; }
      await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: bytes, ContentLength: bytes.length }));
      return sha256;
    },
    async get(tenant, sha256) {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: blobKey(tenant, sha256) }));
      if (!object.Body) throw new Error(`对象没有内容：${sha256}`);
      return object.Body.transformToByteArray();
    },
    async available() {
      try {
        await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'tenants/', MaxKeys: 1 }));
        return true;
      } catch { return false; }
    },
  };
}
