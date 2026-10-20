/** 批量正式交付跑内存后端与进程内 worker，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeBatches } from './batch-suite.js';

describeBatches('内存后端', async () => createMemoryBackend(), { ownsQueue: true });
