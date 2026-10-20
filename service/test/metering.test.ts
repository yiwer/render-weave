/** 计量与额度用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeMetering } from './metering-suite.js';

describeMetering('内存后端', async () => createMemoryBackend());
