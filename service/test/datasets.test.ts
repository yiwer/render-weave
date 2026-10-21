/** 数据集接口跑内存后端与进程内 worker，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeDatasets } from './datasets-suite.js';

describeDatasets('内存后端', async () => createMemoryBackend(), { inProcessWorker: true });
