"""P03 验证原型：宿主独立重算映射，不执行转换脚本。语义始终待审核。"""
import json
from collections import Counter
from workbook import addresses, check_view, coordinates, digest, encoded


def check_candidate(view, plan, candidate):
    check_view(view)
    errors, expected, traces, used = [], [], [], set()
    def issue(code, **details):
        errors.append({"code": code, **details})
    sheets = {s["id"]: {c["address"]: c for c in s["cells"]} for s in view["sheets"]}
    if plan.get("sourceHash") != view["source"]["sha256"]:
        raise ValueError("处理计划与原件不一致")
    expected_ids = [d["id"] for d in plan["datasets"]]
    if len(expected_ids) != len(set(expected_ids)) or not expected_ids:
        raise ValueError("处理计划的数据集身份为空或重复")

    def extract(dataset_id, sheet, path, refs, mode):
        if mode not in ("copy", "collect"):
            raise ValueError("原型只独立核对 copy 与 collect")
        if not refs or len(refs) != len(set(refs)) or (mode == "copy" and len(refs) != 1):
            raise ValueError("映射源为空、重复或复制规则多源")
        values, actual_refs = [], []
        for ref in refs:
            coordinates(ref)
            used.add((sheet, ref))
            cell = sheets[sheet].get(ref)
            if cell is None or (cell["value"] is None and "formula" not in cell):
                continue
            actual_refs.append(ref)
            if "formula" in cell or cell["kind"] == "error" or cell["displayStatus"] == "unsupported":
                issue("sourceUnresolved", dataset=dataset_id, path=path, sheet=sheet, cell=ref)
            values.append(cell["display"])
        if mode == "copy" and not values:
            issue("sourceMissing", dataset=dataset_id, path=path, sheet=sheet, cells=refs)
        traces.append({"datasetId": dataset_id, "path": path, "sheet": sheet, "cells": actual_refs, "rule": mode})
        return values if mode == "collect" else (values[0] if values else None)

    record_cells = set()
    for spec in plan["datasets"]:
        sheet, data = spec["sheet"], {}
        for field, mapping in spec["fields"].items():
            data[field] = extract(spec["id"], sheet, field, mapping["cells"], mapping["rule"])
        start, end = spec["rows"]
        if not 1 <= start <= end <= 10000:
            raise ValueError("原型记录区间无效或过大")
        records = []
        for row in range(start, end+1):
            record = {}
            current_cells = {(sheet, f"{column}{row}") for m in spec["recordFields"].values() for column in m["columns"]}
            if current_cells & record_cells:
                issue("recordScopeOverlap", dataset=spec["id"], sheet=sheet, row=row)
            record_cells |= current_cells
            for field, mapping in spec["recordFields"].items():
                path = f"stops[{row-start+1}].{field}"
                refs = [f"{col}{row}" for col in mapping["columns"]]
                record[field] = extract(spec["id"], sheet, path, refs, mapping["rule"])
            records.append(record)
        data["stops"] = records
        expected.append({"dataset": {"id": spec["id"], "staticSchema": plan["definition"]}, "data": data})

    all_cells = {(s, a) for s, cells in sheets.items() for a, c in cells.items()
                 if c["value"] is not None or "formula" in c}
    classified = set(used)
    for context in plan.get("context", []):
        if not isinstance(context.get("reason"), str) or not context["reason"].strip():
            raise ValueError("忽略/表头范围必须说明理由")
        if context["sheet"] not in sheets:
            raise ValueError("分类工作表不存在")
        group = {(context["sheet"], a) for a in addresses(context["range"])}
        if group & used:
            issue("classificationConflict", cells=sorted(group & used))
        classified |= group
    for sheet, ref in sorted(all_cells-classified):
        issue("unclassifiedCell", sheet=sheet, cell=ref)
    for part in view.get("issues", []):
        if part["code"] == "unreadParts":
            issue("unreadWorkbookParts", parts=part["parts"])

    if not isinstance(candidate, dict) or set(candidate) != {"datasets", "sources"}:
        issue("candidateShape")
        actual, actual_traces = [], []
    else:
        actual, actual_traces = candidate["datasets"], candidate["sources"]
    if not isinstance(actual, list) or not isinstance(actual_traces, list):
        issue("candidateShape")
        actual, actual_traces = [], []

    def compare(wanted, got, path):
        if type(wanted) is not type(got):
            issue("typeMismatch", path=path, expected=wanted, actual=got)
        elif isinstance(wanted, dict):
            for key in sorted(set(wanted) | set(got)):
                if key not in wanted or key not in got:
                    issue("fieldMismatch", path=f"{path}.{key}", expected=key in wanted, actual=key in got)
                else:
                    compare(wanted[key], got[key], f"{path}.{key}")
        elif isinstance(wanted, list):
            if len(wanted) != len(got):
                issue("countMismatch", path=path, expected=len(wanted), actual=len(got))
            for i, (w, g) in enumerate(zip(wanted, got), 1):
                compare(w, g, f"{path}[{i}]")
        elif wanted != got:
            issue("valueMismatch", path=path, expected=wanted, actual=got)
    compare(expected, actual, "datasets")
    if any(not isinstance(t, dict) for t in actual_traces):
        issue("sourceShape")
    else:
        wanted = Counter(encoded(t) for t in traces)
        got = Counter(encoded(t) for t in actual_traces)
        for entry in sorted((wanted-got).elements()):
            issue("sourceMissingOrWrong", expected=json.loads(entry))
        for entry in sorted((got-wanted).elements()):
            issue("sourceExtraOrWrong", actual=json.loads(entry))
    return {"format": "rw-excel-check-prototype/1", "mechanical": "failed" if errors else "passed",
            "semantic": "needsReview", "engineSchema": "notChecked", "applicable": False,
            "viewHash": view["viewHash"], "planHash": digest(encoded(plan)), "candidateHash": digest(encoded(candidate)),
            "counts": {"datasets": len(expected), "sourceCells": len(all_cells), "classifiedCells": len(all_cells & classified)},
            "issues": errors, "reviewRequired": ["业务区块与字段含义", "排除区域及理由", "目标数据定义的引擎校验"]}
