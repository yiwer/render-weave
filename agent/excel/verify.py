"""宿主导入时重读原始工作簿并独立核对；不执行候选 Python。"""
import json
import sys
from pathlib import Path
from workbook import read_workbook
from generic_check import check

root = Path(sys.argv[1])
load = lambda name: json.loads((root/name).read_text(encoding='utf-8'))
view = read_workbook(root/'source.xlsx')
result = check(view, load('plan.json'), load('candidate.json'), load('target.json')['selected']['ref'])
for name, value in [('view.json', view), ('check.json', result)]:
    with (root/name).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
if result['mechanical'] != 'passed':
    print(json.dumps(result['issues'], ensure_ascii=False), file=sys.stderr)
    sys.exit(2)
