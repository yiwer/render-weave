"""按显式映射独立重算任意字段结构；不执行候选脚本，不裁定业务语义。"""
import argparse
import datetime as dt
import json
import math
import re
from collections import Counter
from pathlib import Path

from workbook import addresses, check_view, coordinates, digest, encoded

MISSING = object()


def check(view, plan, candidate, target):
    check_view(view)
    if plan.get('format') != 'rw-excel-plan/2' or plan.get('sourceHash') != view['source']['sha256'] or plan.get('definition') != target:
        raise ValueError('计划版本、原件或已固定 staticSchema 不一致')
    if len(encoded(plan)) > 200000:
        raise ValueError('计划超过 200 KB')
    sheets = {s['id']: {c['address']: c for c in s['cells']} for s in view['sheets']}
    issues, traces, used, expected = [], [], set(), []
    budget = 0
    source_budget = 0

    def issue(code, **extra):
        if len(issues) < 200:
            issues.append({'code': code, **extra})

    def scalar(cell, mode, mapping):
        if 'formula' in cell or cell['kind'] == 'error':
            raise ValueError('公式缓存或错误值未核准')
        if mode == 'number':
            value = cell['value']
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError('number 要求源单元格为数值')
            return value
        if mode == 'boolean':
            value = cell['value']
            if type(value) is bool:
                return value
            choices = mapping.get('values', {})
            if str(value) not in choices or type(choices[str(value)]) is not bool:
                raise ValueError('boolean 源值没有明确的布尔映射')
            return choices[str(value)]
        if mode == 'date':
            value = cell['value']
            if cell['kind'] == 'text' or cell['kind'] == 'date':
                return dt.date.fromisoformat(str(value)).isoformat()
            if cell['numberFormat'] not in ('yyyy-mm-dd', 'yyyy/m/d') or type(value) not in (int, float) or value != int(value):
                raise ValueError('日期数值缺少支持的日期格式')
            if not view['date1904'] and value == 60:
                raise ValueError('不存在的 1900-02-29')
            base = dt.date(1904, 1, 1) if view['date1904'] else dt.date(1899, 12, 31)
            return (base + dt.timedelta(days=int(value)-(1 if not view['date1904'] and value > 60 else 0))).isoformat()
        if mode != 'display' or cell['displayStatus'] == 'unsupported':
            raise ValueError('显示值未知或转换方式不支持')
        return cell['display']

    def evaluate(node, dataset, path, env, depth=0):
        nonlocal budget, source_budget
        budget += 1
        if budget > 20000 or depth > 24 or not isinstance(node, dict):
            raise ValueError('映射规模/深度超限或节点格式错误')
        op = node.get('op')
        if op == 'object':
            fields = node['fields']
            if not isinstance(fields, dict):
                raise ValueError('object.fields 必须为对象')
            result = {}
            for name, child in fields.items():
                value = evaluate(child, dataset, path+'/'+name.replace('~', '~0').replace('/', '~1'), env, depth+1)
                if value is not MISSING:
                    result[name] = value
            return result
        if op == 'array':
            values = [evaluate(n, dataset, path+'/'+str(i), env, depth+1) for i, n in enumerate(node['items'])]
            if any(v is MISSING for v in values):
                raise ValueError('array 不允许省略数组元素')
            return values
        if op == 'rows':
            start, end = node['start'], node['end']
            if type(start) is not int or type(end) is not int or not 1 <= start <= end <= 10000:
                raise ValueError('rows 区间无效')
            name = node.get('index', 'row')
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,30}', name) or name in env:
                raise ValueError('行变量无效或遮蔽外层变量')
            result = [evaluate(node['item'], dataset, path+'/'+str(i), {**env, name: row}, depth+1)
                      for i, row in enumerate(range(start, end+1))]
            if any(v is MISSING for v in result):
                raise ValueError('rows 不允许静默删除记录')
            return result
        if op not in ('cell', 'collect', 'split'):
            raise ValueError('仅支持 object/array/rows/cell/collect/split；未知转换需另行明确')
        sheet = node['sheet']
        refs = [node['cell']] if op in ('cell', 'split') else node['cells']
        if sheet not in sheets or not isinstance(refs, list) or not 1 <= len(refs) <= 1000:
            raise ValueError('工作表或来源列表无效')
        resolved = [re.sub(r'\{([A-Za-z][A-Za-z0-9_]*)\}', lambda m: str(env[m[1]]), ref) for ref in refs]
        source_budget += len(resolved)
        if source_budget > 200000:
            raise ValueError('来源引用总量超过 200000')
        if len(set(resolved)) != len(resolved):
            raise ValueError('同一映射重复来源坐标')
        values, actual_refs = [], []
        for ref in resolved:
            coordinates(ref)
            used.add((sheet, ref))
            cell = sheets[sheet].get(ref)
            if cell is None or (cell['value'] is None and 'formula' not in cell):
                continue
            actual_refs.append(ref)
            try:
                values.append(scalar(cell, node.get('as', 'display'), node))
            except (ValueError, OverflowError) as error:
                issue('sourceUnresolved', datasetId=dataset, path=path, sheet=sheet, cell=ref, message=str(error))
                values.append(None)
        if not values and node.get('omitIfEmpty') is True:
            return MISSING
        if op == 'cell':
            if not values:
                issue('sourceMissing', datasetId=dataset, path=path, sheet=sheet, cells=resolved)
            value = values[0] if values else None
        elif op == 'split':
            separators = node['separators']
            if not isinstance(separators, list) or not 1 <= len(separators) <= 10 or any(not isinstance(s, str) or not 1 <= len(s) <= 4 for s in separators):
                raise ValueError('split 要求明确的短分隔符列表')
            value = [v.strip() for v in re.split('|'.join(map(re.escape, separators)), str(values[0])) if v.strip()] if values else []
        else:
            value = values
        traces.append({'datasetId': dataset, 'path': path, 'sheet': sheet, 'cells': actual_refs, 'rule': op})
        return value

    datasets = plan['datasets']
    if not isinstance(datasets, list) or not 1 <= len(datasets) <= 1000:
        raise ValueError('候选数量无效')
    ids = [d['id'] for d in datasets]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError('候选身份为空或重复')
    for d in datasets:
        value = evaluate(d['value'], d['id'], '', {})
        if not isinstance(value, dict):
            raise ValueError('数据集根值必须为对象')
        expected.append({'dataset': {'id': d['id'], 'staticSchema': target}, 'data': value})
    classified = set(used)
    for context in plan.get('context', []):
        if context['sheet'] not in sheets or not str(context.get('reason', '')).strip():
            raise ValueError('非数据区域必须有存在的工作表和明确理由')
        cells = {(context['sheet'], a) for a in addresses(context['range'])}
        source_budget += len(cells)
        if source_budget > 200000:
            raise ValueError('来源及分类总量超过 200000')
        if cells & used:
            issue('classificationConflict', cells=sorted(cells & used))
        classified |= cells
    all_cells = {(s, a) for s, cells in sheets.items() for a, c in cells.items() if c['value'] is not None or 'formula' in c}
    for s, a in sorted(all_cells-classified):
        issue('unclassifiedCell', sheet=s, cell=a)
    for part in view['issues']:
        if part['code'] == 'unreadParts':
            issue('unreadWorkbookParts', parts=part['parts'])

    def compare(wanted, actual, path):
        # JSON 的整数和小数是同一 number 类型；bool 不是 number。
        both_numbers = type(wanted) in (int, float) and type(actual) in (int, float)
        if type(wanted) is not type(actual) and not both_numbers:
            issue('typeMismatch', path=path, expected=wanted, actual=actual)
        elif isinstance(wanted, dict):
            for key in sorted(set(wanted) | set(actual)):
                if key not in wanted or key not in actual:
                    issue('fieldMismatch', path=path+'/'+key, expected=key in wanted, actual=key in actual)
                else:
                    compare(wanted[key], actual[key], path+'/'+key)
        elif isinstance(wanted, list):
            if len(wanted) != len(actual):
                issue('countMismatch', path=path, expected=len(wanted), actual=len(actual))
            for i, (w, a) in enumerate(zip(wanted, actual)):
                compare(w, a, path+'/'+str(i))
        elif wanted != actual:
            issue('valueMismatch', path=path, expected=wanted, actual=actual)
    if not isinstance(candidate, dict) or set(candidate) != {'datasets', 'sources'} or not isinstance(candidate['sources'], list):
        issue('candidateShape')
    else:
        compare(expected, candidate['datasets'], '/datasets')
        wanted, actual = Counter(encoded(t) for t in traces), Counter(encoded(t) for t in candidate['sources'])
        for t in (wanted-actual).elements():
            issue('sourceMissingOrWrong', expected=json.loads(t))
        for t in (actual-wanted).elements():
            issue('sourceExtraOrWrong', actual=json.loads(t))
    return {'format': 'rw-excel-generic-check/1', 'mechanical': 'failed' if issues else 'passed',
            'semantic': 'needsReview', 'applicable': False, 'issues': issues,
            'viewHash': view['viewHash'], 'planHash': digest(encoded(plan)), 'candidateHash': digest(encoded(candidate)),
            'counts': {'datasets': len(expected), 'sourceCells': len(all_cells), 'classifiedCells': len(all_cells & classified)}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('view', 'plan', 'candidate', 'target', 'out'):
        parser.add_argument('--'+name, required=True)
    args = parser.parse_args()
    def load(path):
        return json.loads(Path(path).read_text(encoding='utf-8'))
    try:
        result = check(load(args.view), load(args.plan), load(args.candidate), load(args.target)['selected']['ref'])
    except (ValueError, TypeError, KeyError, IndexError, OverflowError) as error:
        result = {'mechanical': 'failed', 'semantic': 'needsReview', 'applicable': False,
                  'issues': [{'code': 'invalidPlan', 'message': str(error)}]}
    with Path(args.out).open('x', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, allow_nan=False, indent=2)
