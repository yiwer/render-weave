import { describe, expect, it } from 'vitest';
import { ProblemCodes, loadWorkspace, readJpegDpi, readPngInfo, render, type Problem } from '../src/index.js';
import { M402_IMAGE_IDS, greetingRequest, imageOnlyResources, loadSingleText, m402Dir, resourcesDir, withTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';

const codes = (problems: readonly Problem[]) => problems.map((problem) => problem.code);

describe('渲染入口：一个文本字段从数据集到 PNG', () => {
  it('正常出图：没有问题，PNG 尺寸与 DPI 正确，布局摘要与图片符合预期', async () => {
    const result = await render(await loadSingleText(), greetingRequest());

    expect(result.problems).toEqual([]);
    expect(result.image?.format).toBe('png');
    expect(readPngInfo(result.image!.bytes)).toEqual({ width: 756, height: 189, dpi: 120 });
    await expect(`${JSON.stringify(result.layout, null, 2)}\n`).toMatchFileSnapshot('./snapshots/single-text.layout.json');
    await expectMatchesGolden('single-text', result.image!.bytes);
  });

  it('数据集可以直接附带在渲染请求中，结果与引用工作区数据集相同', async () => {
    const workspace = await loadSingleText();
    const inline = {
      dataset: { staticSchema: { name: '问候', version: 1 } },
      data: { message: '欢迎乘坐 M402 路' },
    };
    const byId = await render(workspace, greetingRequest());
    const byInline = await render(workspace, greetingRequest({ dataset: { inline } }));

    expect(byInline.problems).toEqual([]);
    expect(byInline.layout).toEqual(byId.layout);
    expect(Buffer.compare(Buffer.from(byInline.image!.bytes), Buffer.from(byId.image!.bytes))).toBe(0);
  });

  it('同样的输入两次渲染，布局摘要与图片字节都相同', async () => {
    const workspace = await loadSingleText();
    const first = await render(workspace, greetingRequest());
    const second = await render(workspace, greetingRequest());

    expect(second.layout).toEqual(first.layout);
    expect(Buffer.compare(Buffer.from(second.image!.bytes), Buffer.from(first.image!.bytes))).toBe(0);
  });

  it('毫米按 DPI 四舍五入换算像素：740 × 165 mm、120 DPI 得 3496 × 780 像素（M100）', async () => {
    const result = await render(
      await loadSingleText(),
      greetingRequest({ output: { width: 740, height: 165, dpi: 120, format: 'png' } }),
    );

    expect(result.problems).toEqual([]);
    expect(readPngInfo(result.image!.bytes)).toEqual({ width: 3496, height: 780, dpi: 120 });
    expect(result.layout?.output).toMatchObject({ widthPx: 3496, heightPx: 780 });
  });

  it('JPEG 输出写入 DPI 元数据', async () => {
    const result = await render(
      await loadSingleText(),
      greetingRequest({ output: { width: 160, height: 40, dpi: 300, format: 'jpg' } }),
    );

    expect(result.image?.format).toBe('jpeg');
    expect([result.image!.bytes[0], result.image!.bytes[1]]).toEqual([0xff, 0xd8]);
    expect(readJpegDpi(result.image!.bytes)).toBe(300);
    expect(result.image).toMatchObject({ widthPx: 1890, heightPx: 472 });
  });
});

describe('数据集校验', () => {
  const datasetWith = (data: unknown) => ({ inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data } });

  it('必填字段缺失：严重问题定位到字段；正式出图不输出图片，仍返回布局摘要', async () => {
    const result = await render(await loadSingleText(), greetingRequest({ dataset: datasetWith({}) }));

    expect(result.problems).toEqual([
      {
        code: ProblemCodes.datasetRequiredMissing,
        level: 'severe',
        location: { kind: 'field', path: 'message' },
        message: '必填字段"问候语"（message）缺失',
      },
    ]);
    expect(result.image).toBeUndefined();
    expect(result.layout?.root.children?.[0]?.text?.content).toBe('');
  });

  it('必填字段缺失时，草稿预览仍输出图片', async () => {
    const result = await render(await loadSingleText(), greetingRequest({ dataset: datasetWith({}), mode: 'draft' }));

    expect(codes(result.problems)).toEqual([ProblemCodes.datasetRequiredMissing]);
    expect(result.image?.format).toBe('png');
  });

  it('值为 null、出现未定义的键、超出长度约束都定位到字段路径', async () => {
    const workspace = await loadSingleText();
    const nullValue = await render(workspace, greetingRequest({ dataset: datasetWith({ message: null }) }));
    const unknownKey = await render(workspace, greetingRequest({ dataset: datasetWith({ message: '你好', extra: 1 }) }));
    const tooLong = await render(workspace, greetingRequest({ dataset: datasetWith({ message: '一'.repeat(21) }) }));

    expect(nullValue.problems.map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.datasetNullValue, { kind: 'field', path: 'message' }],
    ]);
    expect(unknownKey.problems.map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.datasetUnknownKey, { kind: 'field', path: 'extra' }],
    ]);
    expect(tooLong.problems.filter((p) => p.location.kind === 'field').map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.datasetConstraintViolated, { kind: 'field', path: 'message' }],
    ]);
  });

  it('M402 草稿目录可直接作为工作区；列表中的字段路径序号从 1 开始，同一字段的格式错误只报一次', async () => {
    const workspace = { ...(await loadWorkspace({ dir: m402Dir, resourcesDir })), resources: imageOnlyResources(M402_IMAGE_IDS) };
    const m402 = workspace.datasets.find((dataset) => dataset.id === 'ds-m402-wanguocheng')!;
    const data = structuredClone(m402.document.data) as Record<string, any>;
    data['firstDeparture'] = '7:30';
    data['stops'][11]['name'] = null;
    const result = await render(workspace, {
      template: '标准线路单边',
      dataset: { inline: { dataset: m402.document.dataset, data } },
      parameters: { currentIndex: 5 },
      output: { width: 740, height: 165, dpi: 120, format: 'png' },
      mode: 'final',
    });

    expect(workspace.problems).toEqual([]);
    expect(result.problems.filter((p) => p.location.kind === 'field').map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.datasetFormatInvalid, { kind: 'field', path: 'firstDeparture' }],
      [ProblemCodes.datasetNullValue, { kind: 'field', path: 'stops[12].name' }],
    ]);
  });

  it('工作区中找不到数据集或其静态数据定义时，不出图并说明原因', async () => {
    const workspace = await loadSingleText();
    const missing = await render(workspace, greetingRequest({ dataset: { id: 'ds-none' } }));
    const unknownSchema = await render(
      workspace,
      greetingRequest({ dataset: { inline: { dataset: { staticSchema: { name: '问候', version: 9 } }, data: {} } } }),
    );

    expect(codes(missing.problems)).toEqual([ProblemCodes.datasetNotFound]);
    expect(codes(unknownSchema.problems)).toEqual([ProblemCodes.staticSchemaNotFound]);
    expect(missing.image).toBeUndefined();
    expect(unknownSchema.image).toBeUndefined();
  });
});

describe('尺寸与模板检查', () => {
  it('实际尺寸超出画板适用尺寸范围：严重问题定位到画板，正式出图不输出图片', async () => {
    const result = await render(
      await loadSingleText(),
      greetingRequest({ output: { width: 1600, height: 40, dpi: 120, format: 'png' } }),
    );

    expect(result.problems).toEqual([
      {
        code: ProblemCodes.renderSizeOutOfRange,
        level: 'severe',
        location: { kind: 'element', path: '问候牌' },
        message: '实际尺寸 1600 × 40 mm 超出模板"问候牌"的适用尺寸范围：宽 50–1500 mm，高 20–200 mm',
      },
    ]);
    expect(result.image).toBeUndefined();
  });

  it('模板内元素名称重复：严重问题以元素路径定位到重复的元素', async () => {
    const workspace = withTemplate(await loadSingleText(), '问候牌', (document) => {
      const children = document['artboard']['children'];
      children.push({ ...children[0], place: { left: 8, top: 26, width: 'hug', height: 'hug' } });
    });
    const result = await render(workspace, greetingRequest());

    expect(result.problems.map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.templateDuplicateElementName, { kind: 'element', path: '问候牌/问候语' }],
    ]);
    expect(result.image).toBeUndefined();
  });

  it('尚未支持的元素类型与未定义的属性返回问题，而不是静默忽略', async () => {
    const workspace = withTemplate(await loadSingleText(), '问候牌', (document) => {
      document['artboard']['children'].push({ type: 'image', name: '底图' });
      document['artboard']['children'][0]['fontWeight'] = 700;
    });
    const result = await render(workspace, greetingRequest());

    expect(result.problems.map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.templateUnknownProperty, { kind: 'element', path: '问候牌/问候语' }],
      [ProblemCodes.templateUnsupported, { kind: 'element', path: '问候牌/底图' }],
    ]);
  });

  it('字体资源不存在：严重问题定位到使用它的文本元素', async () => {
    const workspace = withTemplate(await loadSingleText(), '问候牌', (document) => {
      document['artboard']['children'][0]['font'] = 'res:font-missing';
    });
    const result = await render(workspace, greetingRequest());

    expect(result.problems.map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.resourceNotFound, { kind: 'element', path: '问候牌/问候语' }],
    ]);
  });

  it('自由布局可以距右、距下定位，尺寸可以随内容', async () => {
    const workspace = withTemplate(await loadSingleText(), '问候牌', (document) => {
      document['artboard']['children'][0]['place'] = { right: 5, bottom: 4, width: 'hug', height: 'hug' };
    });
    const result = await render(workspace, greetingRequest());
    const text = result.layout!.root.children![0]!;

    expect(result.problems).toEqual([]);
    // 思源黑体的行框为 em 框（基线上 0.88 em、下 0.12 em），随内容的高度等于字号 10 mm。
    expect(text).toMatchObject({ width: 79.9, height: 10, x: 160 - 5 - 79.9, y: 40 - 4 - 10 });
  });
});

describe('渲染请求', () => {
  it('结构不合法时逐项指出，不出图', async () => {
    const result = await render(await loadSingleText(), {
      template: '问候牌',
      dataset: {},
      output: { width: -1, height: 40, dpi: 120, format: 'gif' },
      mode: 'preview',
    });

    expect(result.problems.map((p) => p.location)).toEqual([
      { kind: 'input', source: 'request.dataset' },
      { kind: 'input', source: 'request.output.width' },
      { kind: 'input', source: 'request.output.format' },
      { kind: 'input', source: 'request.mode' },
    ]);
    expect(result.image).toBeUndefined();
  });

  it('出图像素过大时拒绝', async () => {
    const result = await render(
      await loadSingleText(),
      greetingRequest({ output: { width: 1500, height: 200, dpi: 2400, format: 'png' } }),
    );

    expect(codes(result.problems)).toEqual([ProblemCodes.requestOutputTooLarge]);
  });
});
