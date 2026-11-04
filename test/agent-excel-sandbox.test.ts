import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('取消后容器已经删除，卡住的 Docker 附着进程仍会退出并返回完整结果', () => {
  const result = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-X', 'utf8', fileURLToPath(new URL('./support/excel-sandbox-cleanup.py', import.meta.url))], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  expect(JSON.parse(result)).toEqual({ passed: true, status: 'cancelled', cleanupConfirmed: true, attachKilled: true });
});
