/** 代建推送用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describePush } from './push-suite.js';

describePush('内存后端', async () => createMemoryBackend());
