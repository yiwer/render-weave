/** 发布数据定义草案的用例跑内存后端，进 npm test（不需要 Docker）。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeDefinitionPublish } from './definition-publish-suite.js';

describeDefinitionPublish('内存后端', async () => createMemoryBackend());
