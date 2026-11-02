/** 数据定义草案的用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeDefinitions } from './definitions-suite.js';

describeDefinitions('内存后端', async () => createMemoryBackend());
