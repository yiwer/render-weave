"""固定输入交给无网络、无宿主挂载的转换容器；宿主不导入生成脚本。"""
import argparse
import json
from pathlib import Path
from sandbox import run_script
from workbook import check_view

parser = argparse.ArgumentParser(description=__doc__)
for name in ('view', 'plan', 'script', 'out'):
    parser.add_argument('--' + name, required=True)
parser.add_argument('--timeout', type=float, default=10)
parser.add_argument('--cancel-file')
args = parser.parse_args()
view = json.loads(Path(args.view).read_text(encoding='utf-8'))
check_view(view)
plan = json.loads(Path(args.plan).read_text(encoding='utf-8'))
result = run_script(Path(args.script).read_text(encoding='utf-8'), {'view': view, 'plan': plan},
                    timeout=args.timeout, cancelled=lambda: bool(args.cancel_file and Path(args.cancel_file).exists()))
with Path(args.out).open('x', encoding='utf-8') as out:
    json.dump(result, out, ensure_ascii=False, indent=2)
