"""独立验证入口，未接入正式 Agent、审核、应用或生产服务。"""
import argparse
import json
import sys
from pathlib import Path

from checker import check_candidate
from sandbox import run_script
from workbook import check_view, read_workbook, region


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    read = sub.add_parser("read")
    read.add_argument("workbook")
    area = sub.add_parser("region")
    area.add_argument("--view", required=True)
    area.add_argument("--sheet", required=True)
    area.add_argument("--range", required=True)
    area.add_argument("--offset", type=int, default=0)
    area.add_argument("--page-size", type=int, default=100)
    run = sub.add_parser("run")
    run.add_argument("--view", required=True)
    run.add_argument("--plan", required=True)
    run.add_argument("--script", required=True)
    run.add_argument("--timeout", type=float, default=10)
    run.add_argument("--cancel-file", help="宿主创建此文件时取消正在执行的容器；不传入容器")
    check = sub.add_parser("check")
    check.add_argument("--view", required=True)
    check.add_argument("--plan", required=True)
    check.add_argument("--candidate", required=True)
    for cmd in (read, area, run, check):
        cmd.add_argument("--out", required=True)
    options = parser.parse_args()
    out = Path(options.out)
    # 不覆盖已有证据，也不覆盖输入文件。
    if out.exists():
        raise ValueError("输出已存在；请使用新的尝试路径")
    status = 0
    if options.command == "read":
        result = read_workbook(Path(options.workbook))
    elif options.command == "region":
        result = region(load(options.view), options.sheet, options.range, options.offset, options.page_size)
    elif options.command == "run":
        view, plan = load(options.view), load(options.plan)
        check_view(view)
        if plan.get("sourceHash") != view["source"]["sha256"]:
            raise ValueError("处理计划与原件不一致")
        result = run_script(Path(options.script).read_text(encoding="utf-8"), {"view": view, "plan": plan}, timeout=options.timeout,
                            cancelled=lambda: bool(options.cancel_file and Path(options.cancel_file).exists()))
        status = 0 if result["status"] == "completed" else 2
    else:
        result = check_candidate(load(options.view), load(options.plan), load(options.candidate))
        status = 0 if result["mechanical"] == "passed" else 2
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("x", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps({"command": options.command, "output": str(out), "exitCode": status}, ensure_ascii=False))
    return status


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, StopIteration) as error:
        print(f"原型拒绝执行：{error}", file=sys.stderr)
        sys.exit(1)
