/**
 * 审计的差异摘要与 CSV 导出（P1 票据 03，M347、ADR-0022）。
 * - 差异摘要：增删改计数是全部的，路径只留前 AUDIT_DIFF_PATHS 项；计数之和大于路径数，就说明路径列不全。
 * - CSV：列名就是审计接口的字段名，差异的路径写成 JSON；UTF-8 带 BOM、CRLF 换行，Excel 直接打开不乱码。
 *   以 = + - @ 或制表、回车开头的格子前加单引号，Excel 不会把它当公式执行（操作人标签、对象 ID 来自用户输入）。
 */
import type { AuditDiff, AuditDiffPath, AuditEvent } from './backend.js';

export const AUDIT_DIFF_PATHS = 50;

/** 由逐项改动算出差异摘要。 */
export function auditDiff(paths: readonly AuditDiffPath[]): AuditDiff {
  const count = (change: AuditDiffPath['change']) => paths.filter((item) => item.change === change).length;
  return { added: count('added'), removed: count('removed'), changed: count('changed'), paths: paths.slice(0, AUDIT_DIFF_PATHS) };
}

const COLUMNS: readonly [string, (event: AuditEvent) => string | number | boolean | undefined][] = [
  ['id', (event) => event.id],
  ['at', (event) => event.at],
  ['actorKind', (event) => event.actor.kind],
  ['actorId', (event) => event.actor.id],
  ['actorLabel', (event) => event.actor.label],
  ['action', (event) => event.action],
  ['objectType', (event) => event.object.type],
  ['objectId', (event) => event.object.id],
  ['crossTenant', (event) => event.crossTenant],
  ['beforeSha256', (event) => event.beforeSha256],
  ['afterSha256', (event) => event.afterSha256],
  ['diffAdded', (event) => event.diff?.added],
  ['diffRemoved', (event) => event.diff?.removed],
  ['diffChanged', (event) => event.diff?.changed],
  ['diffPaths', (event) => (event.diff ? JSON.stringify(event.diff.paths) : undefined)],
  ['round', (event) => event.round],
  ['reason', (event) => event.reason],
];

function cell(value: string | number | boolean | undefined): string {
  if (value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** 审计事件写成 CSV，顺序照传入的顺序。 */
export function auditCsv(events: readonly AuditEvent[]): string {
  const lines = [COLUMNS.map(([name]) => name).join(','), ...events.map((event) => COLUMNS.map(([, read]) => cell(read(event))).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
