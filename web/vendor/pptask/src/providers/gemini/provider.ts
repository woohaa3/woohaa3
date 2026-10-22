import type { PptaskDescription, PptaskProvider } from '../../core/types.ts';
import { createHttpProvider } from '../shared/provider.ts';
import { jsonRequest, mergeHeaders, normalizeProviderConfig, requestJson } from '../shared/http.ts';
import { isRecord } from '../shared/input.ts';
import type { CommonProviderOptions, HttpProviderProtocol } from '../shared/types.ts';

export type GeminiProviderOptions = CommonProviderOptions & { apiKey: string; apiVersion?: string };

export function createGeminiProvider(options: GeminiProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig('gemini', options, 'https://generativelanguage.googleapis.com');
  const protocol: HttpProviderProtocol = {
    providerId: 'gemini', fetch: config.fetch, modelTypes: ['image'], mode: () => 'sync',
    async execute(context) {
      const parts: unknown[] = [];
      for (const image of array(context.input.images ?? context.input.urls)) parts.push(imagePart(image));
      if (typeof context.input.prompt === 'string' && context.input.prompt) parts.push({ text: context.input.prompt });
      if (!parts.length) throw new Error('gemini provider requires at least a prompt or reference image');
      const url = new URL(`${config.baseURL}/${options.apiVersion ?? 'v1beta'}/models/${encodeURIComponent(context.modelId)}:generateContent`);
      url.searchParams.set('key', config.apiKey!);
      return requestJson(config.fetch, 'gemini', jsonRequest(url.toString(), {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: {
          aspectRatio: context.input.aspectRatio ?? context.input.aspect_ratio,
          imageSize: context.input.imageSize ?? context.input.image_size,
        } },
      }, mergeHeaders(config.headers, context.headers)), context.signal);
    },
    status: async () => { throw new Error('Gemini generation is synchronous'); },
    describe: async modelId => description(modelId),
  };
  return createHttpProvider(protocol, options);
}

function imagePart(value: unknown): unknown {
  if (isRecord(value) && typeof value.url === 'string') value = value.url;
  if (typeof value !== 'string') throw new Error('Gemini reference image must be base64 or a data URL');
  const match = /^data:([^;]+);base64,(.+)$/.exec(value);
  return { inlineData: { mimeType: match?.[1] ?? 'image/png', data: match?.[2] ?? value } };
}
function array(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function description(modelId: string): PptaskDescription { return { providerId: 'gemini', modelId, modelType: 'image', title: modelId,
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, images: { type: 'array' }, aspectRatio: { type: 'string' }, imageSize: { type: 'string' } } },
  defaultInput: { aspectRatio: '16:9', imageSize: '2K' }, capabilities: { operation: 'generateContent', cancel: false } }; }
