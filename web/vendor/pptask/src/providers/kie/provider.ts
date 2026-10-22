import type { FilesV4 } from '@ai-sdk/provider';
import type { PptaskDescription, PptaskModelType, PptaskProvider } from '../../core/types.ts';
import { createHttpProvider } from '../shared/provider.ts';
import { jsonRequest, mergeHeaders, normalizeProviderConfig, requestJson, uploadBlob } from '../shared/http.ts';
import { isRecord } from '../shared/input.ts';
import type { CommonProviderOptions, HttpProviderProtocol, HttpStatus } from '../shared/types.ts';
import { getKieModelEntry, KIE_SUPPORTED_MODELS } from './catalog.ts';
import { schemaDefaults } from '../shared/schema.ts';

const DEFAULT_BASE_URL = 'https://api.kie.ai';
const DEFAULT_UPLOAD_BASE_URL = 'https://kieai.redpandaai.co';

export type KieProviderOptions = CommonProviderOptions & {
  apiKey: string;
  callbackUrl?: string;
  callBackUrl?: string;
  callback_url?: string;
  uploadBaseURL?: string;
  uploadPath?: string;
};

export function createKieProvider(options: KieProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig('kie', options, DEFAULT_BASE_URL);
  const auth = { ...config.headers, authorization: `Bearer ${config.apiKey}` };
  const files = createFiles(options, config.fetch, auth);
  const protocol: HttpProviderProtocol = {
    providerId: 'kie',
    fetch: config.fetch,
    mode: () => 'async',
    validateModel(modelId, modelType) {
      const entry = requireEntry(modelId);
      const expected = entry.outputType === 'video'
        ? 'video'
        : entry.outputType === 'image' ? 'image'
          : entry.outputType === 'audio' ? 'audio' : 'language';
      if (modelType !== expected) {
        throw new Error(`Kie model ${modelId} must be used as a ${expected} model`);
      }
    },
    files,
    async start(context) {
      const input = { ...context.input };
      delete input.model;
      for (const key of ['callBackUrl', 'callbackUrl', 'callback_url']) delete input[key];
      const body: Record<string, unknown> = { model: context.modelId, input };
      const callbackUrl = options.callbackUrl ?? options.callBackUrl ?? options.callback_url;
      if (callbackUrl) body.callBackUrl = callbackUrl;
      const raw = await requestJson<any>(config.fetch, 'kie', jsonRequest(
        `${config.baseURL}/api/v1/jobs/createTask`,
        body,
        mergeHeaders(auth, context.headers),
      ), context.signal);
      if (raw.code !== 200) throw new Error(`kie createTask failed: ${raw.msg ?? raw.code ?? 'unknown error'}`);
      const taskId = raw.data?.taskId;
      if (typeof taskId !== 'string' || !taskId) throw new Error('kie createTask did not return data.taskId');
      return { operation: { taskId }, metadata: { taskId } };
    },
    async status(context) {
      const taskId = operationId(context.operation);
      const url = new URL(`${config.baseURL}/api/v1/jobs/recordInfo`);
      url.searchParams.set('taskId', taskId);
      const raw = await requestJson<any>(config.fetch, 'kie', {
        url: url.toString(),
        headers: mergeHeaders(auth, context.headers),
      }, context.signal);
      if (raw.code !== 200) throw new Error(`kie recordInfo failed: ${raw.msg ?? raw.code ?? 'unknown error'}`);
      return mapStatus(raw.data ?? {}, taskId);
    },
    describe: (modelId, modelType) => Promise.resolve(description(modelId, modelType)),
  };
  return createHttpProvider(protocol, options);
}

function mapStatus(record: Record<string, any>, taskId: string): HttpStatus {
  const metadata = { taskId, state: String(record.state ?? ''), raw: record } as any;
  switch (String(record.state ?? '').toLowerCase()) {
    case 'waiting':
    case 'queuing':
      return { state: 'pending', phase: 'queued', progress: number(record.progress), metadata };
    case 'generating':
      return { state: 'pending', phase: 'running', progress: number(record.progress), metadata };
    case 'fail':
      return { state: 'failed', error: `${record.failCode ?? ''} ${record.failMsg ?? 'Kie task failed'}`.trim(), metadata };
    case 'success': {
      if (typeof record.resultJson !== 'string') return { state: 'failed', error: 'Kie resultJson is missing', metadata };
      let output: unknown;
      try { output = JSON.parse(record.resultJson); }
      catch { return { state: 'failed', error: 'Kie resultJson is invalid', metadata }; }
      return { state: 'completed', output, metadata };
    }
    default:
      throw new Error(`unknown kie task state: ${record.state ?? ''}`);
  }
}

function createFiles(
  options: KieProviderOptions,
  fetchImpl: typeof globalThis.fetch,
  auth: Record<string, string>,
): FilesV4 {
  return {
    specificationVersion: 'v4',
    provider: 'kie',
    async uploadFile(uploadOptions) {
      const blob = await uploadBlob(uploadOptions);
      const form = new FormData();
      form.append('file', blob, uploadOptions.filename ?? `upload-${Date.now()}`);
      form.append('uploadPath', options.uploadPath ?? defaultUploadPath());
      if (uploadOptions.filename) form.append('fileName', uploadOptions.filename);
      const raw = await requestJson<any>(fetchImpl, 'kie', {
        url: `${(options.uploadBaseURL ?? DEFAULT_UPLOAD_BASE_URL).replace(/\/+$/, '')}/api/file-stream-upload`,
        method: 'POST',
        headers: auth,
        body: form,
      }, uploadOptions.abortSignal);
      const url = raw.data?.downloadUrl;
      if (typeof url !== 'string' || !url) throw new Error('kie upload did not return data.downloadUrl');
      return {
        providerReference: { kie: url },
        mediaType: uploadOptions.mediaType,
        filename: uploadOptions.filename,
        byteSize: blob.size,
        providerMetadata: { kie: { url } },
        warnings: [],
      };
    },
  };
}

function description(modelId: string, modelType: PptaskModelType): PptaskDescription {
  const entry = requireEntry(modelId);
  return {
    providerId: 'kie', modelId, modelType, title: entry.label,
    inputSchema: entry.requestSchema,
    defaultInput: schemaDefaults(entry.requestSchema),
    capabilities: {
      operation: 'job', cancel: false, upload: true,
      outputType: entry.outputType,
      endpoint: entry.endpoint,
    },
  };
}

function requireEntry(modelId: string) {
  const entry = getKieModelEntry(modelId);
  if (!entry) {
    throw new Error(`Unsupported Kie model: ${modelId}. Supported models: ${KIE_SUPPORTED_MODELS.join(', ')}`);
  }
  return entry;
}

function operationId(operation: unknown): string {
  if (isRecord(operation) && typeof operation.taskId === 'string') return operation.taskId;
  if (typeof operation === 'string') return operation;
  throw new Error('Invalid Kie operation reference');
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function defaultUploadPath(): string {
  const date = new Date();
  return `pptask/${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export const KIE_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
export const KIE_DEFAULT_UPLOAD_BASE_URL = DEFAULT_UPLOAD_BASE_URL;
export { KIE_MODEL_CATALOG, KIE_SUPPORTED_MODELS } from './catalog.ts';
