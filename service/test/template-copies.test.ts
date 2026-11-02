/** 模板工作副本的用例跑内存后端加进程内 worker，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeTemplateCopies } from './template-copies-suite.js';

describeTemplateCopies('内存后端', async () => createMemoryBackend(), { inProcessWorker: true });
