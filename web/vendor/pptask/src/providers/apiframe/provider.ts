import type { FilesV4 } from '@ai-sdk/provider';
import type { PptaskDescription, PptaskModelType, PptaskProvider } from '../../core/types.ts';
import { createHttpProvider } from '../shared/provider.ts';
import { jsonRequest, mergeHeaders, normalizeProviderConfig, requestJson, uploadBlob } from '../shared/http.ts';
import { isRecord } from '../shared/input.ts';
import type { CommonProviderOptions, HttpProviderProtocol, HttpStatus } from '../shared/types.ts';
import { getApiframeModelEntry, APIFRAME_SUPPORTED_MODELS } from './catalog.ts';
import { flattenNestedSchema, schemaDefaults, type ProviderSchemaEntry } from '../shared/schema.ts';

const DEFAULT_BASE_URL = 'https://api.apiframe.ai';

export type ApiframeProviderOptions = CommonProviderOptions & {
  apiKey: string;
  webhookUrl?: string;
  webhookEvents?: string[];
};

export function createApiframeProvider(options: ApiframeProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig('apiframe', options, DEFAULT_BASE_URL);
  const auth = { ...config.headers, 'x-api-key': config.apiKey! };
  const protocol: HttpProviderProtocol = {
    providerId: 'apiframe',
    fetch: config.fetch,
    mode: () => 'async',
    validateModel(modelId, modelType) {
      const entry = resolveEntry(modelId, modelType);
      const expected = entry.modality === 'music' ? 'language' : entry.modality;
      if (modelType !== expected) {
        throw new Error(`Apiframe model ${entry.modelId} must be used as a ${expected} model`);
      }
    },
    files: createFiles(config.fetch, config.baseURL, auth),
    async start(context) {
      const entry = resolveEntry(context.modelId, context.modelType);
      const modality = entry.modality as 'image' | 'video' | 'music';
      const model = entry.modelId;
      const body = buildBody(entry, context.input, options);
      const raw = await requestJson<any>(config.fetch, 'apiframe', jsonRequest(
        `${config.baseURL}/v2/${modality === 'music' ? 'music' : `${modality}s`}/generate`,
        body,
        mergeHeaders(auth, context.headers),
      ), context.signal);
      const taskId = raw.jobId;
      if (typeof taskId !== 'string' || !taskId) throw new Error('apiframe createTask did not return jobId');
      return { operation: { taskId, modality }, metadata: { taskId, modality } };
    },
    async status(context) {
      const { taskId, modality } = operation(context.operation);
      const raw = await requestJson<any>(config.fetch, 'apiframe', {
        url: `${config.baseURL}/v2/jobs/${encodeURIComponent(taskId)}`,
        headers: mergeHeaders(auth, context.headers),
      }, context.signal);
      return mapStatus(raw, taskId, modality);
    },
    describe: (modelId, modelType) => Promise.resolve(description(modelId, modelType)),
  };
  return createHttpProvider(protocol, options);
}

function buildBody(
  entry: ProviderSchemaEntry,
  input: Record<string, unknown>,
  options: ApiframeProviderOptions,
): Record<string, unknown> {
  const clean = { ...input };
  delete clean.model;
  delete clean.webhookUrl;
  delete clean.webhookEvents;
  const modelField = String(entry.wireMetadata.modelField ?? 'model');
  const paramsField = typeof entry.wireMetadata.paramsField === 'string'
    ? entry.wireMetadata.paramsField
    : undefined;
  const properties = entry.requestSchema.properties ?? {};
  const nestedProperties = paramsField ? properties[paramsField]?.properties ?? {} : {};
  const body: Record<string, unknown> = { [modelField]: entry.modelId };
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(clean)) {
    if (key === modelField || key === paramsField) continue;
    if (key in nestedProperties) nested[key] = value;
    else if (key in properties) body[key] = value;
  }
  if (paramsField && Object.keys(nested).length) body[paramsField] = nested;
  if (options.webhookUrl) body.webhookUrl = options.webhookUrl;
  if (options.webhookEvents?.length) body.webhookEvents = options.webhookEvents;
  return body;
}

function mapStatus(raw: Record<string, any>, taskId: string, modality: string): HttpStatus {
  const metadata = { taskId, modality, status: String(raw.status ?? ''), raw } as any;
  switch (String(raw.status ?? '').toUpperCase()) {
    case 'QUEUED': return { state: 'pending', phase: 'queued', progress: number(raw.progress), metadata };
    case 'PROCESSING': return { state: 'pending', phase: 'running', progress: number(raw.progress), metadata };
    case 'COMPLETED':
      if (raw.expired === true) return { state: 'failed', error: 'Apiframe result assets expired', metadata };
      return { state: 'completed', output: raw.result, metadata };
    case 'FAILED': return { state: 'failed', error: String(raw.error ?? 'Apiframe task failed'), metadata };
    case 'CANCELLED': return { state: 'failed', error: 'Apiframe task was cancelled', metadata };
    default: throw new Error(`unknown apiframe job status: ${raw.status ?? ''}`);
  }
}

function createFiles(
  fetchImpl: typeof globalThis.fetch,
  baseURL: string,
  auth: Record<string, string>,
): FilesV4 {
  return {
    specificationVersion: 'v4',
    provider: 'apiframe',
    async uploadFile(options) {
      const blob = await uploadBlob(options);
      const limit = options.mediaType.startsWith('video/') ? 50 : 25;
      if (blob.size > limit * 1024 * 1024) throw new Error(`apiframe upload exceeds ${limit} MB limit`);
      const form = new FormData();
      form.append('file', blob, options.filename ?? `upload-${Date.now()}`);
      const raw = await requestJson<any>(fetchImpl, 'apiframe', {
        url: `${baseURL}/v2/uploads`, method: 'POST', headers: auth, body: form,
      }, options.abortSignal);
      if (typeof raw.url !== 'string' || !raw.url) throw new Error('apiframe upload did not return url');
      return {
        providerReference: { apiframe: raw.url }, mediaType: options.mediaType,
        filename: options.filename, byteSize: blob.size,
        providerMetadata: { apiframe: { url: raw.url } }, warnings: [],
      };
    },
  };
}

function modelModality(modelId: string, modelType: PptaskModelType): 'image' | 'video' | 'music' {
  const prefix = modelId.split('/')[0];
  if (prefix === 'image' || prefix === 'video' || prefix === 'music') return prefix;
  // Apiframe has no audio modality; its audio-ish catalog entries are music,
  // which are modelled as language models (see resolveEntry).
  return modelType === 'language' || modelType === 'audio' ? 'music' : modelType;
}

function stripModality(modelId: string): string {
  const [prefix, ...rest] = modelId.split('/');
  return ['image', 'video', 'music'].includes(prefix) && rest.length ? rest.join('/') : modelId;
}

function operation(value: unknown): { taskId: string; modality: string } {
  if (isRecord(value) && typeof value.taskId === 'string') {
    return { taskId: value.taskId, modality: String(value.modality ?? '') };
  }
  throw new Error('Invalid Apiframe operation reference');
}

function description(modelId: string, modelType: PptaskModelType): PptaskDescription {
  const entry = resolveEntry(modelId, modelType);
  const paramsField = typeof entry.wireMetadata.paramsField === 'string'
    ? entry.wireMetadata.paramsField
    : undefined;
  const inputSchema = flattenNestedSchema(
    entry.requestSchema,
    [String(entry.wireMetadata.modelField ?? 'model'), 'webhookUrl', 'webhookEvents'],
    paramsField,
  );
  return {
    providerId: 'apiframe', modelId, modelType, title: entry.label,
    inputSchema,
    defaultInput: schemaDefaults(inputSchema as Record<string, any>),
    capabilities: {
      operation: 'job', cancel: false, upload: true,
      outputType: entry.outputType,
      endpoint: entry.endpoint,
      paramsField: paramsField ?? null,
    },
  };
}

function resolveEntry(modelId: string, modelType: PptaskModelType): ProviderSchemaEntry {
  const stripped = stripModality(modelId);
  const entry = getApiframeModelEntry(stripped);
  if (!entry) {
    throw new Error(`Unsupported Apiframe model: ${modelId}. Supported models: ${APIFRAME_SUPPORTED_MODELS.join(', ')}`);
  }
  const prefix = modelId.includes('/') ? modelId.split('/')[0] : undefined;
  if (prefix && ['image', 'video', 'music'].includes(prefix) && prefix !== entry.modality) {
    throw new Error(`Apiframe model ${entry.modelId} has modality ${entry.modality}, not ${prefix}`);
  }
  const expected = entry.modality === 'music' ? 'language' : entry.modality;
  if (modelType !== expected) {
    throw new Error(`Apiframe model ${entry.modelId} must be used as a ${expected} model`);
  }
  return entry;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export const APIFRAME_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
export const APIFRAME_IMAGE_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
export const APIFRAME_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export { APIFRAME_MODEL_CATALOG, APIFRAME_SUPPORTED_MODELS } from './catalog.ts';
