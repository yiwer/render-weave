"""从独立 CLI 运行夹具与故障注入；报告不代表真实模型/客户业务验收。"""
import argparse
import copy
import hashlib
import json
import os
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
CLI = HERE / "prototype.py"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    root = Path(args.out).resolve()
    root.mkdir(parents=True, exist_ok=False)
    results = []
    def record(name, passed, evidence=None):
        results.append({"name": name, "passed": bool(passed), "evidence": evidence})
        print(("PASS " if passed else "FAIL ") + name, flush=True)
        save(root / "results.json", {"passed": sum(r["passed"] for r in results), "total": len(results), "cases": results})
    def call(name, command, *options, expected=0, timeout=45):
        destination = root / f"{name}.json"
        response = subprocess.run([sys.executable, "-X", "utf8", str(CLI), command, *map(str, options), "--out", str(destination)],
                                  capture_output=True, timeout=timeout, encoding="utf-8")
        if response.returncode != expected:
            raise AssertionError(f"{name}: exit {response.returncode}, expected {expected}: {response.stderr}")
        return json.loads(destination.read_text(encoding="utf-8")) if destination.exists() else {"error": response.stderr}
    original = HERE / "fixtures" / "route-table.xlsx"
    view = call("view", "read", original)
    view_path = root / "view.json"
    up = {c["address"]: c for c in view["sheets"][0]["cells"]}
    down = {c["address"]: c for c in view["sheets"][1]["cells"]}
    record("双方向不同列组合并范围", view["sheets"][0]["merges"] == ["C4:D4", "E4:F4"] and view["sheets"][1]["merges"] == ["C4:E4", "F4:G4"])
    record("时间原值及显示值并存", up["C5"]["raw"] == "0.2777777777777778" and up["C5"]["display"] == "06:40" and down["E5"]["display"] == "06:55")
    record("完整站名重复值与编码前导零", up["B5"]["value"] == up["B6"]["value"] == "田贝②" and up["G5"]["value"] == "00007")
    record("公式缓存不冒充最新值", any(c.get("formula", {}).get("cache") == "presentUnverified" for c in view["sheets"][2]["cells"]))
    first = call("page1", "region", "--view", view_path, "--sheet", "sheet-1", "--range", "B5:G6", "--page-size", 7)
    second = call("page2", "region", "--view", view_path, "--sheet", "sheet-1", "--range", "B5:G6", "--offset", first["nextOffset"], "--page-size", 7)
    combined = first["items"] + second["items"]
    record("区域分页完整且空格未压缩", first["total"] == 12 and len(combined) == 12 and len({c["address"] for c in combined}) == 12 and next(c for c in combined if c["address"] == "D6")["value"] is None and second["nextOffset"] is None)

    def mutate(name, change):
        destination = root / f"{name}.xlsx"
        with zipfile.ZipFile(original) as source:
            entries = {n: source.read(n) for n in source.namelist()}
        change(entries)
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as target:
            for n, data in entries.items():
                target.writestr(n, data)
        return destination
    def change_tree(entries, name, fn):
        node = ET.fromstring(entries[name])
        fn(node)
        entries[name] = ET.tostring(node, encoding="utf-8", xml_declaration=True)
    def hidden(entries):
        change_tree(entries, "xl/workbook.xml", lambda t: t.find(NS+"sheets")[2].set("state", "hidden"))
        change_tree(entries, "xl/worksheets/sheet1.xml", lambda t: next(r for r in t.iter(NS+"row") if r.get("r") == "6").set("hidden", "1"))
    hidden_view = call("hidden", "read", mutate("hidden", hidden))
    record("隐藏工作表与行仍被盘点", hidden_view["sheets"][2]["state"] == "hidden" and hidden_view["sheets"][0]["hiddenRows"] == [6])
    def missing_cache(entries):
        def change(t):
            c = next(c for c in t.iter(NS+"c") if c.get("r") == "B2")
            for v in list(c.findall(NS+"v")):
                c.remove(v)
        change_tree(entries, "xl/worksheets/sheet3.xml", change)
    missing_view = call("missing-cache", "read", mutate("missing-cache", missing_cache))
    record("缺失公式缓存明确标记", next(c for c in missing_view["sheets"][2]["cells"] if c["address"] == "B2")["formula"]["cache"] == "missing")
    def unknown_format(entries):
        entries["xl/styles.xml"] = entries["xl/styles.xml"].replace(b'hh:mm', b'[h]:mm')
    unknown = call("unknown-format", "read", mutate("unknown-format", unknown_format))
    record("未支持格式不猜显示文本", next(c for c in unknown["sheets"][0]["cells"] if c["address"] == "C5")["displayStatus"] == "unsupported")
    for name, change in [
        ("xml-dtd", lambda e: e.update({"xl/extra.xml": b'<!DOCTYPE x [<!ENTITY x "bad">]><x>&x;</x>'})),
        ("utf16-dtd", lambda e: e.update({"xl/extra.xml": '<!DOCTYPE x [<!ENTITY x "bad">]><x>&x;</x>'.encode("utf-16")})),
        ("utf16be-dtd", lambda e: e.update({"xl/extra.xml": '<!DOCTYPE x [<!ENTITY x "bad">]><x>&x;</x>'.encode("utf-16-be")})),
        ("zip-traversal", lambda e: e.update({"../escape.xml": b'<x/>'})),
        ("zip-budget", lambda e: e.update({"xl/large.xml": b' '*(33*1024*1024)})),
    ]:
        rejected = call(name, "read", mutate(name, change), expected=1)
        record(name + " 被拒绝", "error" in rejected, rejected)

    plan = {"sourceHash": view["source"]["sha256"], "definition": {"name": "prototype-route", "version": 1}, "datasets": [], "context": []}
    for i in (1, 2):
        spec = {"id": f"route-{i}", "sheet": f"sheet-{i}", "rows": [5, 6],
                "fields": {"lineName": {"cells": ["A1"], "rule": "copy"}, "direction": {"cells": ["A2"], "rule": "copy"}},
                "recordFields": {"name": {"columns": ["B"], "rule": "copy"},
                                 "weekdayTimes": {"columns": ["C", "D"] if i == 1 else ["C", "D", "E"], "rule": "collect"},
                                 "fridayTimes": {"columns": ["E", "F"] if i == 1 else ["F", "G"], "rule": "collect"},
                                 "code": {"columns": ["G"] if i == 1 else ["H"], "rule": "copy"}}}
        plan["datasets"].append(spec)
        plan["context"].append({"sheet": f"sheet-{i}", "range": "B4:G4" if i == 1 else "B4:H4", "reason": "人工构造样例的字段表头，语义仍需审核"})
    plan["context"].append({"sheet": "sheet-3", "range": "A1:B2", "reason": "明确排除的样例说明与演示公式，需审核此排除"})
    plan_path = save(root / "plan.json", plan)
    execution = call("execution", "run", "--view", view_path, "--plan", plan_path, "--script", HERE/"transform.py")
    record("容器完成转换并回收", execution["status"] == "completed" and execution["cleanupConfirmed"])
    config = execution["isolation"]
    record("实际容器配置符合限制", config["NetworkMode"] == "none" and config["ReadonlyRootfs"] and not config["Binds"] and config["Memory"] == config["MemorySwap"] == 134217728 and config["PidsLimit"] == 16, config)
    candidate = execution["candidate"]
    candidate_path = save(root / "candidate.json", candidate)
    # 独立手写真值，不从 checker 的输出反推预期。
    expected = [
        {"dataset": {"id": "route-1", "staticSchema": plan["definition"]}, "data": {"lineName": "示例线路", "direction": "上行", "stops": [
            {"name": "田贝②", "weekdayTimes": ["06:40", "06:50"], "fridayTimes": ["07:00", "07:00"], "code": "00007"},
            {"name": "田贝②", "weekdayTimes": ["08:00"], "fridayTimes": ["08:20", "08:30"], "code": "00008"}]}},
        {"dataset": {"id": "route-2", "staticSchema": plan["definition"]}, "data": {"lineName": "示例线路", "direction": "下行", "stops": [
            {"name": "田贝②", "weekdayTimes": ["06:40", "06:50", "06:55"], "fridayTimes": ["07:00", "07:00"], "code": "00007"},
            {"name": "田贝②", "weekdayTimes": ["08:00", "08:10"], "fridayTimes": ["08:20", "08:30"], "code": "00008"}]}}
    ]
    record("两份候选逐值符合独立真值", candidate["datasets"] == expected)
    good = call("check-good", "check", "--view", view_path, "--plan", plan_path, "--candidate", candidate_path)
    record("机械通过不冒充语义通过或可应用", good["mechanical"] == "passed" and good["semantic"] == "needsReview" and good["applicable"] is False, good)
    def engine_check(name, content, expected_exit):
        incoming = save(root / f"{name}-engine-input.json", content)
        destination = root / f"{name}-engine.json"
        completed = subprocess.run(["node", "--import", "tsx", str(HERE / "engine-check.ts"), str(incoming), str(destination)],
                                   cwd=HERE.parents[2], capture_output=True, encoding="utf-8", timeout=30)
        if completed.returncode != expected_exit:
            raise AssertionError(completed.stderr)
        return json.loads(destination.read_text(encoding="utf-8"))
    engine = engine_check("valid", candidate, 0)
    record("现有引擎公开入口逐份校验通过", engine["passed"] and len(engine["results"]) == 2)
    invalid_time = copy.deepcopy(candidate)
    invalid_time["datasets"][1]["data"]["stops"][0]["weekdayTimes"][0] = "99:99"
    rejected_time = engine_check("invalid-time", invalid_time, 2)
    record("第二份候选的非法时刻被引擎拒绝", not rejected_time["passed"] and bool(rejected_time["results"][1]["problems"]))
    replay = call("replay", "run", "--view", view_path, "--plan", plan_path, "--script", HERE/"transform.py")
    record("同输入脚本离线重放字节相同", replay["outputHash"] == execution["outputHash"])
    mutations = [
        ("missing-time", lambda c: c["datasets"][0]["data"]["stops"][0]["weekdayTimes"].pop()),
        ("dedup-time", lambda c: c["datasets"][0]["data"]["stops"][0]["fridayTimes"].pop()),
        ("missing-stop", lambda c: c["datasets"][0]["data"]["stops"].pop()),
        ("wrong-order", lambda c: c["datasets"][0]["data"]["stops"].reverse()),
        ("second-dataset-wrong", lambda c: c["datasets"][1]["data"].update(direction="上行")),
        ("missing-dataset", lambda c: c["datasets"].pop()),
        ("forged-source", lambda c: c["sources"][0].update(cells=["Z999"])),
        ("extra-source", lambda c: c["sources"].append(copy.deepcopy(c["sources"][0]))),
        ("lost-suffix", lambda c: c["datasets"][0]["data"]["stops"][0].update(name="田贝")),
    ]
    for name, mutate_candidate in mutations:
        broken = copy.deepcopy(candidate)
        mutate_candidate(broken)
        path = save(root / f"{name}-candidate.json", broken)
        failure = call(name, "check", "--view", view_path, "--plan", plan_path, "--candidate", path, expected=2)
        record(name + " 被独立检查发现", failure["mechanical"] == "failed" and len(failure["issues"]) > 0, failure["issues"])
    unclassified = copy.deepcopy(plan)
    unclassified["context"].pop()
    path = save(root / "unclassified-plan.json", unclassified)
    failure = call("unclassified", "check", "--view", view_path, "--plan", path, "--candidate", candidate_path, expected=2)
    record("未映射工作表不会静默忽略", any(p["code"] == "unclassifiedCell" for p in failure["issues"]))
    overlapping = copy.deepcopy(plan)
    overlapping["datasets"][1] = copy.deepcopy(overlapping["datasets"][0])
    overlapping["datasets"][1]["id"] = "route-2"
    path = save(root / "overlap-plan.json", overlapping)
    failure = call("overlap", "check", "--view", view_path, "--plan", path, "--candidate", candidate_path, expected=2)
    record("重复消费同一记录区块被发现", any(p["code"] == "recordScopeOverlap" for p in failure["issues"]))
    tampered = copy.deepcopy(view)
    tampered["sheets"][0]["cells"][0]["value"] = "changed"
    path = save(root / "tampered-view.json", tampered)
    rejected = call("tampered", "check", "--view", path, "--plan", plan_path, "--candidate", candidate_path, expected=1)
    record("视图字节改动使旧身份失效", "error" in rejected)
    # 模拟脚本错误→完整反馈→修正重跑。不是一次真实模型观测。
    broken_script = (HERE/"transform.py").read_text(encoding="utf-8").replace('values if rule == "collect"', 'values[:1] if rule == "collect"')
    bug_path = root / "broken-transform.py"
    bug_path.write_text(broken_script, encoding="utf-8")
    buggy_run = call("broken-execution", "run", "--view", view_path, "--plan", plan_path, "--script", bug_path)
    broken_path = save(root / "broken-result.json", buggy_run["candidate"])
    bad = call("broken-feedback", "check", "--view", view_path, "--plan", plan_path, "--candidate", broken_path, expected=2)
    record("可复现脚本缺陷及修复前后差异", len(bad["issues"]) > 0 and good["mechanical"] == "passed", {"before": bad["mechanical"], "after": good["mechanical"]})

    def execute_case(name, script, expected_exit=0, time_limit=10):
        path = root / (name + ".py")
        path.write_text(script, encoding="utf-8")
        return call(name, "run", "--view", view_path, "--plan", plan_path, "--script", path,
                    "--timeout", time_limit, expected=expected_exit)
    os.environ["RW_PROTO_SENTINEL"] = "synthetic-test-secret"
    probe = execute_case("isolation-probe", '''
import json, os, pathlib, socket
r = {'noHostSecret': 'RW_PROTO_SENTINEL' not in os.environ and 'OPEN_CODE_API_KEY' not in os.environ,
     'noDockerSocket': not pathlib.Path('/var/run/docker.sock').exists(), 'nonRoot': os.getuid() != 0}
try:
    pathlib.Path('/etc/rw-probe').write_text('x')
    r['rootReadonly'] = False
except OSError:
    r['rootReadonly'] = True
try:
    socket.create_connection(('1.1.1.1', 443), timeout=1)
    r['networkBlocked'] = False
except OSError:
    r['networkBlocked'] = True
pathlib.Path('candidate.json').write_text(json.dumps(r))
''')
    record("无宿主密钥及套接字、非root、只读根、断网", all(probe["candidate"].values()) and probe["cleanupConfirmed"], probe["candidate"])
    for name, script, kind, seconds in [
        ("timeout", 'while True: pass', "timeout", 3),
        ("huge-output", "import sys\nwhile True: sys.stdout.write('x'*4096); sys.stdout.flush()", "outputLimit", 10),
        ("partial-output", "from pathlib import Path\nPath('candidate.json').write_text('{')\nraise RuntimeError('injected')", "failed", 10),
        ("symlink-output", "import os\nos.symlink('/etc/passwd','candidate.json')", "failed", 10),
        ("invalid-json", "from pathlib import Path\nPath('candidate.json').write_text('{')", "invalidOutput", 10),
        ("memory-budget", "a=bytearray(512*1024*1024)", "failed", 10),
    ]:
        result = execute_case(name, script, 2, seconds)
        record(name + " 停止并回收", result["status"] == kind and result["cleanupConfirmed"] and result["candidate"] is None,
               {k: result[k] for k in ("status", "wallMs", "cleanupConfirmed", "exitCode")})
    process_limit = execute_case("process-budget", '''
import json, pathlib, subprocess, sys
children=[]
blocked=False
try:
    for i in range(40):
        children.append(subprocess.Popen([sys.executable,'-c','import time; time.sleep(20)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
except OSError:
    blocked=True
finally:
    for p in children: p.terminate()
    for p in children: p.wait()
pathlib.Path('candidate.json').write_text(json.dumps({'blocked':blocked,'started':len(children)}))
''')
    record("进程数限制实际触发", process_limit["candidate"]["blocked"] and process_limit["candidate"]["started"] < 16, process_limit["candidate"])
    cancel_file = root / "cancel.signal"
    running_script = root / "wait.py"
    running_script.write_text("while True: pass", encoding="utf-8")
    cancel_output = root / "cancelled.json"
    proc = subprocess.Popen([sys.executable, "-X", "utf8", str(CLI), "run", "--view", str(view_path), "--plan", str(plan_path),
                             "--script", str(running_script), "--cancel-file", str(cancel_file), "--out", str(cancel_output)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    running_seen = False
    try:
        for _ in range(30):
            live = subprocess.run(["docker", "ps", "--filter", "label=renderweave.prototype=excel", "--format", "{{.Names}}"], capture_output=True, timeout=5)
            if live.stdout.strip():
                running_seen = True
                break
            time.sleep(0.1)
        cancel_file.write_text("cancel", encoding="utf-8")
        stdout, stderr = proc.communicate(timeout=20)
        if proc.returncode != 2:
            raise AssertionError(stderr.decode("utf-8", "replace"))
        cancelled = json.loads(cancel_output.read_text(encoding="utf-8"))
        record("运行中取消并回收", running_seen and cancelled["status"] == "cancelled" and cancelled["cleanupConfirmed"],
               {k: cancelled[k] for k in ("status", "cleanupConfirmed", "wallMs")})
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    report = {"format": "rw-excel-prototype-acceptance/1", "passed": sum(r["passed"] for r in results),
              "total": len(results), "realModelRun": False, "productionReady": False,
              "sourceSha256": view["source"]["sha256"], "image": execution["image"], "imageId": execution["imageId"],
              "cases": results}
    report["codeHashes"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                            for p in sorted(HERE.iterdir()) if p.suffix in (".py", ".ts")}
    report["environment"] = {"python": sys.version.split()[0],
                             "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                             "dockerServer": subprocess.check_output(["docker", "version", "--format", "{{.Server.Version}}"], text=True).strip(),
                             "engineBasis": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=HERE.parents[2], text=True).strip(),
                             "packageLockHash": hashlib.sha256((HERE.parents[2]/"package-lock.json").read_bytes()).hexdigest()}
    save(root / "results.json", report)
    data = json.dumps(report, ensure_ascii=False).replace("<", "\\u003c")
    page = '''<!doctype html><html lang="zh"><meta charset="utf-8"><title>Excel 处理验证原型</title>
<style>body{font:16px system-ui;margin:36px auto;max-width:1000px;color:#172334}button{padding:8px;margin:4px;border:1px solid #abc;background:#f2f5f8;cursor:pointer}pre{white-space:pre-wrap;background:#f2f5f8;padding:18px}h1{font-size:26px}</style>
<h1>Excel 处理验证原型</h1><p>查看实际运行的读取、隔离和遗漏检查结果。这是机制验证，尚未调用 Claude，也未完成业务审核或应用。</p>
<p id="summary"></p><div id="buttons"></div><h2 id="title"></h2><pre id="detail"></pre><script>
const report=REPORT;const select=i=>{const c=report.cases[i];document.querySelector('#title').textContent=c.name;document.querySelector('#detail').textContent=JSON.stringify(c,null,2)};
document.querySelector('#summary').textContent=`通过 ${report.passed}/${report.total}；业务语义：待审核；可应用：否`;
report.cases.forEach((c,i)=>{const b=document.createElement('button');b.textContent=(c.passed?'通过：':'失败：')+c.name;b.onclick=()=>select(i);document.querySelector('#buttons').append(b)});select(0);
</script></html>'''.replace("REPORT", data)
    (root / "report.html").write_text(page, encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "total": report["total"], "report": str(root/"report.html")}, ensure_ascii=False))
    return 0 if report["passed"] == report["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
