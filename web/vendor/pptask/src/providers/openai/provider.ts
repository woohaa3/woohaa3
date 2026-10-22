import type { PptaskDescription, PptaskProvider } from '../../core/types.ts';
import { createHttpProvider } from '../shared/provider.ts';
import { base64ToBytes, jsonRequest, mergeHeaders, normalizeProviderConfig, requestJson } from '../shared/http.ts';
import { isRecord } from '../shared/input.ts';
import type { CommonProviderOptions, HttpProviderProtocol } from '../shared/types.ts';

export type OpenAIProviderOptions = CommonProviderOptions & { apiKey: string };

export function createOpenAIProvider(options: OpenAIProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig('openai', options, 'https://api.openai.com');
  const auth = { ...config.headers, authorization: `Bearer ${config.apiKey}` };
  const protocol: HttpProviderProtocol = {
    providerId: 'openai', fetch: config.fetch, modelTypes: ['image'], mode: () => 'sync',
    async execute(context) {
      const endpoint = endpointFor(context.input);
      if (endpoint === 'generations') {
        if (!context.input.prompt) throw new Error('Prompt is required for OpenAI image generation');
        return requestJson(config.fetch, 'openai', jsonRequest(
          `${config.baseURL}/v1/images/generations`,
          { ...without(context.input, ['endpoint', 'images', 'mask']), model: context.modelId },
          mergeHeaders(auth, context.headers),
        ), context.signal);
      }
      const images = array(context.input.images);
      if (!images.length) throw new Error(`Image is required for OpenAI image ${endpoint}`);
      if (endpoint === 'edits' && !context.input.prompt) throw new Error('Prompt is required for OpenAI image edit');
      const form = new FormData();
      form.append('model', context.modelId);
      for (const [key, value] of Object.entries(without(context.input, ['endpoint', 'images', 'mask', 'model']))) {
        if (value !== undefined) form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      images.forEach((image, index) => form.append('image', toBlob(image), `image-${index}.png`));
      if (context.input.mask) form.append('mask', toBlob(context.input.mask), 'mask.png');
      return requestJson(config.fetch, 'openai', {
        url: `${config.baseURL}/v1/images/${endpoint}`, method: 'POST',
        headers: mergeHeaders(auth, context.headers), body: form,
      }, context.signal);
    },
    status: async () => { throw new Error('OpenAI image generation is synchronous'); },
    describe: async modelId => description(modelId),
  };
  return createHttpProvider(protocol, options);
}

function endpointFor(input: Record<string, unknown>): 'generations' | 'edits' | 'variations' {
  const endpoint = String(input.endpoint ?? (array(input.images).length ? 'edits' : 'generations')).toLowerCase();
  if (['edit', 'edits', 'image-edit'].includes(endpoint)) return 'edits';
  if (['variation', 'variations', 'image-variation'].includes(endpoint)) return 'variations';
  return 'generations';
}

function toBlob(value: unknown): Blob {
  if (value instanceof Blob) return value;
  if (value instanceof Uint8Array) return new Blob([value as BlobPart], { type: 'image/png' });
  if (typeof value === 'string') return new Blob([base64ToBytes(value) as BlobPart], { type: 'image/png' });
  if (isRecord(value) && typeof value.data === 'string') return toBlob(value.data);
  throw new Error('Unsupported OpenAI image input');
}
function array(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function without(value: Record<string, unknown>, keys: string[]): Record<string, unknown> { const result = { ...value }; for (const key of keys) delete result[key]; return result; }
function description(modelId: string): PptaskDescription { return { providerId: 'openai', modelId, modelType: 'image', title: modelId,
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, endpoint: { type: 'string', enum: ['generations', 'edits', 'variations'] } } },
  defaultInput: { endpoint: 'generations' }, capabilities: { operation: 'images', cancel: false } }; }
