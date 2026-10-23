/**
 * 审核页的预览（M52）：由 RenderWeave 按出图请求重新渲染，不用 Agent 自己的图片。
 * 用草稿模式：问题处画框，缺失的值用占位代替（M46）。DPI 按示例图的像素宽度定，便于并排对照；上限 300 DPI、最长边 4000 像素。
 * 结果按输入的哈希缓存在轮次目录的 previews/ 下，同样的输入不重复渲染。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadCanvasKit } from '../canvaskit.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { render } from '../render.js';
import { rendererBuildId } from '../renderer-build.js';
import { isRecord } from '../util.js';
import type { Workspace } from '../workspace.js';
import { assessRendering, type RenderAssessment } from './assessment.js';
import { trackResources } from './content-identity.js';
import { sha256 } from './round-files.js';

export const PREVIEW_DIR = 'previews';
const MAX_DPI = 300;
const MIN_DPI = 50;
const MAX_SIDE_PX = 4000;

export interface PreviewView {
  /** 出图请求，数据集为候选时写成 { "candidate": 候选文件 }。 */
  readonly request: Record<string, unknown>;
  /** 预览图在轮次目录中的位置；请求无法渲染时没有。 */
  readonly image?: string;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly dpi?: number;
  readonly problems: readonly Problem[];
  /** 严重问题是否阻止审核通过：模板辅助设计是；数据集提取的预览用已保存的模板，只作参考。 */
  readonly blocking: boolean;
  readonly assessment?: RenderAssessment;
}

let build: Promise<string> | undefined;

export async function renderPreview(options: {
  readonly roundDir: string;
  readonly workspace: Workspace;
  /** 要渲染的请求；mode、format 与 dpi 由这里决定。 */
  readonly request: Record<string, unknown>;
  /** 展示用的请求。 */
  readonly shown: Record<string, unknown>;
  readonly sample: Uint8Array;
  /** 参与渲染、又不在工作区快照中的内容（审核后的候选），计入缓存键。 */
  readonly inputs: unknown;
  readonly blocking: boolean;
}): Promise<PreviewView> {
  const output = isRecord(options.request['output']) ? { ...options.request['output'] } : {};
  const width = Number(output['width']), height = Number(output['height']);
  if (width > 0 && height > 0) output['dpi'] = await previewDpi(options.sample, width, height);
  output['format'] = 'png';
  const request = { ...options.request, mode: 'draft', output };
  build ??= rendererBuildId();
  const key = createHash('sha256').update(JSON.stringify({ request, inputs: options.inputs, build: await build })).digest('hex');
  const image = `${PREVIEW_DIR}/${key}.png`, meta = join(options.roundDir, PREVIEW_DIR, `${key}.json`);
  try {
    const cached = JSON.parse(await readFile(meta, 'utf8')) as Omit<PreviewView, 'request' | 'blocking'> & { resourceIds: string[]; missingResourceIds?: string[]; imageSha256?: string };
    if (!Array.isArray(cached.resourceIds)) throw new Error('旧预览没有资源读取记录');
    for (const id of cached.missingResourceIds ?? []) if (options.workspace.resources.get(id)) throw new Error('先前缺失的资源出现，重新检查');
    for (const id of cached.resourceIds) {
      try { await options.workspace.resources.read(id); }
      catch (error) {
        // 原核准图保留在磁盘；不把损坏输入渲染成的占位图覆写到同一身份上。
        const problems = [severe(ProblemCodes.resourceUnreadable, { kind: 'input', source: `res:${id}` }, `固定资源 ${id} 无法核对：${String(error)}`)];
        return { request: options.shown, problems, blocking: options.blocking, assessment: assessRendering(problems, false, options.blocking) };
      }
    }
    if (cached.image && sha256(await readFile(join(options.roundDir, cached.image))) !== cached.imageSha256) throw new Error('缓存图片已损坏');
    return { request: options.shown, ...cached, blocking: options.blocking,
      assessment: assessRendering(cached.problems, !!cached.image, options.blocking) };
  } catch {
    // 没有缓存：渲染一次。
  }
  const tracked = trackResources(options.workspace.resources);
  const result = await render({ ...options.workspace, resources: tracked.repository }, request);
  const view = {
    ...(result.image ? { image, widthPx: result.image.widthPx, heightPx: result.image.heightPx, dpi: result.image.dpi } : {}),
    problems: result.problems,
    resourceIds: tracked.used().filter(item => item.sha256 !== null).map(item => item.id),
    missingResourceIds: tracked.used().filter(item => item.sha256 === null).map(item => item.id),
    ...(result.image ? { imageSha256: sha256(result.image.bytes) } : {}),
  };
  await mkdir(join(options.roundDir, PREVIEW_DIR), { recursive: true });
  if (result.image) await writeFile(join(options.roundDir, image), result.image.bytes);
  await writeFile(meta, `${JSON.stringify(view, null, 2)}\n`);
  return { request: options.shown, ...view, blocking: options.blocking,
    assessment: assessRendering(view.problems, !!view.image, options.blocking) };
}

/** 让预览与示例图的像素宽度相近：按示例图宽度折算 DPI，不低于 50，不超过 300，最长边不超过 4000 像素。 */
async function previewDpi(sample: Uint8Array, widthMm: number, heightMm: number): Promise<number> {
  const ck = await loadCanvasKit();
  const image = ck.MakeImageFromEncoded(sample);
  const samplePx = image ? image.width() : 0;
  image?.delete();
  const wanted = Math.max(MIN_DPI, Math.round((samplePx * 25.4) / widthMm));
  return Math.max(1, Math.min(wanted, MAX_DPI, Math.floor((MAX_SIDE_PX * 25.4) / Math.max(widthMm, heightMm))));
}
