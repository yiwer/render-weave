"""P01 验证原型：有界读取 OOXML，保留原文；不是完整 Excel 格式化器。"""
from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import math
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"
VML = "{urn:schemas-microsoft-com:vml}"
XVML = "{urn:schemas-microsoft-com:office:excel}"
OFFICE = "{urn:schemas-microsoft-com:office:office}"
MAX_FILE = 16 * 1024 * 1024
MAX_XML = 32 * 1024 * 1024
MAX_CELLS = 100_000
FORMATS = {0: "General", 1: "0", 2: "0.00", 9: "0%", 10: "0.00%",
           14: "mm-dd-yy", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm", 49: "@"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


def coordinates(address: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]{0,6})", address)
    if not match:
        raise ValueError(f"无效单元格坐标: {address}")
    col = 0
    for letter in match[1]:
        col = col * 26 + ord(letter) - 64
    row = int(match[2])
    if col > 16384 or row > 1048576:
        raise ValueError(f"单元格越界: {address}")
    return row, col


def addresses(area: str, limit=100_000) -> list[str]:
    parts = area.split(":")
    if len(parts) not in (1, 2):
        raise ValueError("无效区域")
    r1, c1 = coordinates(parts[0])
    r2, c2 = coordinates(parts[-1])
    if r2 < r1 or c2 < c1 or (r2-r1+1)*(c2-c1+1) > limit:
        raise ValueError("区域倒置或超出读取上限")
    def letter(n):
        result = ""
        while n:
            n, rem = divmod(n-1, 26)
            result = chr(65+rem) + result
        return result
    return [f"{letter(c)}{r}" for r in range(r1, r2+1) for c in range(c1, c2+1)]


def xml(data: bytes):
    # 先按编码检查，禁止 UTF-16 编码绕过 DTD/实体拒绝；不请求外部资源。
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = data.decode("utf-16")
    elif data.startswith(b"\x00<"):
        text = data.decode("utf-16-be")
    elif data.startswith(b"<\x00"):
        text = data.decode("utf-16-le")
    else:
        text = data.decode("utf-8-sig")
    if "\x00" in text:
        raise ValueError("不支持的 XML 编码或空字符")
    if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
        raise ValueError("XML 含 DTD 或实体声明")
    return ET.fromstring(data)


def text_runs(element):
    if element is None:
        return ""
    # 富文本保留文字，不把注音当作业务文字。
    return "".join(child.text or "" for node in element if node.tag != NS+"rPh"
                   for child in ([node] if node.tag == NS+"t" else node.iter(NS+"t")))


def display(value, kind, fmt, date1904):
    if value is None:
        return None, "empty"
    if kind == "error":
        return str(value), "error"
    if kind in ("text", "boolean", "date"):
        return str(value).lower() if kind == "boolean" else str(value), "known"
    number = float(value)
    if fmt in ("General", "@"):
        # 原始数字写法保留在 raw；这里只承诺值的规范文本，不冒充 Excel 自动显示。
        return str(value), "valueOnly"
    if re.fullmatch(r"0+", fmt) and number >= 0 and number.is_integer():
        return str(int(number)).zfill(len(fmt)), "known"
    if fmt.lower() in ("hh:mm", "h:mm", "hh:mm:ss", "h:mm:ss") and 0 <= number < 1:
        seconds = round(number * 86400) % 86400
        h, rest = divmod(seconds, 3600)
        m, s = divmod(rest, 60)
        hours = f"{h:02d}" if fmt.lower().startswith("hh") else str(h)
        return f"{hours}:{m:02d}" + (f":{s:02d}" if fmt.lower().endswith(":ss") else ""), "known"
    if fmt == "yyyy-mm-dd" and number.is_integer():
        if not date1904 and number == 60:
            return None, "unsupported"  # Excel 虚构的 1900-02-29 不伪造为真实日期。
        base = dt.date(1904, 1, 1) if date1904 else dt.date(1899, 12, 31)
        days = int(number) - (1 if not date1904 and number > 60 else 0)
        try:
            return (base + dt.timedelta(days=days)).isoformat(), "known"
        except OverflowError:
            return None, "unsupported"
    return None, "unsupported"


def related_part(owner, relationship, trees):
    target = relationship.get("Target", "")
    if relationship.get("TargetMode", "Internal") != "Internal" or not target or any(c in target for c in ("\\", ":", "%", "?", "#")):
        raise ValueError("批注/绘图关系不是可读取的内部部件")
    part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.dirname(owner)+"/"+target)
    if not part.startswith("xl/") or ".." in part.split("/") or part not in trees:
        raise ValueError("批注/绘图关系越界或部件不存在")
    return part


def read_comments(part, sheet, trees, claimed):
    """只覆盖传统 SpreadsheetML 批注及纯 Note VML；其余部件仍留在 unreadParts。"""
    rel_file = posixpath.dirname(part)+"/_rels/"+posixpath.basename(part)+".rels"
    relations = list(trees.get(rel_file, []))
    ids = [r.get("Id") for r in relations]
    if len(set(ids)) != len(ids) or any(not i for i in ids):
        raise ValueError("工作表关系身份为空或重复")
    refs = {r.get("Id"): r for r in relations}
    related = {related_part(part, r, trees) for r in relations if r.get("Type") in (REL[1:-1]+"/comments", REL[1:-1]+"/vmlDrawing")}
    comment_rels = [r for r in relations if r.get("Type") == REL[1:-1]+"/comments"]
    if len(comment_rels) > 1:
        raise ValueError("同一工作表有多个批注部件")
    comments, covered = [], set()
    if comment_rels:
        name = related_part(part, comment_rels[0], trees)
        if name in claimed:
            raise ValueError("批注部件被多个工作表复用")
        tree = trees[name]
        if tree.tag != NS+"comments" or any(c.tag not in (NS+"authors", NS+"commentList") for c in tree):
            raise ValueError("不支持的批注结构")
        if len(tree.findall(NS+"authors")) != 1 or len(tree.findall(NS+"commentList")) != 1 or any(c.tag != NS+"comment" for c in tree.find(NS+"commentList")):
            raise ValueError("批注列表结构非法")
        authors = [a.text or "" for a in tree.findall(NS+"authors/"+NS+"author")]
        seen = set()
        for c in tree.findall(NS+"commentList/"+NS+"comment"):
            address = c.get("ref", "")
            coordinates(address)
            author = int(c.get("authorId", "-1"))
            if address in seen or not 0 <= author < len(authors) or len(comments) >= 10000:
                raise ValueError("批注重复、作者无效或数量超限")
            if len(c) != 1 or c[0].tag != NS+"text":
                raise ValueError("批注缺少原文或包含未支持内容")
            seen.add(address)
            comments.append({"cell": address, "text": text_runs(c[0]), "author": authors[author], "part": name})
        covered.add(name)
        claimed.add(name)
    drawings = sheet.findall(NS+"legacyDrawing")
    if len(drawings) > 1:
        raise ValueError("同一工作表有多个 legacyDrawing")
    if drawings:
        relation = refs.get(drawings[0].get(REL+"id"))
        if relation is None or relation.get("Type") != REL[1:-1]+"/vmlDrawing":
            raise ValueError("legacyDrawing 关系缺失或类型错误")
        name = related_part(part, relation, trees)
        if name in claimed:
            raise ValueError("VML 部件被多个工作表复用")
        claimed.add(name)
        anchors = read_note_vml(trees[name], comments, name)
        if anchors is not None:
            for comment in comments:
                comment["vml"] = anchors[comment["cell"]]
            covered.add(name)
    return sorted(comments, key=lambda c: coordinates(c["cell"])), covered, related-covered


def read_note_vml(tree, comments, part):
    # Anchor 是显示框位置，Row/Column 才是批注目标；不能把两者混用。
    allowed = {VML+t for t in ("shape", "shapetype", "stroke", "path", "fill", "shadow", "textbox", "imagedata")}
    allowed |= {OFFICE+t for t in ("shapelayout", "idmap", "lock")}
    allowed |= {XVML+t for t in ("ClientData", "MoveWithCells", "SizeWithCells", "Anchor", "AutoFill", "Row", "Column", "Visible")}
    allowed |= {"div", "{http://www.w3.org/1999/xhtml}div"}
    if tree.tag != "xml" or any(c.tag not in (OFFICE+"shapelayout", VML+"shapetype", VML+"shape") for c in tree):
        return None
    for node in list(tree.iter())[1:]:
        if node.tag not in allowed or any(k.startswith(REL) or k.split("}")[-1] in ("src", "href") for k in node.attrib):
            return None
        if node.tag == VML+"imagedata" and set(node.attrib)-{OFFICE+"title"}:
            return None
        if node.tag == VML+"textbox" and "".join(node.itertext()).strip():
            return None
    shapes = tree.findall(VML+"shape")
    if len(shapes) != len(list(tree.iter(VML+"shape"))):
        return None
    expected = {coordinates(c["cell"]): c["cell"] for c in comments}
    anchors, ids = {}, set()
    for shape in shapes:
        data = shape.findall(XVML+"ClientData")
        if len(data) != 1 or data[0].get("ObjectType") != "Note":
            return None
        data = data[0]
        if any(len(data.findall(XVML+t)) != 1 for t in ("Row", "Column", "Anchor")):
            raise ValueError("VML 批注必须有唯一的 Row/Column/Anchor")
        row, col = int(data.findtext(XVML+"Row")), int(data.findtext(XVML+"Column"))
        address = expected.get((row+1, col+1))
        identity = shape.get("id")
        if not address or address in anchors or not identity or identity in ids:
            raise ValueError("VML 批注锚点错位、重复或图形身份无效")
        anchor = [int(v.strip()) for v in data.findtext(XVML+"Anchor").split(",")]
        if len(anchor) != 8 or any(v < 0 for v in anchor) or max(anchor[0], anchor[4]) >= 16384 or max(anchor[2], anchor[6]) >= 1048576 or anchor[4] < anchor[0] or anchor[6] < anchor[2]:
            raise ValueError("VML 批注显示框锚点无效")
        visibility = data.findall(XVML+"Visible")
        flag = (visibility[0].text or "").strip().lower() if visibility else "false"
        if len(visibility) > 1 or flag not in ("", "true", "t", "1", "false", "f", "0"):
            raise ValueError("VML 批注可见性无效")
        ids.add(identity)
        anchors[address] = {"part": part, "shapeId": identity, "row": row, "column": col, "anchor": anchor,
                            "visible": flag in ("", "true", "t", "1")}
    if len(anchors) != len(comments):
        raise ValueError("VML 批注锚点未完整对应批注")
    return anchors


def read_workbook(path: Path):
    if path.suffix.lower() != ".xlsx":
        raise ValueError("仅支持不超过 16 MiB 的 .xlsx")
    with path.open("rb") as source:
        data = source.read(MAX_FILE+1)
    if len(data) > MAX_FILE:
        raise ValueError("仅支持不超过 16 MiB 的 .xlsx")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [e.filename for e in entries]
        if len(entries) > 2048 or len(set(names)) != len(names):
            raise ValueError("ZIP 部件过多或重复")
        if any(e.flag_bits & 1 or e.file_size > MAX_XML for e in entries):
            raise ValueError("加密或单部件过大")
        if sum(e.file_size for e in entries) > MAX_XML:
            raise ValueError("解压总量超过 32 MiB")
        if any(n.startswith("/") or ".." in n.split("/") or "\\" in n for n in names):
            raise ValueError("ZIP 路径不合法")
        if any("vbaProject" in n for n in names):
            raise ValueError("首期不接受宏工作簿")
        trees = {n: xml(archive.read(n)) for n in names if n.endswith((".xml", ".rels", ".vml"))}
    book = trees["xl/workbook.xml"]
    props = book.find(NS+"workbookPr")
    date1904 = props is not None and props.get("date1904") in ("1", "true")
    rels = {r.get("Id"): r for r in trees["xl/_rels/workbook.xml.rels"]}
    strings = [text_runs(si) for si in trees.get("xl/sharedStrings.xml", [])]
    formats, xfs = dict(FORMATS), [0]
    styles = trees.get("xl/styles.xml")
    if styles is not None:
        formats.update({int(n.get("numFmtId")): n.get("formatCode")
                        for n in styles.findall(NS+"numFmts/"+NS+"numFmt")})
        xfs = [int(n.get("numFmtId", "0")) for n in styles.findall(NS+"cellXfs/"+NS+"xf")]
    sheets, issues = [], []
    unread = {n for n in names if not n.endswith("/") and n.startswith(("xl/drawings/", "xl/media/", "xl/comments", "xl/threadedComments/", "xl/persons/", "xl/externalLinks/"))}
    claimed = set()
    total = 0
    for index, sheet in enumerate(book.findall(NS+"sheets/"+NS+"sheet")):
        rel = rels[sheet.get(REL+"id")]
        if rel.get("TargetMode") == "External" or not rel.get("Type", "").endswith("/worksheet"):
            raise ValueError("工作表类型或关系不支持")
        target = rel.get("Target", "")
        part = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/"+target)
        if not part.startswith("xl/worksheets/"):
            raise ValueError("工作表关系越界")
        tree = trees[part]
        comments, covered, unhandled = read_comments(part, tree, trees, claimed)
        unread -= covered
        unread |= unhandled
        cells, seen = [], set()
        for cell in tree.findall(".//"+NS+"sheetData/"+NS+"row/"+NS+"c"):
            total += 1
            if total > MAX_CELLS:
                raise ValueError("单元格数超限")
            address = cell.get("r", "")
            coordinates(address)
            if address in seen:
                raise ValueError("重复单元格坐标")
            seen.add(address)
            raw = cell.findtext(NS+"v")
            f = cell.find(NS+"f")
            kind = cell.get("t", "n")
            if kind == "s":
                string_index = int(raw)
                if not 0 <= string_index < len(strings):
                    raise ValueError("共享字符串索引越界")
                value, kind = strings[string_index], "text"
            elif kind == "inlineStr":
                value, kind = text_runs(cell.find(NS+"is")), "text"
            elif kind in ("str", "e", "d", "b"):
                value = raw == "1" if kind == "b" and raw is not None else raw
                kind = {"str": "text", "e": "error", "d": "date", "b": "boolean"}[kind]
            elif kind == "n":
                value = float(raw) if raw is not None else None
                if value is not None and not math.isfinite(value):
                    raise ValueError("数值不是有限数")
                if value is not None and value.is_integer() and abs(value) < 2**53:
                    value = int(value)
                kind = "number"
            else:
                raise ValueError(f"不支持的单元格类型 {kind}")
            style = int(cell.get("s", "0"))
            if not 0 <= style < len(xfs):
                raise ValueError("样式索引越界")
            fmt = formats.get(xfs[style], f"builtin:{xfs[style]}")
            shown, state = display(value, kind, fmt, date1904)
            if state == "valueOnly":
                shown = raw  # 规范数值文本不经过 float 转回，保留原始精度。
            entry = {"address": address, "kind": kind, "raw": raw, "value": value,
                     "numberFormat": fmt, "display": shown, "displayStatus": state}
            if f is not None:
                entry["formula"] = {"text": f.text, "attributes": dict(f.attrib),
                                    "cache": "presentUnverified" if raw is not None else "missing"}
                issues.append({"code": "formulaUnverified", "sheet": sheet.get("name"), "cell": address})
            if kind == "error" or state == "unsupported":
                issues.append({"code": "cellError" if kind == "error" else "displayUnsupported",
                               "sheet": sheet.get("name"), "cell": address})
            cells.append(entry)
        merges = [m.get("ref") for m in tree.findall(NS+"mergeCells/"+NS+"mergeCell")]
        for area in merges:
            # 不展开巨大合并区域，仅校验端点。
            points = area.split(":")
            if len(points) != 2 or any(a > b for a, b in zip(coordinates(points[0]), coordinates(points[1]))):
                raise ValueError("无效合并区域")
        dim = tree.find(NS+"dimension")
        sheets.append({"id": f"sheet-{index+1}", "name": sheet.get("name"), "state": sheet.get("state", "visible"),
                       "dimension": dim.get("ref") if dim is not None else None,
                       "merges": merges, "cells": sorted(cells, key=lambda c: coordinates(c["address"])),
                       "comments": comments,
                       "hiddenRows": [int(r.get("r")) for r in tree.findall(NS+"sheetData/"+NS+"row") if r.get("hidden") in ("1", "true")],
                       "hiddenColumns": [dict(c.attrib) for c in tree.findall(NS+"cols/"+NS+"col") if c.get("hidden") in ("1", "true")]})
    if not sheets:
        raise ValueError("工作簿没有可读取的工作表")
    if unread:
        issues.append({"code": "unreadParts", "parts": sorted(unread)})
    view = {"format": "rw-excel-view-prototype/1", "source": {"sha256": digest(data), "bytes": len(data)},
            "reader": "bounded-ooxml/2", "date1904": date1904, "sheets": sheets, "issues": issues}
    view["viewHash"] = digest(encoded(view))
    return view


def check_view(view):
    body = {k: v for k, v in view.items() if k != "viewHash"}
    if digest(encoded(body)) != view.get("viewHash"):
        raise ValueError("视图内容身份不符")


def region(view, sheet_id, area, offset=0, page_size=100):
    check_view(view)
    if offset < 0 or not 1 <= page_size <= 500:
        raise ValueError("分页参数不合法")
    sheet = next(s for s in view["sheets"] if s["id"] == sheet_id)
    selected = addresses(area)
    if offset > len(selected):
        raise ValueError("分页偏移越界")
    lookup = {c["address"]: c for c in sheet["cells"]}
    items = [lookup.get(a, {"address": a, "value": None, "displayStatus": "empty"})
             for a in selected[offset:offset+page_size]]
    end = offset + len(items)
    return {"viewHash": view["viewHash"], "sheet": sheet_id, "range": area, "total": len(selected),
            "offset": offset, "items": items, "nextOffset": end if end < len(selected) else None,
            "merges": sheet["merges"],
            "comments": [c for c in sheet.get("comments", []) if c["cell"] in selected[offset:end]]}


if __name__ == '__main__':
    import argparse
    import sys
    parser = argparse.ArgumentParser(description='有界工作簿及批注读取')
    parser.add_argument('command', choices=['read', 'region'])
    parser.add_argument('--input', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--sheet')
    parser.add_argument('--range')
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--page-size', type=int, default=100)
    args = parser.parse_args()
    try:
        value = read_workbook(Path(args.input)) if args.command == 'read' else region(json.loads(Path(args.input).read_text(encoding='utf-8')), args.sheet, args.range, args.offset, args.page_size)
        with Path(args.out).open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
    except (ValueError, OSError, KeyError, TypeError, ET.ParseError) as error:
        print(f'工作簿读取失败：{error}', file=sys.stderr)
        sys.exit(1)
