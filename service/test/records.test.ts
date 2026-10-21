/** 出图记录的查询、下载、导出与重放跑内存后端与进程内 worker，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeRecords } from './records-suite.js';

describeRecords('内存后端', async () => createMemoryBackend());
