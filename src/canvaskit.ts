/**
 * CanvasKit 运行时（ADR-0011、M99）。使用 full 构建：默认构建不能编码 JPEG。
 * 整个进程只初始化一次；字体一律从资源仓库显式加载，不使用任何系统字体。
 */
import { createRequire } from 'node:module';
import type { CanvasKit, CanvasKitInitOptions } from 'canvaskit-wasm';

// canvaskit-wasm 是 CommonJS 包，ESM 默认导入得到的就是初始化函数；它的类型声明写成了 ES 默认导出，这里按实际形状标注。
type CanvasKitInit = (options?: CanvasKitInitOptions) => Promise<CanvasKit>;

let instance: Promise<CanvasKit> | undefined;

export function loadCanvasKit(): Promise<CanvasKit> {
  instance ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasm = require.resolve('canvaskit-wasm/bin/full/canvaskit.wasm');
    const { default: init } = (await import('canvaskit-wasm/full')) as unknown as { default: CanvasKitInit };
    return init({ locateFile: () => wasm });
  })();
  return instance;
}
