"""独立编写的演示转换脚本，代表 Agent 将来交给执行工具的内容。"""
import json
from pathlib import Path

inputs = json.loads(Path("input.json").read_text(encoding="utf-8"))
view, plan = inputs["view"], inputs["plan"]
sheets = {sheet["id"]: {cell["address"]: cell for cell in sheet["cells"]} for sheet in view["sheets"]}
output = {"datasets": [], "sources": []}
for spec in plan["datasets"]:
    cells = sheets[spec["sheet"]]
    data = {}
    def convert(path, refs, rule):
        nonempty = [r for r in refs if r in cells and cells[r]["value"] is not None]
        values = [cells[r]["display"] for r in nonempty]
        output["sources"].append({"datasetId": spec["id"], "path": path,
                                  "sheet": spec["sheet"], "cells": nonempty, "rule": rule})
        return values if rule == "collect" else values[0] if values else None
    for name, mapping in spec["fields"].items():
        data[name] = convert(name, mapping["cells"], mapping["rule"])
    data["stops"] = []
    for row in range(spec["rows"][0], spec["rows"][1]+1):
        stop = {}
        for name, mapping in spec["recordFields"].items():
            stop[name] = convert(f"stops[{len(data['stops'])+1}].{name}",
                                 [f"{col}{row}" for col in mapping["columns"]], mapping["rule"])
        data["stops"].append(stop)
    output["datasets"].append({"dataset": {"id": spec["id"], "staticSchema": plan["definition"]}, "data": data})
Path("candidate.json").write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
