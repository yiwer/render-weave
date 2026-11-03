"""从 CLI 验证通用结构、类型、来源和失败边界；不调用模型。"""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from workbook import digest, encoded

HERE = Path(__file__).resolve().parent


class GenericContract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.target = {'selected': {'ref': {'name': 'inventory', 'version': 7}}}
        def cell(a, value, kind='text', fmt='General', shown=None):
            return {'address': a, 'value': value, 'kind': kind, 'numberFormat': fmt,
                    'display': str(value) if shown is None else shown, 'displayStatus': 'known'}
        self.view = {'source': {'sha256': 'fixed'}, 'date1904': False, 'issues': [], 'sheets': [{'id': 's', 'cells': [
            cell('A1', '设备'), cell('A2', '主机'), cell('A3', '终端'), cell('B2', 2, 'number'), cell('B3', 3.5, 'number'),
            cell('C2', '是'), cell('C3', False, 'boolean'), cell('D2', '甲、甲,乙'), cell('D3', ''),
            cell('E2', 46356, 'number', 'yyyy/m/d'), cell('E3', '2026-11-05'),
        ]}]}
        self.view['viewHash'] = digest(encoded(self.view))
        fields = {
            'label': {'op': 'cell', 'sheet': 's', 'cell': 'A{r}'},
            'count': {'op': 'cell', 'sheet': 's', 'cell': 'B{r}', 'as': 'number'},
            'enabled': {'op': 'cell', 'sheet': 's', 'cell': 'C{r}', 'as': 'boolean', 'values': {'是': True}},
            'tags': {'op': 'split', 'sheet': 's', 'cell': 'D{r}', 'separators': ['、', ',']},
            'expires': {'op': 'cell', 'sheet': 's', 'cell': 'E{r}', 'as': 'date'},
            'optional': {'op': 'cell', 'sheet': 's', 'cell': 'F{r}', 'omitIfEmpty': True},
        }
        self.plan = {'format': 'rw-excel-plan/2', 'sourceHash': 'fixed', 'definition': self.target['selected']['ref'],
                     'datasets': [{'id': 'inventory-a', 'value': {'op': 'object', 'fields': {
                         'inventory': {'op': 'object', 'fields': {'entries': {'op': 'rows', 'start': 2, 'end': 3, 'index': 'r', 'item': {'op': 'object', 'fields': fields}}}}
                     }}}], 'context': [{'sheet': 's', 'range': 'A1', 'reason': '表头'}]}
        self.candidate = {'datasets': [{'dataset': {'id': 'inventory-a', 'staticSchema': self.target['selected']['ref']}, 'data': {'inventory': {'entries': [
            {'label': '主机', 'count': 2, 'enabled': True, 'tags': ['甲', '甲', '乙'], 'expires': '2026-11-30'},
            {'label': '终端', 'count': 3.5, 'enabled': False, 'tags': [], 'expires': '2026-11-05'},
        ]}}}], 'sources': []}
        for i, row in enumerate((2, 3)):
            for field, col in [('label', 'A'), ('count', 'B'), ('enabled', 'C'), ('tags', 'D'), ('expires', 'E')]:
                self.candidate['sources'].append({'datasetId': 'inventory-a', 'path': f'/inventory/entries/{i}/{field}', 'sheet': 's', 'cells': [f'{col}{row}'], 'rule': 'split' if field == 'tags' else 'cell'})

    def invoke(self):
        args = []
        for name in ('view', 'plan', 'candidate', 'target'):
            file = self.root/(name+'.json')
            file.write_text(json.dumps(getattr(self, name), ensure_ascii=False), encoding='utf-8')
            args += ['--'+name, str(file)]
        out = self.root/'result.json'
        response = subprocess.run([sys.executable, '-X', 'utf8', str(HERE/'generic_check.py'), *args, '--out', str(out)], capture_output=True, timeout=5)
        self.assertEqual(response.returncode, 0, response.stderr)
        return json.loads(out.read_text(encoding='utf-8'))

    def test_nested_schema_and_types(self):
        result = self.invoke()
        self.assertEqual(result['mechanical'], 'passed', result)
        self.assertEqual(result['semantic'], 'needsReview')
        self.assertFalse(result['applicable'])

    def test_second_dataset_checked(self):
        extra = copy.deepcopy(self.plan['datasets'][0]); extra['id'] = 'inventory-b'; self.plan['datasets'].append(extra)
        self.assertEqual(self.invoke()['mechanical'], 'failed')

    def test_truncated_list(self):
        self.candidate['datasets'][0]['data']['inventory']['entries'][0]['tags'].pop()
        self.assertIn('countMismatch', [x['code'] for x in self.invoke()['issues']])

    def test_wrong_typed_value(self):
        self.candidate['datasets'][0]['data']['inventory']['entries'][0]['count'] = True
        self.assertIn('typeMismatch', [x['code'] for x in self.invoke()['issues']])

    def test_wrong_order(self):
        self.candidate['datasets'][0]['data']['inventory']['entries'].reverse()
        self.assertEqual(self.invoke()['mechanical'], 'failed')

    def test_wrong_target(self):
        self.plan['definition'] = {'name': 'wrong', 'version': 7}
        self.assertEqual(self.invoke()['issues'][0]['code'], 'invalidPlan')

    def test_duplicate_identity(self):
        self.plan['datasets'].append(copy.deepcopy(self.plan['datasets'][0]))
        self.assertEqual(self.invoke()['issues'][0]['code'], 'invalidPlan')

    def test_source_forgery(self):
        self.candidate['sources'][0]['cells'] = ['A3']
        self.assertIn('sourceMissingOrWrong', [x['code'] for x in self.invoke()['issues']])

    def test_unclassified(self):
        self.plan['context'] = []
        self.assertIn('unclassifiedCell', [x['code'] for x in self.invoke()['issues']])

    def test_unknown_operation(self):
        self.plan['datasets'][0]['value'] = {'op': 'eval', 'script': '1'}
        self.assertEqual(self.invoke()['issues'][0]['code'], 'invalidPlan')

    def test_tampered_view(self):
        self.view['sheets'][0]['cells'][0]['value'] = 'changed'
        self.assertEqual(self.invoke()['issues'][0]['code'], 'invalidPlan')


if __name__ == '__main__':
    unittest.main()
