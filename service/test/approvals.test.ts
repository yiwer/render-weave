/** 审批策略与发布申请的用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeApprovals } from './approvals-suite.js';

describeApprovals('内存后端', async () => createMemoryBackend());
