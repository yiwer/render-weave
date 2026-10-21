/** Excel 导入跑内存后端与测试进程里的 worker，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeImports } from './imports-suite.js';

describeImports('内存后端', async () => createMemoryBackend());
