"""故障接缝：容器已删除但 Docker attach 不退出，取消仍返回完整结果并结束宿主子进程。"""
import io
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent' / 'excel'))
import sandbox


class StuckAttach:
    def __init__(self):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(b'{}')
        self.stderr = io.BytesIO()
        self.returncode = None
        self.killed = False

    def poll(self):
        return self.returncode

    def wait(self, timeout):
        if not self.killed:
            raise subprocess.TimeoutExpired('docker start --attach', timeout)
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


calls = []


def docker(*args, **kwargs):
    calls.append(args)
    if args[:2] == ('image', 'inspect'):
        return b'sha256:test-image'
    if args[0] == 'inspect':
        return json.dumps([{'HostConfig': {}, 'State': {'ExitCode': 0}}]).encode()
    return b''


proc = StuckAttach()
with patch.object(sandbox, 'docker', docker), patch.object(sandbox.subprocess, 'Popen', return_value=proc):
    result = sandbox.run_script('print("{}")', {}, cancelled=lambda: True)
assert result['status'] == 'cancelled'
assert result['cleanupConfirmed'] is True
assert result['candidate'] is None
assert proc.killed
assert len([call for call in calls if call[:2] == ('rm', '--force')]) == 1
print(json.dumps({'passed': True, 'status': result['status'], 'cleanupConfirmed': True, 'attachKilled': proc.killed}))
