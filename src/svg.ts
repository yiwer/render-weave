/** SVG 的封闭加载边界：清理 XML/CSS、显式字体、WASM 归一化与按显示尺寸栅格化。 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { generate, parse, walk } from 'css-tree';
import type { CanvasKit } from 'canvaskit-wasm';
import type { ResourceRepository } from './resources.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ALLOWED_ELEMENTS = new Set(('svg g defs symbol use a title desc metadata switch path rect circle ellipse line polyline polygon ' +
  'text tspan textPath linearGradient radialGradient stop pattern clipPath mask marker image filter ' +
  'feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap ' +
  'feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode ' +
  'feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence style').split(' '));
const localRef = (value: string) => /^#[^\s]+$/.test(value.trim());
const embeddedRaster = (value: string) => /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/\s]*={0,2}$/i.test(value);

/** CSS 必须能完整解析；删除外部 URL、原始未解析片段及所有 at-rule（含字体与样式表导入）。 */
function safeCss(source: string, context: 'stylesheet' | 'declarationList' | 'value'): string | undefined {
  try {
    const tree = parse(source, { context });
    let unsafe = false;
    walk(tree, (node) => {
      if (node.type === 'Raw' || (node.type === 'Url' && !localRef(node.value))) unsafe = true;
    });
    // 单个属性值不允许留下不可解析部分；样式表则逐条保留安全声明。
    if (context === 'value') return unsafe ? undefined : generate(tree);
    walk(tree, {
      visit: 'Atrule', enter(_node, item, list) { list.remove(item); },
    });
    walk(tree, {
      visit: 'Declaration', enter(node, item, list) {
        if (safeCss(generate(node.value), 'value') === undefined) list.remove(item);
      },
    });
    let raw = false;
    walk(tree, (node) => { if (node.type === 'Raw') raw = true; });
    return raw ? undefined : generate(tree);
  } catch { return undefined; }
}

/** 保留内部片段引用与内嵌位图；不打开任何文件、URL 或嵌套 SVG。 */
export function sanitizeSvg(source: string): { xml: string; hasText: boolean } {
  if (/<!DOCTYPE/i.test(source)) throw new Error('SVG 不接受 DOCTYPE 或实体声明');
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(message); } })
    .parseFromString(source, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== SVG_NS)) {
    throw new Error('根元素必须为 SVG');
  }
  if (!root.namespaceURI) root.setAttribute('xmlns', SVG_NS);
  let hasText = false;
  const clean = (element: Element) => {
    if (element.localName === 'text') hasText = true;
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.localName ?? attribute.name;
      const value = attribute.value.trim();
      if (/^on/i.test(name) || attribute.name === 'xml:base' ||
          (name === 'href' && !(localRef(value) || (element.localName === 'image' && embeddedRaster(value))))) {
        element.removeAttributeNode(attribute);
      } else if (name === 'style') {
        element.setAttribute(attribute.name, safeCss(value, 'declarationList') ?? '');
      } else if (!['xmlns', 'id', 'class', 'href'].includes(name) && !attribute.name.startsWith('xmlns:')) {
        // URL 属性也经过 CSS tokenizer，覆盖转义过的 url()。
        if (safeCss(value, 'value') === undefined) element.removeAttributeNode(attribute);
      }
    }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 1) {
        const nested = child as Element;
        if (!ALLOWED_ELEMENTS.has(nested.localName ?? '') || (nested.namespaceURI && nested.namespaceURI !== SVG_NS)) {
          element.removeChild(child);
        } else if (nested.localName === 'style') {
          nested.textContent = safeCss(nested.textContent ?? '', 'stylesheet') ?? '';
          clean(nested);
        } else clean(nested);
      } else if (child.nodeType !== 3 && child.nodeType !== 4) element.removeChild(child);
    }
  };
  clean(root);
  // 只序列化根元素，XML processing instruction（包括外部样式表）不会传给渲染器。
  return { xml: new XMLSerializer().serializeToString(root), hasText };
}

let initialized: Promise<void> | undefined;
function loadResvg(): Promise<void> {
  return initialized ??= readFile(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'))
    .then((bytes) => initWasm(bytes));
}

export interface SvgSource { readonly xml: string; readonly width: number; readonly height: number }

export class SvgLoader {
  private fonts?: Promise<Uint8Array[]>;
  constructor(private readonly repository: ResourceRepository, private readonly fontIds: readonly string[], private readonly ck: CanvasKit) {}

  async load(bytes: Uint8Array): Promise<SvgSource> {
    const safe = sanitizeSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    await loadResvg();
    const fontBuffers = safe.hasText ? await (this.fonts ??= this.loadFonts()) : [];
    if (safe.hasText && fontBuffers.length === 0) throw new Error('SVG 文字需要资源仓库中的可用字体，请配置 svgFonts');
    const svg = new Resvg(safe.xml, { dpi: 96, font: { fontBuffers, loadSystemFonts: false } });
    try {
      // 文字先转换为路径；后续每个显示尺寸无需再次解析字体。
      return { xml: svg.toString(), width: svg.width, height: svg.height };
    } finally { svg.free(); }
  }

  private async loadFonts(): Promise<Uint8Array[]> {
    const buffers: Uint8Array[] = [];
    for (const id of new Set(this.fontIds)) {
      if (this.repository.get(id)?.kind !== 'font') continue;
      try {
        const bytes = await this.repository.read(id);
        const font = this.ck.Typeface.MakeTypefaceFromData(bytes.slice().buffer as ArrayBuffer);
        if (!font) continue;
        font.delete();
        buffers.push(bytes);
      } catch { /* 不可读或损坏的候选跳过，全部不可用时由 load 报元素问题。 */ }
    }
    return buffers;
  }
}

export function rasterizeSvg(source: SvgSource, width: number): Uint8Array {
  const svg = new Resvg(source.xml, { font: { fontBuffers: [], loadSystemFonts: false }, fitTo: { mode: 'width', value: width } });
  try {
    const rendered = svg.render();
    try { return rendered.asPng(); } finally { rendered.free(); }
  } finally { svg.free(); }
}
