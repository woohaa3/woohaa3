import { describe, expect, it, vi } from 'vitest';
import { findAdaptiveOption, referenceInputCapabilityFromDescription } from '@woohaa3/contracts';
import {
  ARK_CATALOG,
  ARK_SEEDREAM_5_PRO_MODEL,
  arkApiRoot,
  buildArkChatRequestBody,
  buildArkSeedreamRequestBody,
  buildSeedanceCreateBody,
  createArkProvider,
  describeArkModel,
} from '../src/provider/index.js';

const SEEDANCE_25 = 'doubao-seedance-2-5-260628';
const SEEDANCE_20 = 'doubao-seedance-2-0-260128';
const SEEDANCE_FAST = 'doubao-seedance-2-0-fast-260128';
const SEEDREAM_LITE = 'doubao-seedream-5-0-260128';

describe('Ark catalog', () => {
  it('declares the frame roles that Seedance actually forwards', () => {
    const inputs=referenceInputCapabilityFromDescription(describeArkModel(SEEDANCE_25));
    expect(inputs.bindings.find(b=>b.field==='urls')?.roles).toEqual(['reference_image','first_frame','last_frame']);
    expect(inputs.bindings.some(b=>b.field==='videoUrls')).toBe(true);
    const fast=referenceInputCapabilityFromDescription(describeArkModel('doubao-seedance-1-0-pro-fast-251015'));
    expect(fast.roles).not.toContain('last_frame');
  });
  it('covers language, image and video with public model ids', () => {
    const kinds = new Set(ARK_CATALOG.map((model) => model.kind));
    expect(kinds).toEqual(new Set(['language', 'image', 'video']));
    expect(ARK_CATALOG.map((model) => model.id)).toContain(ARK_SEEDREAM_5_PRO_MODEL);
    expect(ARK_CATALOG.map((model) => model.id)).toContain(SEEDANCE_25);
    expect(ARK_CATALOG.map((model) => model.id)).toContain('doubao-seed-2-1-pro-260915');
    expect(ARK_CATALOG.some((model) => model.id.startsWith('ep-'))).toBe(false);
  });

  it('strips the legacy video task path back to the API root', () => {
    expect(arkApiRoot('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3',
    );
  });

  it('describes Seedance 2.0 with an inclusive 4–15s range and 4k, and 2.5 without 4k', () => {
    const full = describeArkModel(SEEDANCE_20);
    const fast = describeArkModel(SEEDANCE_FAST);
    const next = describeArkModel(SEEDANCE_25);
    const fullProps = full.inputSchema?.properties as Record<string, any>;
    const fastProps = fast.inputSchema?.properties as Record<string, any>;
    const nextProps = next.inputSchema?.properties as Record<string, any>;
    expect(fullProps.durationSeconds).toMatchObject({ minimum: 4, maximum: 15 });
    expect(fullProps.resolution.enum.map((item: { value: string }) => item.value)).toContain('4k');
    expect(fastProps.resolution.enum.map((item: { value: string }) => item.value)).toEqual(['480p', '720p']);
    expect(nextProps.durationSeconds.maximum).toBe(30);
    expect(nextProps.resolution.enum.map((item: { value: string }) => item.value)).not.toContain('4k');
    expect(nextProps.urls.maxItems).toBe(30);
    expect(nextProps.audioUrls.maxItems).toBe(10);
  });

  it('marks video ratio/resolution and sequential image size with shared semantics', () => {
    const videoProps = describeArkModel(SEEDANCE_20).inputSchema?.properties as Record<string, any>;
    expect(videoProps.ratio).toMatchObject({
      title: '比例',
      default: 'adaptive',
      'x-pptask-control': 'aspect-ratio',
      'x-hidden-when': [{ field: 'generationMode', equals: 'edit_video' }, { field: 'generationMode', equals: 'first_last_frame' }],
    });
    expect(findAdaptiveOption(videoProps.ratio.enum)).toEqual({ value: 'adaptive', label: '自适应' });
    expect(videoProps.ratio.enum.map((item: { value: string }) => item.value)).toEqual([
      'adaptive',
      '16:9',
      '9:16',
      '1:1',
      '4:3',
      '3:4',
      '21:9',
    ]);
    expect(videoProps.resolution).toMatchObject({
      title: '分辨率',
      default: '720p',
      'x-pptask-control': 'resolution',
    });

    const sequentialProps = describeArkModel(SEEDREAM_LITE).inputSchema?.properties as Record<string, any>;
    expect(sequentialProps.size).toMatchObject({
      title: '图片分辨率',
      default: '2K',
      'x-pptask-control': 'resolution',
    });
    expect(findAdaptiveOption(sequentialProps.size.enum)).toBeUndefined();
    // 即梦没有 aspect_ratio：比例只能靠 size 像素值兑换，所以给「比例 + 分辨率」。
    expect(sequentialProps.aspectRatio).toMatchObject({
      title: '图片比例',
      default: 'auto',
      'x-pptask-control': 'aspect-ratio',
    });
    expect(findAdaptiveOption(sequentialProps.aspectRatio.enum)).toEqual({ value: 'auto', label: '自适应' });
    expect(sequentialProps.aspectRatio.enum.map((item: { value: string }) => item.value)).toEqual([
      'auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9',
    ]);

    // pro family 也走档位选择；图层拆分时比例不参与（只能用档位）。
    const proProps = describeArkModel(ARK_SEEDREAM_5_PRO_MODEL).inputSchema?.properties as Record<string, any>;
    expect(proProps.size).toMatchObject({
      title: '图片分辨率',
      default: '2K',
      'x-pptask-control': 'resolution',
    });
    expect(proProps.size.enum.map((item: { value: string }) => item.value)).toEqual(['1K', '1.5K', '2K']);
    expect(proProps.aspectRatio).toMatchObject({
      default: 'auto',
      'x-pptask-control': 'aspect-ratio',
      'x-hidden-when': [{ field: 'layerDecomposition', equals: true }],
    });

    // 4.0 官方只给一组像素值、没有「比例 × 档位」，不提供无法兑现的比例控件。
    const fourProps = describeArkModel('doubao-seedream-4-0-250828').inputSchema?.properties as Record<string, any>;
    expect(fourProps.aspectRatio).toBeUndefined();
    expect(fourProps.size.enum.map((item: { value: string }) => item.value)).toEqual(['1K', '2K', '4K']);
  });
});

describe('Seedance request body', () => {
  it('keeps role order and accepts asset or https images', () => {
    const body = buildSeedanceCreateBody(SEEDANCE_25, {
      prompt: '镜头推进',
      generationMode: 'omni_reference',
      urls: [
        { url: 'asset://img-1', role: 'reference_image' },
        { url: 'asset://img-2', role: 'first_frame' },
      ],
      videoUrls: [{ url: 'https://cdn/ref.mp4', role: 'reference_video' }],
      audioUrls: [{ url: 'https://cdn/ref.mp3', role: 'reference_audio' }],
    });
    expect(body.model).toBe(SEEDANCE_25);
    expect(body.content).toEqual([
      { type: 'text', text: '镜头推进' },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'asset://img-1' } },
      { type: 'image_url', role: 'first_frame', image_url: { url: 'asset://img-2' } },
      { type: 'video_url', role: 'reference_video', video_url: { url: 'https://cdn/ref.mp4' } },
      { type: 'audio_url', role: 'reference_audio', audio_url: { url: 'https://cdn/ref.mp3' } },
    ]);
  });

  it('uses the inclusive duration bounds and can turn audio off', () => {
    expect(buildSeedanceCreateBody(SEEDANCE_20, { prompt: 'p', durationSeconds: 15, resolution: '4k' })).toMatchObject({
      duration: 15,
      resolution: '4k',
    });
    expect(buildSeedanceCreateBody(SEEDANCE_25, { prompt: 'p', durationSeconds: 30, generateAudio: false })).toMatchObject({
      duration: 30,
      generate_audio: false,
    });
  });

  it('rejects 4k on Seedance 2.0 Fast and audio-only input on Seedance 2.0', () => {
    expect(() => buildSeedanceCreateBody(SEEDANCE_FAST, { prompt: 'p', resolution: '4k' })).toThrow(/分辨率/);
    expect(() => buildSeedanceCreateBody(SEEDANCE_20, {
      prompt: 'p',
      audioUrls: ['https://cdn/a.mp3'],
    })).toThrow(/音频/);
  });

  it('allows Seedance 2.5 to omit the prompt when only audio is attached', () => {
    const body = buildSeedanceCreateBody(SEEDANCE_25, { audioUrls: ['https://cdn/a.mp3'] });
    expect(body.content).toEqual([
      { type: 'audio_url', role: 'reference_audio', audio_url: { url: 'https://cdn/a.mp3' } },
    ]);
  });

  it('edit mode forces duration -1 and adaptive ratio', () => {
    expect(buildSeedanceCreateBody(SEEDANCE_25, {
      prompt: '改成夜晚',
      generationMode: 'edit_video',
      durationSeconds: 10,
    })).toMatchObject({ duration: -1, ratio: 'adaptive', omni_reference_task_type: 'edit' });
  });

  it('rejects a non-https image and an empty text-to-video prompt', () => {
    expect(() => buildSeedanceCreateBody(SEEDANCE_20, { prompt: 'p', urls: ['http://cdn/x.png'] })).toThrow(/HTTPS/);
    expect(() => buildSeedanceCreateBody(SEEDANCE_20, { prompt: '  ' })).toThrow(/提示词/);
  });
});

describe('Seedream families', () => {
  it('lets lite models ask for a group and rejects that flag on 5.0 pro', () => {
    expect(buildArkSeedreamRequestBody(SEEDREAM_LITE, {
      prompt: '一组海报',
      sequentialImageGeneration: 'auto',
      sequentialMaxImages: 3,
      size: '3K',
    })).toMatchObject({
      model: SEEDREAM_LITE,
      sequential_image_generation: 'auto',
      sequential_image_generation_options: { max_images: 3 },
      size: '3K',
    });
    expect(() => buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, {
      prompt: 'p',
      sequentialImageGeneration: 'auto',
    })).toThrow('sequential_image_generation');
  });

  it('turns the chosen aspect ratio into the official pixel size', () => {
    // 即梦没有 aspect_ratio：固定比例必须写进 size 才是真的固定。
    expect(buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, {
      prompt: 'p',
      aspectRatio: '16:9',
      size: '2K',
    })).toMatchObject({ size: '2848x1600' });

    expect(buildArkSeedreamRequestBody(SEEDREAM_LITE, {
      prompt: 'p',
      aspectRatio: '9:16',
      size: '3K',
    })).toMatchObject({ size: '2304x4096' });

    // 自适应（默认）仍下发档位，宽高比交给模型结合 prompt 决定。
    expect(buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, {
      prompt: 'p',
      aspectRatio: 'auto',
      size: '1.5K',
    })).toMatchObject({ size: '1.5K' });
  });

  it('rejects a ratio the version has no official pixel value for', () => {
    expect(() => buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, {
      prompt: 'p',
      aspectRatio: '1:1',
      size: '4K',
    })).toThrow(/does not support/);
    expect(() => buildArkSeedreamRequestBody('doubao-seedream-4-0-250828', {
      prompt: 'p',
      aspectRatio: '16:9',
      size: '2K',
    })).toThrow(/no official size table/);
  });

  it('ignores the aspect ratio under layer decomposition (presets only)', () => {
    expect(buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, {
      prompt: 'p',
      aspectRatio: '16:9',
      size: '2K',
      layerDecomposition: true,
      urls: ['https://cdn/one.png'],
    })).toMatchObject({ size: '2K', layer_decomposition: true });
  });

  it('rejects png output on Seedream 4.5', () => {
    expect(() => buildArkSeedreamRequestBody('doubao-seedream-4-5-251128', {
      prompt: 'p',
      outputFormat: 'png',
    })).toThrow('output_format');
  });
});

describe('Ark execution', () => {
  it('posts chat, image and video to the shared API root', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${url}`);
      if (String(url).includes('/chat/completions')) {
        return Response.json({ choices: [{ message: { content: '你好' } }] });
      }
      if (String(url).includes('/images/generations')) return Response.json({ data: [{ b64_json: 'AQ==' }] });
      if (init?.method === 'POST') return Response.json({ id: 'task-1' });
      return Response.json({ status: 'succeeded', content: { video_url: 'https://cdn/out.mp4', last_frame_url: 'https://cdn/poster.png' } });
    });
    const provider = createArkProvider({ apiKey: 'key', baseURL: 'https://ark.example/api/v3/', fetch: fetchImpl });
    const text = await provider.languageModel('doubao-seed-2-1-lite-260915').doGenerate!({
      prompt: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    } as never);
    expect(text.content).toEqual([{ type: 'text', text: '你好' }]);
    expect(buildArkChatRequestBody('doubao-seed-2-1-lite-260915', { prompt: '你好', system: '简短' }).messages).toEqual([
      { role: 'system', content: '简短' },
      { role: 'user', content: '你好' },
    ]);

    const video = provider.videoModel(SEEDANCE_20);
    const started = await video.doStart!({ prompt: 'p', n: 1 } as never);
    expect(started.operation).toEqual({ taskId: 'task-1' });
    const status = await video.doStatus!({ operation: started.operation });
    expect(status.status).toBe('completed');
    if (status.status !== 'completed') return;
    expect(status.videos[0]).toMatchObject({ url: 'https://cdn/out.mp4' });
    expect(status.providerMetadata).toMatchObject({ ark: { posterUrl: 'https://cdn/poster.png' } });
    expect(urls).toEqual([
      'POST https://ark.example/api/v3/chat/completions',
      'POST https://ark.example/api/v3/contents/generations/tasks',
      'GET https://ark.example/api/v3/contents/generations/tasks/task-1',
    ]);
  });

  it('sends the configured endpoint id instead of the catalog model id', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: 'task-1' });
    });
    const provider = createArkProvider({
      apiKey: 'key',
      fetch: fetchImpl,
      endpoints: { [SEEDANCE_20]: 'ep-20260101000000-video' },
    });
    await provider.videoModel(SEEDANCE_20).doStart!({ prompt: 'p', n: 1 } as never);
    expect(bodies[0]?.model).toBe('ep-20260101000000-video');
    expect(() => provider.videoModel(SEEDANCE_25)).toThrow(/推理接入点/);
  });

  it('materializes duplicate video reference images once and keeps order', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      seen.push(JSON.stringify(body.content ?? body));
      return Response.json({ id: 'task-1' });
    });
    const materializeImage = vi.fn(async (url: string) => url.replace('https://cdn/', 'asset://'));
    const provider = createArkProvider({ apiKey: 'key', fetch: fetchImpl, materializeImage });
    await provider.videoModel(SEEDANCE_20).doStart!({
      prompt: 'p',
      providerOptions: {
        ark: {
          urls: [
            { url: 'https://cdn/image.png', role: 'first_frame' },
            { url: 'https://cdn/image.png', role: 'last_frame' },
            'asset://existing',
          ],
        },
      },
    } as never);
    expect(materializeImage).toHaveBeenCalledTimes(2);
    expect(JSON.parse(seen[0] ?? '[]')).toEqual([
      { type: 'text', text: 'p' },
      { type: 'image_url', role: 'first_frame', image_url: { url: 'asset://image.png' } },
      { type: 'image_url', role: 'last_frame', image_url: { url: 'asset://image.png' } },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'asset://existing' } },
    ]);
  });
});


describe('Ark 同步图片与 Seedream 约束（原 vendor sync-providers 覆盖）', () => {
  const imageCall = (provider: ReturnType<typeof createArkProvider>, modelId: string) =>
    provider.imageModel(modelId).doGenerate!({ prompt: 'hello', n: 1, size: undefined, aspectRatio: undefined, seed: undefined, files: undefined, mask: undefined, providerOptions: {} });

  it('Seedream 同步图片走 /images/generations', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ b64_json: 'Aw==' }] }));
    const provider = createArkProvider({ apiKey: 'key', fetch: fetchMock as typeof fetch });
    expect((await imageCall(provider, ARK_SEEDREAM_5_PRO_MODEL)).images[0]).toEqual(new Uint8Array([3]));
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toMatchObject({
      model: ARK_SEEDREAM_5_PRO_MODEL,
      prompt: 'hello',
      size: '2K',
      output_format: 'jpeg',
      response_format: 'url',
      background: 'opaque',
    });
  });

  it('validates Ark Seedream model constraints before sending a request', async () => {
    expect(() => buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, { prompt: '' }))
      .toThrow('requires a non-empty prompt');
    expect(() => buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, {
      layerDecomposition: true,
    })).toThrow('exactly one source image');
    expect(() => buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, {
      prompt: 'test',
      size: '512x512',
    })).toThrow('921600-4624220 pixels');
    expect(() => buildArkSeedreamRequestBody(ARK_SEEDREAM_5_PRO_MODEL, {
      prompt: 'test',
      image: ['https://example.com/a.png'],
      background: 'transparent',
      outputFormat: 'jpeg',
    })).toThrow('requires output_format=png');
  });

  it('rejects unsupported Ark models', () => {
    const provider = createArkProvider({ apiKey: 'key', fetch: vi.fn() as typeof fetch });
    expect(() => provider.imageModel('seedream')).toThrow('Unsupported Ark model');
  });
});
