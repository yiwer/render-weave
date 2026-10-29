// 登录页视频素材工具，在 Chromium 页面里经 http 加载（file:// 不行）：
// - poster(src)：截第 0 帧做封面 JPEG，第 23 版起的封面都是它截的。
// - recut(src)：第 21–22 版用的旧视频剪掉带烧录字幕的人脸特写镜头（第 163–205 帧），重编码为 H.264 并封装成 moov 前置的 MP4。
//   逐帧跳转取画面 + WebCodecs 离线编码，不依赖实时播放，后台标签页里也能跑。帧号只对那支旧视频成立。

const FPS = 24;
const CUT_FROM = 163; // 旧视频人脸特写第一帧
const CUT_TO = 206;   // 旧视频咖啡镜头第一帧

function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}
function full(type, version, flags, ...parts) {
  return box(type, u8(version), u24(flags), ...parts);
}
function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u8 = (n) => Uint8Array.of(n & 255);
const u16 = (n) => Uint8Array.of((n >> 8) & 255, n & 255);
const u24 = (n) => Uint8Array.of((n >> 16) & 255, (n >> 8) & 255, n & 255);
const u32 = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return a; };
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n) => new Uint8Array(n);
const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

function mux({ width, height, avcC, samples, timescale, delta }) {
  const n = samples.length;
  const durTs = n * delta;
  const durMs = Math.round((durTs / timescale) * 1000);
  const build = (mdatOffset) => {
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMs), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
    const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(durTs), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('VideoHandler\0'));
    const vmhd = full('vmhd', 0, 1, zeros(8));
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
    const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), box('avcC', avcC));
    const stsd = full('stsd', 0, 0, u32(1), avc1);
    const stts = full('stts', 0, 0, u32(1), u32(n), u32(delta));
    const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    const stss = full('stss', 0, 0, u32(keys.length), ...keys.map(u32));
    const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
    const stsz = full('stsz', 0, 0, u32(0), u32(n), ...samples.map((s) => u32(s.data.length)));
    const stco = full('stco', 0, 0, u32(1), u32(mdatOffset));
    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const minf = box('minf', vmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, mdia);
    return box('moov', mvhd, trak);
  };
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const probe = build(0);
  const mdatOffset = ftyp.length + probe.length + 8;
  const moov = build(mdatOffset);
  const mdat = box('mdat', ...samples.map((s) => s.data));
  return concat([ftyp, moov, mdat]);
}

export async function recut(src, { bitrate = 4_500_000, gop = 48 } = {}) {
  const blob = await (await fetch(src)).blob();
  const v = document.createElement('video');
  v.muted = true;
  v.src = URL.createObjectURL(blob);
  await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
  const width = v.videoWidth;
  const height = v.videoHeight;
  const total = Math.floor(v.duration * FPS + 1e-6);
  const indices = [];
  for (let k = 0; k < total; k++) if (k < CUT_FROM || k >= CUT_TO) indices.push(k);

  const samples = [];
  let avcC = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !avcC) avcC = new Uint8Array(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ key: chunk.type === 'key', ts: chunk.timestamp, data });
    },
    error: (e) => { throw e; },
  });
  encoder.configure({ codec: 'avc1.640028', width, height, bitrate, framerate: FPS, avc: { format: 'avc' }, latencyMode: 'quality' });

  const seek = (t) => new Promise((res) => { v.addEventListener('seeked', () => res(), { once: true }); v.currentTime = t; });
  const frameUs = 1e6 / FPS;
  for (let i = 0; i < indices.length; i++) {
    await seek((indices[i] + 0.5) / FPS);
    const frame = new VideoFrame(v, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
    encoder.encode(frame, { keyFrame: i % gop === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
  }
  await encoder.flush();
  encoder.close();
  samples.sort((a, b) => a.ts - b.ts);
  const mp4 = mux({ width, height, avcC, samples, timescale: 24000, delta: 1000 });
  return { mp4, frames: samples.length, keys: samples.filter((s) => s.key).length, width, height, total, avcCBytes: avcC?.length };
}

export async function poster(src, t = 0.02, quality = 0.82) {
  const blob = await (await fetch(src)).blob();
  const v = document.createElement('video');
  v.muted = true;
  v.src = URL.createObjectURL(blob);
  await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
  await new Promise((res) => { v.addEventListener('seeked', () => res(), { once: true }); v.currentTime = t; });
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
}
