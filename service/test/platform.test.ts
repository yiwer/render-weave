/** 平台管理页的汇总用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describePlatform } from './platform-suite.js';

describePlatform('内存后端', async () => createMemoryBackend());
