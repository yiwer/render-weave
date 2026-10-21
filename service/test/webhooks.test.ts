/** webhook 用例跑内存后端，进 npm test：投递任务在测试进程里，接收端在本机。 */
import { createMemoryBackend } from '../src/memory.js';
import { describeWebhooks, TEST_WEBHOOK_CONFIG } from './webhooks-suite.js';

describeWebhooks('内存后端', async () => createMemoryBackend(), {
  config: TEST_WEBHOOK_CONFIG, inProcessDispatcher: true, receiverHost: { bind: '127.0.0.1', advertise: '127.0.0.1' },
});
