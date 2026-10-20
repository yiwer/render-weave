/** 资源接口跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeResources } from './resources-suite.js';

describeResources('内存后端', async () => createMemoryBackend());
