import json
import re
from datetime import date, timedelta

MISSING = object()
DATE_FORMATS = ("yyyy/m/d", "yyyy-mm-dd")

with open("input.json", encoding="utf-8") as f:
    payload = json.load(f)

plan = payload["plan"]
cells = {}
for sheet in payload["view"]["sheets"]:
    for c in sheet["cells"]:
        cells[(sheet["id"], c["address"])] = c

sources = []
current = {"dataset": None}


def esc(name):
    return str(name).replace("~", "~0").replace("/", "~1")


def render(template, env):
    return re.sub(r"\{(\w+)\}", lambda m: str(env[m.group(1)]), template)


def is_empty(c):
    return c is None or c.get("displayStatus") == "empty" or c.get("value") in (None, "")


def get_cell(sheet, address):
    # 视图只列出非空单元格，缺失坐标视为空
    return cells.get((sheet, address))


def convert(c, as_, values, where):
    value = c.get("value")
    if as_ == "display":
        if c.get("displayStatus") != "known":
            raise ValueError(f"{where}: display status {c.get('displayStatus')}")
        return c["display"]
    if as_ == "number":
        if c.get("kind") != "number":
            raise ValueError(f"{where}: number needs a numeric cell")
        return value
    if as_ == "boolean":
        if c.get("kind") == "boolean":
            return value
        if c.get("kind") == "text" and value in values:
            return values[value]
        raise ValueError(f"{where}: unmapped boolean {value!r}")
    if as_ == "date":
        if c.get("kind") == "number" and c.get("numberFormat") in DATE_FORMATS:
            if float(value) != int(value):
                raise ValueError(f"{where}: date serial is not an integer")
            return (date(1899, 12, 30) + timedelta(days=int(value))).isoformat()
        if c.get("kind") == "text" and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return date.fromisoformat(value).isoformat()
        raise ValueError(f"{where}: unsupported date cell")
    raise ValueError(f"{where}: unknown as {as_}")


def record(path, sheet, addresses, rule):
    sources.append({"datasetId": current["dataset"], "path": path, "sheet": sheet, "cells": addresses, "rule": rule})


def evaluate(node, env, path):
    op = node["op"]
    if op == "object":
        out = {}
        for name, child in node["fields"].items():
            value = evaluate(child, env, path + "/" + esc(name))
            if value is not MISSING:
                out[name] = value
        return out
    if op == "array":
        out = []
        for child in node["items"]:
            value = evaluate(child, env, path + "/" + str(len(out)))
            if value is not MISSING:
                out.append(value)
        return out
    if op == "rows":
        index = node.get("index", "row")
        if index in env:
            raise ValueError(f"{path}: row variable {index} shadows an outer variable")
        out = []
        for row in range(node["start"], node["end"] + 1):
            child_env = dict(env)
            child_env[index] = row
            value = evaluate(node["item"], child_env, path + "/" + str(len(out)))
            if value is not MISSING:
                out.append(value)
        return out
    if op == "cell":
        address = render(node["cell"], env)
        c = get_cell(node["sheet"], address)
        if is_empty(c):
            if node.get("omitIfEmpty"):
                return MISSING
            raise ValueError(f"{path}: required cell {node['sheet']}!{address} is empty")
        value = convert(c, node.get("as", "display"), node.get("values", {}), path)
        record(path, node["sheet"], [address], "cell")
        return value
    if op == "collect":
        out = []
        addresses = []
        for template in node["cells"]:
            address = render(template, env)
            c = get_cell(node["sheet"], address)
            if is_empty(c):
                continue
            out.append(convert(c, node.get("as", "display"), node.get("values", {}), path))
            addresses.append(address)
        if not out:
            return MISSING if node.get("omitIfEmpty") else []
        record(path, node["sheet"], addresses, "collect")
        return out
    if op == "split":
        address = render(node["cell"], env)
        c = get_cell(node["sheet"], address)
        if is_empty(c):
            return MISSING if node.get("omitIfEmpty") else []
        if c.get("displayStatus") != "known":
            raise ValueError(f"{path}: split source display status {c.get('displayStatus')}")
        pattern = "|".join(re.escape(s) for s in node["separators"])
        items = [p.strip() for p in re.split(pattern, c["display"])]
        items = [p for p in items if p]
        record(path, node["sheet"], [address], "split")
        return items
    raise ValueError(f"{path}: unknown op {op}")


datasets = []
for ds in plan["datasets"]:
    current["dataset"] = ds["id"]
    data = evaluate(ds["value"], {}, "")
    datasets.append({
        "dataset": {
            "id": ds["id"],
            "staticSchema": {"name": plan["definition"]["name"], "version": plan["definition"]["version"]},
        },
        "data": data,
    })

with open("candidate.json", "w", encoding="utf-8") as f:
    json.dump({"datasets": datasets, "sources": sources}, f, ensure_ascii=False, indent=2)
