import { describe, expect, it } from 'vitest';
import { loadCanvasKit } from '../src/canvaskit.js';
import { readPngInfo } from '../src/index.js';
import { comparePng } from './support/golden.js';

async function solidPng(width: number, height: number, mark?: { x: number; y: number; size: number }): Promise<Uint8Array> {
  const ck = await loadCanvasKit();
  const surface = ck.MakeSurface(width, height)!;
  const paint = new ck.Paint();
  try {
    surface.getCanvas().clear(ck.WHITE);
    if (mark) {
      paint.setColor(ck.BLACK);
      surface.getCanvas().drawRect(ck.XYWHRect(mark.x, mark.y, mark.size, mark.size), paint);
    }
    const image = surface.makeImageSnapshot();
    const bytes = image.encodeToBytes(ck.ImageFormat.PNG, 100)!;
    image.delete();
    return bytes;
  } finally {
    paint.delete();
    surface.dispose();
  }
}

describe('golden 图片对比工具', () => {
  it('相同的图片通过，不生成三联图', async () => {
    const png = await solidPng(40, 20);
    const comparison = await comparePng(png, png);

    expect(comparison).toMatchObject({ passed: true, diffPixels: 0 });
    expect(comparison.triptych).toBeUndefined();
  });

  it('差异超过阈值时不通过，并生成"预期、实际、差异"三联图', async () => {
    const expected = await solidPng(40, 20);
    const actual = await solidPng(40, 20, { x: 5, y: 5, size: 4 });
    const comparison = await comparePng(expected, actual);

    expect(comparison).toMatchObject({ passed: false, diffPixels: 16 });
    expect(readPngInfo(comparison.triptych!)).toMatchObject({ width: 40 * 3 + 8 * 2, height: 20 });
  });

  it('差异在阈值内时通过', async () => {
    const expected = await solidPng(100, 100);
    const actual = await solidPng(100, 100, { x: 0, y: 0, size: 3 });
    const comparison = await comparePng(expected, actual, { channelTolerance: 2, maxDiffRatio: 0.001 });

    expect(comparison).toMatchObject({ passed: true, diffPixels: 9 });
  });

  it('尺寸不同直接不通过', async () => {
    const comparison = await comparePng(await solidPng(40, 20), await solidPng(41, 20));

    expect(comparison).toMatchObject({ passed: false, sameSize: false });
  });
});
