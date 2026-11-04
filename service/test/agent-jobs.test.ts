import { createMemoryBackend } from '../src/memory.js';
import { describeAgentJobs } from './agent-jobs-suite.js';
describeAgentJobs('数据集导入（内存后端）', async () => createMemoryBackend());
