/**
 * 两张预览图逐像素比对（模板设计页票据 19：提取为子模板之后图要和之前一样）。
 * 原文相同直接算相同；否则在画布上解码，数 RGBA 有任何一个通道不同的像素。尺寸不同算全部不同。
 */
async function pixelsOf(source: string): Promise<ImageData> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export async function differentPixels(a: string, b: string): Promise<number> {
  if (a === b) return 0;
  const [x, y] = await Promise.all([pixelsOf(a), pixelsOf(b)]);
  if (x.width !== y.width || x.height !== y.height) return Math.max(x.width * x.height, y.width * y.height);
  let count = 0;
  for (let index = 0; index < x.data.length; index += 4) {
    if (x.data[index] !== y.data[index] || x.data[index + 1] !== y.data[index + 1] || x.data[index + 2] !== y.data[index + 2] || x.data[index + 3] !== y.data[index + 3]) count++;
  }
  return count;
}
