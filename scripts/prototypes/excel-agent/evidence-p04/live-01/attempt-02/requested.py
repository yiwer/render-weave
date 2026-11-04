import datetime
import json
import re

with open("input.json", encoding="utf-8") as f:
    inp = json.load(f)

plan = inp["plan"]
cells = {}
for sheet in inp["view"]["sheets"]:
    for c in sheet["cells"]:
        cells[(sheet["id"], c["address"])] = c

MISSING = object()
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SLASH = re.compile(r"^(\d{4})/(\d{1,2})/(\d{1,2})$")
EPOCH = datetime.date(1899, 12, 30)


def esc(name):
    return name.replace("~", "~0").replace("/", "~1")


def blank(c):
    return c is None or c.get("value") is None or c.get("value") == ""


def split_list(text, seps):
    parts = [text]
    for sep in seps:
        parts = [p for part in parts for p in part.split(sep)]
    return [p.strip() for p in parts if p.strip()]


def to_date(c, addr):
    v = c["value"]
    if c.get("kind") == "text":
        m = SLASH.match(v)
        if m:
            return datetime.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
        if ISO.match(v):
            return datetime.date.fromisoformat(v).isoformat()
    elif c.get("kind") == "number" and c.get("numberFormat") in ("yyyy/m/d", "yyyy-mm-dd") and float(v).is_integer():
        return (EPOCH + datetime.timedelta(days=int(v))).isoformat()
    raise ValueError(f"{addr} 无法转换为日期")


def leaf_value(node, c, addr):
    as_ = node.get("as", "display")
    kind = c.get("kind")
    v = c["value"]
    if as_ == "display":
        if c.get("displayStatus") != "known":
            raise ValueError(f"{addr} 显示值不可用")
        return c["display"]
    if as_ == "number" and kind == "number":
        return v
    if as_ == "boolean":
        if kind == "boolean":
            return v
        if kind == "text" and v in node.get("values", {}):
            return node["values"][v]
    if as_ == "date":
        return to_date(c, addr)
    raise ValueError(f"{addr} 类型 {as_} 与源值 {kind} 不匹配")


def take(node, env, path, sources, ds_id):
    op = node["op"]
    refs = node["cells"] if op == "collect" else [node["cell"]]
    coords = []
    values = []
    for ref in refs:
        addr = ref.format(**env)
        c = cells.get((node["sheet"], addr))
        if blank(c):
            continue
        coords.append(addr)
        values.append(leaf_value(node, c, addr))
    if op == "split":
        values = split_list(values[0], node["separators"]) if values else []
        value = values
    elif op == "collect":
        value = values
    else:
        value = values[0] if values else None
    if not values:
        if node.get("omitIfEmpty"):
            return MISSING
        raise ValueError(f"{path} 必填来源为空")
    sources.append({"datasetId": ds_id, "path": path, "sheet": node["sheet"], "cells": coords, "rule": op})
    return value


def ev(node, env, path, sources, ds_id):
    op = node["op"]
    if op == "object":
        out = {}
        for name, child in node["fields"].items():
            v = ev(child, env, path + "/" + esc(name), sources, ds_id)
            if v is not MISSING:
                out[name] = v
        return out
    if op == "array":
        out = []
        for child in node["items"]:
            v = ev(child, env, path + "/" + str(len(out)), sources, ds_id)
            if v is not MISSING:
                out.append(v)
        return out
    if op == "rows":
        name = node.get("index", "row")
        if name in env:
            raise ValueError(f"rows 变量 {name} 遮蔽外层变量")
        out = []
        for r in range(node["start"], node["end"] + 1):
            v = ev(node["item"], {**env, name: r}, path + "/" + str(len(out)), sources, ds_id)
            if v is not MISSING:
                out.append(v)
        return out
    if op in ("cell", "collect", "split"):
        return take(node, env, path, sources, ds_id)
    raise ValueError(f"未知节点 {op}")


definition = plan["definition"]
ref = {"name": definition["name"], "version": definition["version"]}
datasets = []
sources = []
for entry in plan["datasets"]:
    data = ev(entry["value"], {}, "", sources, entry["id"])
    datasets.append({"dataset": {"id": entry["id"], "staticSchema": ref}, "data": data})

with open("candidate.json", "w", encoding="utf-8") as f:
    json.dump({"datasets": datasets, "sources": sources}, f, ensure_ascii=False, indent=2)
