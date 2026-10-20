/** 模板与草稿预览跑内存后端与进程内 worker，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describePreview } from './preview-suite.js';

describePreview('内存后端', async () => createMemoryBackend(), { inProcessWorker: true });
