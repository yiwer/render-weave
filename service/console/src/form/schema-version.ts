/**
 * 静态数据定义的版本（ADR-0028）：缺省是编号，也可以是发布时写的字符串。
 * 规则与引擎的 parseSchemaVersion 相同，页面用它提前提示；发布时以服务端为准。
 */
import type { SchemaVersion } from '../types.js';

const NUMBERED = /^v?([1-9][0-9]*)$/, NAMED = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 读一个版本：`2` 与 `v2` 就是编号 2，一个写法只对应一个版本。不合法时 undefined。 */
export function parseVersion(text: string): SchemaVersion | undefined {
  const numbered = NUMBERED.exec(text);
  if (numbered) {
    const number = Number(numbered[1]);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  return NAMED.test(text) ? text : undefined;
}

/** 版本给人看的写法：编号写成 v2，字符串原样。 */
export const versionLabel = (version: SchemaVersion): string => (typeof version === 'number' ? `v${version}` : version);
