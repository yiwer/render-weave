/**
 * 引擎的公开入口（ADR-0017）：服务只经这里调用引擎，引用的是构建好的 dist/index.js。
 * Docker 后端测试把这一处换成引擎源码，与共用的合同用例使用同一份引擎。
 */
export * from '../../dist/index.js';
