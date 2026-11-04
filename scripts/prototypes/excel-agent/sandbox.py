"""P02 验证原型：只经 stdin 传入数据，无宿主卷挂载，导出一个有界 JSON。"""
from __future__ import annotations

import json
import subprocess
import threading
import time
import uuid

from workbook import digest, encoded

# 固定镜像摘要，禁止每次执行时隐式联网拉取 tag。
IMAGE = "python:3.13-slim@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1"
BOOTSTRAP = '''
import json, os, pathlib, stat, subprocess, sys
payload = json.load(sys.stdin)
os.chdir('/work')
pathlib.Path('input.json').write_text(json.dumps(payload['input'], ensure_ascii=False), encoding='utf-8')
pathlib.Path('transform.py').write_text(payload['script'], encoding='utf-8')
os.chmod('input.json', 0o444)
result = subprocess.run([sys.executable, '-I', 'transform.py'], stdin=subprocess.DEVNULL)
if result.returncode != 0:
    sys.exit(2)
path = pathlib.Path('candidate.json')
metadata = path.lstat()
if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1048576:
    raise ValueError('invalid output file')
sys.stdout.buffer.write(path.read_bytes())
'''


def docker(*args, timeout=20):
    result = subprocess.run(["docker", *args], capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[:1500])
    return result.stdout


def run_script(script: str, inputs: dict, *, timeout=10.0, output_limit=1048576, cancelled=lambda: False):
    if not 0.1 <= timeout <= 120 or not 1024 <= output_limit <= 1048576:
        raise ValueError("执行预算超出原型允许范围")
    payload = encoded({"script": script, "input": inputs})
    if len(payload) > 4 * 1024 * 1024:
        raise ValueError("执行输入超过 4 MiB")
    image_id = docker("image", "inspect", IMAGE, "--format", "{{.Id}}").decode().strip()
    name = "rw-excel-proto-" + uuid.uuid4().hex
    # no host mount; /work 和 /tmp 有界 tmpfs，停止时销毁。
    args = ["create", "--name", name, "--label", "renderweave.prototype=excel",
            "--pull=never", "--interactive", "--network=none", "--read-only", "--user=65534:65534",
            "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=128m", "--memory-swap=128m",
            "--cpus=0.5", "--pids-limit=16", "--ulimit", "fsize=1048576:1048576",
            "--ulimit", "nofile=64:64", "--log-driver=none",
            "--tmpfs", "/work:rw,noexec,nosuid,nodev,size=16m,mode=1777",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=4m,mode=1777",
            "--workdir=/work", image_id, "python", "-I", "-c", BOOTSTRAP]
    created = False
    proc = None
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    lock, overflow = threading.Lock(), threading.Event()
    status, inspection, exit_code, cleanup = "failed", {}, None, False
    started = time.monotonic()
    try:
        docker(*args)
        created = True
        inspection = json.loads(docker("inspect", name))[0]
        proc = subprocess.Popen(["docker", "start", "--attach", "--interactive", name],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def collect(pipe, key):
            try:
                while block := pipe.read(4096):
                    with lock:
                        remaining = output_limit - sum(len(v) for v in buffers.values())
                        buffers[key].extend(block[:max(0, remaining)])
                        if len(block) > remaining:
                            overflow.set()
            finally:
                pipe.close()
        def send():
            try:
                proc.stdin.write(payload)
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        readers = [threading.Thread(target=collect, args=(proc.stdout, "stdout"), daemon=True),
                   threading.Thread(target=collect, args=(proc.stderr, "stderr"), daemon=True)]
        for reader in readers:
            reader.start()
        sender = threading.Thread(target=send, daemon=True)
        sender.start()
        while proc.poll() is None:
            if cancelled():
                status = "cancelled"
                break
            if overflow.is_set():
                status = "outputLimit"
                break
            if time.monotonic() - started >= timeout:
                status = "timeout"
                break
            time.sleep(0.02)
        else:
            status = "completed" if proc.returncode == 0 else "failed"
        if proc.poll() is None:
            docker("rm", "--force", name)
            created, cleanup = False, True
            proc.wait(timeout=10)
        for reader in readers:
            reader.join(timeout=5)
        if any(r.is_alive() for r in readers):
            raise RuntimeError("执行输出未完成回收")
        if overflow.is_set():
            status = "outputLimit"
        if created:
            exit_code = json.loads(docker("inspect", name))[0]["State"]["ExitCode"]
            if exit_code != 0:
                status = "failed"
    finally:
        # Ctrl+C、解析失败、超时均回收本任务容器；不清理其他容器。
        if created:
            try:
                docker("rm", "--force", name)
                cleanup = True
            finally:
                if proc is not None and proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=10)
    candidate = None
    if status == "completed":
        try:
            def unique(pairs):
                obj = {}
                for key, value in pairs:
                    if key in obj:
                        raise ValueError("重复 JSON 字段")
                    obj[key] = value
                return obj
            def bad_number(value):
                raise ValueError(f"非法 JSON 数值 {value}")
            candidate = json.loads(bytes(buffers["stdout"]), object_pairs_hook=unique, parse_constant=bad_number)
            if not isinstance(candidate, dict):
                raise ValueError("候选必须为对象")
        except (ValueError, UnicodeError):
            status = "invalidOutput"
    return {"format": "rw-excel-execution-prototype/1", "status": status, "cleanupConfirmed": cleanup,
            "container": name, "imageId": image_id, "image": IMAGE, "scriptHash": digest(script.encode()),
            "inputHash": digest(encoded(inputs)), "outputHash": digest(bytes(buffers["stdout"])),
            "wallMs": round((time.monotonic()-started)*1000), "exitCode": exit_code,
            "limits": {"timeoutSeconds": timeout, "outputBytes": output_limit},
            "isolation": {k: inspection.get("HostConfig", {}).get(k) for k in
                          ("NetworkMode", "ReadonlyRootfs", "Memory", "MemorySwap", "NanoCpus", "PidsLimit", "CapDrop", "SecurityOpt", "Binds", "Tmpfs")},
            "stderr": bytes(buffers["stderr"]).decode("utf-8", "replace"), "candidate": candidate}
