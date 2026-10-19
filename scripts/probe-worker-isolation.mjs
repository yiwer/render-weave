/**
 * 实测 worker 线程能否打断 WASM、能否限制 WASM 内存（ADR-0017）。
 * 用法：node scripts/probe-worker-isolation.mjs
 * 期望：线程在 WASM 死循环中被 terminate；32 MB 的堆上限下仍能申请 1024 MB 的 WebAssembly.Memory。
 */
import { Worker } from 'node:worker_threads';
const spin = Uint8Array.from([0,0x61,0x73,0x6d,1,0,0,0, 1,4,1,0x60,0,0, 3,2,1,0, 7,8,1,4,0x73,0x70,0x69,0x6e,0,0, 0x0a,9,1,7,0,3,0x40,0x0c,0,0x0b,0x0b]);
const code = `
const { parentPort, workerData } = require('node:worker_threads');
if (workerData.kind === 'spin') { const m = new WebAssembly.Instance(new WebAssembly.Module(workerData.bytes)); parentPort.postMessage('spinning'); m.exports.spin(); }
else { const mem = new WebAssembly.Memory({ initial: 1, maximum: 65536 }); mem.grow(16384 - 1); new Uint8Array(mem.buffer).fill(1); parentPort.postMessage('wasm memory MB=' + mem.buffer.byteLength / 1048576); }`;
// 1) terminate a worker stuck in a wasm infinite loop
const w1 = new Worker(code, { eval: true, workerData: { kind: 'spin', bytes: spin } });
await new Promise((r) => w1.once('message', r));
const t0 = Date.now(); setTimeout(async () => { const code1 = await w1.terminate(); console.log('terminate during wasm loop: exit', code1, 'after', Date.now() - t0, 'ms'); }, 200);
await new Promise((r) => w1.once('exit', r));
// 2) resourceLimits vs wasm memory
const w2 = new Worker(code, { eval: true, workerData: { kind: 'mem' }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
w2.on('message', (m) => console.log('resourceLimits 32MB old gen ->', m));
w2.on('error', (e) => console.log('worker error', e.code ?? e.message));
await new Promise((r) => w2.once('exit', r));
