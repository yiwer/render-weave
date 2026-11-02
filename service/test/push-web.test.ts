/** 推送与网页改动共存的用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describePushWeb } from './push-web-suite.js';

describePushWeb('内存后端', async () => createMemoryBackend());
