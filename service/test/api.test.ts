/** 开放 API 用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeApi } from './api-suite.js';

describeApi('内存后端', async () => createMemoryBackend());
