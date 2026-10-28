/** 审计的内容哈希与导出用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeAudit } from './audit-suite.js';

describeAudit('内存后端', async () => createMemoryBackend());
