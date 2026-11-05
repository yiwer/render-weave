/** 静态数据定义的版本（ADR-0028）：引擎与控制台认的写法要相同；发布时版本从哪来。 */
import { describe, expect, it } from 'vitest';
import { parseVersion, versionLabel } from '../console/src/form/schema-version.js';
import { formatSchemaVersion, formatStaticSchemaRef, nextSchemaVersion, parseSchemaVersion, publishStaticSchema, type StaticSchemaEntry } from '../src/engine.js';

const WRITTEN = ['1', '2', 'v2', 'v10', '0', 'v0', '01', 'v01', 'V2', '2026-08', 'v1.2', 'a.1_b-c', 'release', '-a', '.a', '_a', 'UP', 'a b', 'a/b', 'a@b', '中文', '', 'v', 'a'.repeat(64), 'a'.repeat(65), '9'.repeat(30), 'v99999999999999999999'];

describe('版本的写法', () => {
  it('2 与 v2 是同一个编号；字符串照旧项目的 versionTag；不合法的不算', () => {
    expect(parseSchemaVersion(2)).toBe(2);
    expect(parseSchemaVersion('2')).toBe(2);
    expect(parseSchemaVersion('v2')).toBe(2);
    expect(parseSchemaVersion('2026-08')).toBe('2026-08');
    expect(parseSchemaVersion('v1.2')).toBe('v1.2');
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined, {}, [], '', 'UP', '-a', 'a/b', 'a b', '中文', 'a'.repeat(65)]) expect(parseSchemaVersion(bad), String(bad)).toBeUndefined();
  });

  it('控制台认的写法与引擎相同，显示也相同', () => {
    for (const text of WRITTEN) {
      expect(parseVersion(text), text).toBe(parseSchemaVersion(text));
      const version = parseVersion(text);
      if (version !== undefined) expect(versionLabel(version), text).toBe(formatSchemaVersion(version));
    }
    expect(formatStaticSchemaRef({ name: '线路牌', version: 2 })).toBe('线路牌 v2');
    expect(formatStaticSchemaRef({ name: '线路牌', version: '2026-08' })).toBe('线路牌 2026-08');
  });

  it('下一个编号只看编号，字符串版本不算', () => {
    expect(nextSchemaVersion([])).toBe(1);
    expect(nextSchemaVersion(['2026-08'])).toBe(1);
    expect(nextSchemaVersion([1, '2026-08', 5, 'a'])).toBe(6);
  });
});

describe('发布时的版本', () => {
  const document = { dslVersion: 'renderweave-schema/1', name: '问候', displayName: '问候', fields: [{ name: 'text', displayName: '文本', type: 'text' }] };
  const entry = (version: number | string): StaticSchemaEntry => {
    const { published } = publishStaticSchema(document, [], { version });
    return { ref: published!.ref, definition: published!.definition, compiled: published!.compiled };
  };

  it('不写就是下一个编号；写了就用写的，编号可以跳', () => {
    expect(publishStaticSchema(document, []).published?.ref.version).toBe(1);
    expect(publishStaticSchema(document, [entry(1), entry('2026-08')]).published?.ref.version).toBe(2);
    expect(publishStaticSchema(document, [entry(1)], { version: 'v5' }).published?.ref.version).toBe(5);
    const named = publishStaticSchema(document, [entry(1)], { version: '2026-08' }).published!;
    expect(named.ref).toEqual({ name: '问候', version: '2026-08' });
    expect(named.definition['version']).toBe('2026-08');
    expect(named.compiled['title']).toBe('问候 2026-08');
    expect(named.compiled['x-renderweave-static-schema']).toEqual({ name: '问候', version: '2026-08' });
  });

  it('文档里写字符串版本也认；文档里写的编号仍要等于下一个编号', () => {
    expect(publishStaticSchema({ ...document, version: '2026-08' }, []).published?.ref.version).toBe('2026-08');
    expect(publishStaticSchema({ ...document, version: 1 }, []).published?.ref.version).toBe(1);
    expect(publishStaticSchema({ ...document, version: 3 }, []).published).toBeUndefined();
  });

  it('同名已有这个版本不发布；写法不对不发布；不同名称互不影响', () => {
    for (const version of [1, '1', 'v1']) {
      const { published, problems } = publishStaticSchema(document, [entry(1)], { version });
      expect(published, String(version)).toBeUndefined();
      expect(problems[0]?.message).toContain('已经发布过 v1');
    }
    expect(publishStaticSchema(document, [entry('2026-08')], { version: '2026-08' }).problems[0]?.message).toContain('已经发布过 2026-08');
    expect(publishStaticSchema(document, [], { version: 'UP' }).published).toBeUndefined();
    const other = { ...entry('2026-08'), ref: { name: '别的', version: '2026-08' } };
    expect(publishStaticSchema(document, [other], { version: '2026-08' }).published?.ref.version).toBe('2026-08');
  });
});
