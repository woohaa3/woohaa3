import type {
  Experimental_VideoModelV4CallOptions,
  Experimental_VideoModelV4OperationStatusResult,
  FilesV4,
  FilesV4UploadFileCallOptions,
  FilesV4UploadFileResult,
  ImageModelV4CallOptions,
  ImageModelV4ProviderMetadata,
  ImageModelV4Result,
  JSONValue,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { createPptaskProvider } from '@sdppp/pptask';
import type {
  PptaskDescription,
  PptaskImageModelImplementation,
  PptaskJobRepository,
  PptaskOperationContext,
  PptaskOperationStatusResult,
  PptaskProvider,
  PptaskVideoModelImplementation,
} from '@sdppp/pptask';
import { createRunningHubLanguageModel } from './language.js';

const DEFAULT_API_BASE_URL = 'https://www.runninghub.ai/openapi/v2';
const DEFAULT_APP_BASE_URL = 'https://www.runninghub.ai';
export const DEFAULT_LLM_BASE_URL = 'https://llm.runninghub.ai/v1';

export type RunninghubProviderOptions = {
  apiKey: string;
  language?: string;
  baseURL?: string;
  apiBaseURL?: string;
  appBaseURL?: string;
  /** 文字模型独立端点；缺省 `https://llm.runninghub.ai/v1`。 */
  languageBaseURL?: string;
  fetch?: typeof globalThis.fetch;
  jobRepository?: PptaskJobRepository;
  pollIntervalMs?: number;
};

type RunninghubConfig = {
  apiKey: string;
  appBaseURL: string;
  apiBaseURL: string;
  languageBaseURL: string;
  fetch: typeof globalThis.fetch;
};

type RunninghubModelRef =
  | { kind: 'app'; value: string }
  | { kind: 'api'; value: string };

type RunninghubOperation = {
  kind: 'app' | 'api';
  taskId: string;
  modelId: string;
};

type RunninghubResponse = {
  code?: unknown;
  success?: boolean;
  errorCode?: unknown;
  errorMessage?: unknown;
  msg?: unknown;
  message?: unknown;
  data?: unknown;
  status?: unknown;
  taskId?: unknown;
  task_id?: unknown;
  id?: unknown;
  results?: unknown;
};

type RunninghubNode = {
  nodeId?: string | number;
  fieldName?: string;
  fieldType?: string;
  fieldValue?: unknown;
  fieldData?: unknown;
  [key: string]: unknown;
};

export function createRunninghubProvider(options: RunninghubProviderOptions): PptaskProvider {
  const config = normalizeConfig(options);
  return createPptaskProvider({
    providerId: 'runninghub',
    languageModel: modelId => createRunningHubLanguageModel(languageModelId(modelId), {
      apiKey: config.apiKey,
      baseURL: config.languageBaseURL,
      fetch: config.fetch,
    }),
    imageModel: modelId => createImageModel(modelId, config),
    videoModel: modelId => createVideoModel(modelId, config),
    files: createFiles(config),
    jobRepository: options.jobRepository,
    pollIntervalMs: options.pollIntervalMs,
  });
}

function createImageModel(
  modelId: string,
  config: RunninghubConfig,
): PptaskImageModelImplementation {
  const model = parseModelId(modelId);
  const implementation: PptaskImageModelImplementation = {
    maxImagesPerCall: 1,
    async doStart(options, context) {
      return startTask(model, imageInput(options), config, context, options.abortSignal, options.headers);
    },
    async doStatus({ operation, abortSignal, headers }) {
      return statusImage(model, operation, config, abortSignal, headers);
    },
    async doDescribe() {
      return describeModel(modelId, model, config, 'image');
    },
  };
  if (model.kind === 'app') {
    implementation.doCancel = async ({ operation, abortSignal, headers }) => {
      await cancelTask(operation, config, abortSignal, headers);
    };
  }
  return implementation;
}

function createVideoModel(
  modelId: string,
  config: RunninghubConfig,
): PptaskVideoModelImplementation {
  const model = parseModelId(modelId);
  const implementation: PptaskVideoModelImplementation = {
    maxVideosPerCall: 1,
    async doStart(options, context) {
      const started = await startTask(model, videoInput(options), config, context, options.abortSignal, options.headers);
      return {
        operation: started.operation,
        warnings: [],
        providerMetadata: started.providerMetadata,
        response: {
          timestamp: new Date(),
          modelId,
          headers: undefined,
        },
      };
    },
    async doStatus({ operation, abortSignal, headers }) {
      return statusVideo(model, operation, config, abortSignal, headers);
    },
    async doDescribe() {
      return describeModel(modelId, model, config, 'video');
    },
  };
  if (model.kind === 'app') {
    implementation.doCancel = async ({ operation, abortSignal, headers }) => {
      await cancelTask(operation, config, abortSignal, headers);
    };
  }
  return implementation;
}

async function startTask(
  model: RunninghubModelRef,
  input: Record<string, unknown>,
  config: RunninghubConfig,
  _context?: PptaskOperationContext,
  signal?: AbortSignal,
  requestHeaders?: Record<string, string | undefined>,
) {
  if (model.kind === 'app') {
    const template = await getAppTemplate(model.value, config);
    const nodeInfoList = buildNodeInfoList(template, input);
    const payload = {
      apiKey: config.apiKey,
      webappId: model.value,
      nodeInfoList,
      instanceType: 'default',
    };
    const response = await requestJson(config.fetch, appURL(config, '/task/openapi/ai-app/run'), {
      method: 'POST',
      headers: { ...definedHeaders(requestHeaders), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    ensureSuccessfulResponse('RunningHub app create', response);
    const taskId = firstString(response.data, 'taskId') ?? firstString(response, 'taskId');
    if (!taskId) throw new Error('RunningHub app create did not return taskId');
    return {
      operation: { kind: 'app', taskId, modelId: model.value } satisfies RunninghubOperation,
      providerMetadata: { runninghub: { taskId, kind: 'app', webappId: model.value } },
    };
  }

  const headers: Record<string, string> = {
    ...definedHeaders(requestHeaders),
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
  };
  const response = await requestJson(config.fetch, `${config.apiBaseURL}/${model.value}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal,
  });
  ensureSuccessfulResponse('RunningHub API create', response);
  const taskId = extractTaskId(response);
  if (!taskId) throw new Error('RunningHub API create did not return taskId');
  return {
    operation: { kind: 'api', taskId, modelId: model.value } satisfies RunninghubOperation,
    providerMetadata: { runninghub: { taskId, kind: 'api', modelPath: model.value } },
  };
}

async function statusImage(
  model: RunninghubModelRef,
  operation: JSONValue,
  config: RunninghubConfig,
  signal?: AbortSignal,
  requestHeaders?: Record<string, string | undefined>,
): Promise<PptaskOperationStatusResult<ImageModelV4Result>> {
  const status = await getStatus(model, operation, config, signal, requestHeaders);
  if (status.state === 'pending') {
    return {
      status: 'pending',
      phase: status.phase,
      progress: status.progress,
      providerMetadata: status.providerMetadata,
    };
  }
  if (status.state === 'error') {
    return { status: 'error', error: status.error, providerMetadata: status.providerMetadata };
  }
  const urls = status.urls;
  const images = await Promise.all(urls.map(url => downloadBytes(config.fetch, url, signal)));
  return {
    status: 'completed',
    images,
    warnings: [],
    providerMetadata: imageMetadata(status.providerMetadata, urls),
    response: { timestamp: new Date(), modelId: model.value, headers: undefined },
  };
}

async function statusVideo(
  model: RunninghubModelRef,
  operation: JSONValue,
  config: RunninghubConfig,
  signal?: AbortSignal,
  requestHeaders?: Record<string, string | undefined>,
): Promise<Experimental_VideoModelV4OperationStatusResult> {
  const status = await getStatus(model, operation, config, signal, requestHeaders);
  const response = { timestamp: new Date(), modelId: model.value, headers: undefined };
  if (status.state === 'pending') {
    return {
      status: 'pending',
      providerMetadata: status.providerMetadata,
      response,
    };
  }
  if (status.state === 'error') {
    return {
      status: 'error',
      error: status.error,
      providerMetadata: status.providerMetadata,
      response,
    };
  }
  return {
    status: 'completed',
    videos: status.urls.map(url => ({ type: 'url' as const, url, mediaType: videoMediaType(url) })),
    warnings: [],
    providerMetadata: status.providerMetadata,
    response,
  };
}

async function getStatus(
  model: RunninghubModelRef,
  operation: JSONValue,
  config: RunninghubConfig,
  signal?: AbortSignal,
  requestHeaders?: Record<string, string | undefined>,
): Promise<{
  state: 'pending' | 'completed' | 'error';
  phase?: 'queued' | 'running';
  progress?: number;
  urls: string[];
  error: string;
  providerMetadata: SharedV4ProviderMetadata;
}> {
  const parsed = parseOperation(operation);
  const response = model.kind === 'app'
    ? await requestJson(config.fetch, appURL(config, '/task/openapi/status'), {
        method: 'POST',
        headers: { ...definedHeaders(requestHeaders), 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: config.apiKey, taskId: parsed.taskId }),
        signal,
      })
    : await requestJson(config.fetch, `${config.apiBaseURL}/query`, {
        method: 'POST',
        headers: {
          ...definedHeaders(requestHeaders),
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ taskId: parsed.taskId }),
        signal,
      });
  ensureSuccessfulResponse('RunningHub status', response);
  const rawStatus = model.kind === 'app'
    ? firstString(response.data, 'status') ?? firstString(response.data, 'taskStatus') ?? String(response.data ?? '')
    : firstString(response, 'status') ?? firstString(response.data, 'status');
  const normalized = normalizeStatus(rawStatus);
  const providerMetadata = runninghubMetadata({
    taskId: parsed.taskId,
    kind: model.kind,
    status: rawStatus ?? null,
  });
  if (normalized === 'pending' || normalized === 'running') {
    return {
      state: 'pending',
      phase: normalized === 'running' ? 'running' : 'queued',
      progress: extractProgress(response),
      urls: [],
      error: '',
      providerMetadata,
    };
  }
  if (normalized === 'failed' || normalized === 'cancelled') {
    return {
      state: 'error',
      urls: [],
      error: extractError(response, `RunningHub task ${parsed.taskId} failed`),
      providerMetadata,
    };
  }

  const result = model.kind === 'app'
    ? await requestJson(config.fetch, appURL(config, '/task/openapi/outputs'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: config.apiKey, taskId: parsed.taskId }),
        signal,
      })
    : response;
  ensureSuccessfulResponse('RunningHub result', result);
  return {
    state: 'completed',
    urls: extractUrls(result),
    error: '',
    providerMetadata: runninghubMetadata({
      taskId: parsed.taskId,
      kind: model.kind,
      status: rawStatus ?? null,
      result: (result.data ?? result.results ?? null) as JSONValue,
      images: extractUrls(result),
    }),
  };
}

async function cancelTask(
  operation: JSONValue,
  config: RunninghubConfig,
  signal?: AbortSignal,
  requestHeaders?: Record<string, string | undefined>,
): Promise<void> {
  const parsed = parseOperation(operation);
  if (parsed.kind === 'api') {
    throw new Error('RunningHub API does not support cancellation');
  }
  const response = await requestJson(config.fetch, appURL(config, '/task/openapi/cancel'), {
    method: 'POST',
    headers: { ...definedHeaders(requestHeaders), 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: config.apiKey, taskId: parsed.taskId }),
    signal,
  });
  ensureSuccessfulResponse('RunningHub cancel', response);
}

async function describeModel(
  modelId: string,
  model: RunninghubModelRef,
  config: RunninghubConfig,
  modelType: 'image' | 'video',
): Promise<PptaskDescription> {
  if (model.kind === 'api') {
    return {
      providerId: 'runninghub',
      modelId,
      modelType,
      title: model.value,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
        },
      },
      capabilities: { operation: 'task', cancel: false },
      providerMetadata: runninghubMetadata({ kind: 'api', modelPath: model.value }),
    };
  }
  const template = await getAppTemplate(model.value, config);
  return {
    providerId: 'runninghub',
    modelId,
    modelType,
    title: model.value,
    inputSchema: nodeSchema(template.nodes),
    defaultInput: template.defaults,
    capabilities: { operation: 'task', cancel: true },
    providerMetadata: runninghubMetadata({ kind: 'app', webappId: model.value }),
  };
}

function createFiles(config: RunninghubConfig): FilesV4 {
  return {
    specificationVersion: 'v4',
    provider: 'runninghub',
    async uploadFile(options: FilesV4UploadFileCallOptions): Promise<FilesV4UploadFileResult> {
      const form = new FormData();
      const blob = await uploadBlob(options);
      form.append('file', blob, options.filename ?? `upload-${Date.now()}`);
      form.set('apiKey', config.apiKey);
      form.set('fileType', options.mediaType.startsWith('video/') ? 'video' : 'image');
      const response = await requestJson(config.fetch, appURL(config, '/task/openapi/upload'), {
        method: 'POST',
        body: form,
        signal: options.abortSignal,
      });
      ensureSuccessfulResponse('RunningHub upload', response);
      const reference = firstString(response.data, 'fileName') ?? firstString(response.data, 'url');
      if (!reference) throw new Error('RunningHub upload did not return a file reference');
      return {
        providerReference: { runninghub: reference },
        mediaType: options.mediaType,
        filename: options.filename,
        byteSize: blob.size,
        warnings: [],
      };
    },
  };
}

async function getAppTemplate(webappId: string, config: RunninghubConfig): Promise<{
  nodes: RunninghubNode[];
  defaults: Record<string, unknown>;
}> {
  const url = new URL('/api/webapp/apiCallDemo', config.appBaseURL);
  url.searchParams.set('apiKey', config.apiKey);
  url.searchParams.set('webappId', webappId);
  const response = await requestJson(config.fetch, url.toString(), { headers: { accept: 'application/json' } });
  ensureSuccessfulResponse('RunningHub describe', response);
  const data = asRecord(response.data);
  const nodes = Array.isArray(data?.nodeInfoList) ? data.nodeInfoList as RunninghubNode[] : [];
  const defaults = Object.fromEntries(nodes
    .filter(node => node.nodeId !== undefined && node.fieldName)
    .map(node => [`${node.nodeId}_${node.fieldName}`, node.fieldValue]));
  return { nodes, defaults };
}

function buildNodeInfoList(
  template: { nodes: RunninghubNode[]; defaults: Record<string, unknown> },
  input: Record<string, unknown>,
): RunninghubNode[] {
  return template.nodes.map(node => {
    const key = `${node.nodeId}_${node.fieldName}`;
    const direct = input[key];
    const suffix = node.fieldName ? input[node.fieldName] : undefined;
    const value = direct !== undefined ? direct : suffix !== undefined ? suffix : template.defaults[key] ?? node.fieldValue;
    return { ...node, fieldValue: normalizeFileValue(value) };
  });
}

function imageInput(options: ImageModelV4CallOptions): Record<string, unknown> {
  const custom = providerInput(options.providerOptions);
  return compact({
    ...custom,
    prompt: options.prompt,
    n: options.n,
    aspectRatio: options.aspectRatio,
    size: options.size,
    seed: options.seed,
    ...(options.files?.length ? { files: options.files.map(fileInput) } : {}),
  });
}

function videoInput(options: Experimental_VideoModelV4CallOptions): Record<string, unknown> {
  const custom = providerInput(options.providerOptions);
  return compact({
    ...custom,
    prompt: options.prompt,
    n: options.n,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    duration: options.duration,
    fps: options.fps,
    ...(options.image ? { image: fileInput(options.image) } : {}),
    ...(options.inputReferences?.length ? { inputReferences: options.inputReferences.map(fileInput) } : {}),
  });
}

function providerInput(providerOptions: Record<string, unknown>): Record<string, unknown> {
  const value = providerOptions.runninghub;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = (value as Record<string, unknown>).input;
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : value as Record<string, unknown>;
}

function fileInput(file: { type: 'url'; url: string } | { type: 'file'; data: string | Uint8Array; mediaType: string }): string {
  if (file.type === 'url') return file.url;
  if (typeof file.data === 'string') return file.data;
  return `data:${file.mediaType};base64,${bytesToBase64(file.data)}`;
}

/** catalog 身份 `llm/<原始 ID>` → 上游原始模型 ID；无前缀时原样使用。 */
function languageModelId(modelId: string): string {
  return modelId.startsWith('llm/') ? modelId.slice(4) : modelId;
}

function parseModelId(modelId: string): RunninghubModelRef {
  const value = modelId.trim();
  if (!value) throw new Error('RunningHub modelId is required');
  if (value.startsWith('app/')) return { kind: 'app', value: value.slice(4) };
  if (value.startsWith('api/')) return { kind: 'api', value: value.slice(4) };
  if (value.startsWith('app:')) return { kind: 'app', value: value.slice(4) };
  if (value.startsWith('api:')) return { kind: 'api', value: value.slice(4) };
  return { kind: 'api', value };
}

function parseOperation(operation: JSONValue): RunninghubOperation {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('Invalid RunningHub operation reference');
  }
  const value = operation as Record<string, unknown>;
  if ((value.kind !== 'app' && value.kind !== 'api') || typeof value.taskId !== 'string') {
    throw new Error('Invalid RunningHub operation reference');
  }
  return {
    kind: value.kind,
    taskId: value.taskId,
    modelId: typeof value.modelId === 'string' ? value.modelId : '',
  };
}

function normalizeConfig(options: RunninghubProviderOptions): RunninghubConfig {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('RunningHub apiKey is required');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('RunningHub provider requires fetch');
  // App 工作流基址（本仓库已不接 App 系列；保留默认以避免分支残留 CN 域名）。
  const defaultHost = DEFAULT_APP_BASE_URL;
  return {
    apiKey,
    appBaseURL: stripTrailingSlash(options.appBaseURL ?? defaultHost),
    apiBaseURL: stripTrailingSlash(options.apiBaseURL ?? options.baseURL ?? DEFAULT_API_BASE_URL),
    languageBaseURL: stripTrailingSlash(options.languageBaseURL ?? DEFAULT_LLM_BASE_URL),
    fetch: fetchImpl,
  };
}

function appURL(config: RunninghubConfig, path: string): string {
  return `${config.appBaseURL}${path}`;
}

function normalizeStatus(value: string | undefined): 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' {
  switch (String(value ?? '').toUpperCase()) {
    case 'RUNNING':
    case 'PROCESSING':
    case 'EXECUTING':
      return 'running';
    case 'SUCCESS':
    case 'SUCCEEDED':
    case 'COMPLETED':
    case 'DONE':
      return 'succeeded';
    case 'FAILED':
    case 'ERROR':
      return 'failed';
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function extractTaskId(response: RunninghubResponse): string | undefined {
  return firstString(response, 'taskId')
    ?? firstString(response, 'task_id')
    ?? firstString(response, 'id')
    ?? firstString(response.data, 'taskId')
    ?? firstString(response.data, 'task_id')
    ?? firstString(response.data, 'id');
}

function extractProgress(response: RunninghubResponse): number | undefined {
  const value = firstValue(response.data, 'progress') ?? firstValue(response.data, 'taskProgress');
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractUrls(response: RunninghubResponse): string[] {
  const data = response.data;
  const dataRecord = asRecord(data);
  const source = Array.isArray(data)
    ? response.data
    : Array.isArray(response.results)
      ? response.results
      : Array.isArray(dataRecord?.outputs)
        ? dataRecord.outputs
        : Array.isArray(dataRecord?.resultList)
          ? dataRecord.resultList
          : [];
  return (source as unknown[]).flatMap(value => {
    if (typeof value === 'string') return /^https?:\/\//.test(value) ? [value] : [];
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    return [item.fileUrl, item.url, item.downloadUrl].filter((url): url is string => typeof url === 'string');
  });
}

function extractError(response: RunninghubResponse, fallback: string): string {
  const candidates = [response.errorMessage, response.msg, response.message, response.data && firstValue(response.data, 'message'), response.data && firstValue(response.data, 'errorMessage')];
  const message = candidates.find(value => typeof value === 'string' && value.trim());
  return typeof message === 'string' ? message : fallback;
}

function firstString(value: unknown, key: string): string | undefined {
  const found = firstValue(value, key);
  return typeof found === 'string' || typeof found === 'number' ? String(found) : undefined;
}

function firstValue(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function ensureSuccessfulResponse(context: string, response: RunninghubResponse): void {
  const code = response.code ?? response.errorCode ?? firstValue(response.data, 'code') ?? firstValue(response.data, 'errorCode');
  if (response.success === false || (code !== undefined && code !== null && String(code) !== '' && String(code) !== '0')) {
    throw new Error(`${context} failed: ${extractError(response, JSON.stringify(response))}`);
  }
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<RunninghubResponse> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body: RunninghubResponse;
  try {
    body = text ? JSON.parse(text) as RunninghubResponse : {};
  } catch {
    throw new Error(`RunningHub returned invalid JSON (${response.status})`);
  }
  if (!response.ok) throw new Error(`RunningHub HTTP ${response.status}: ${text.slice(0, 500)}`);
  return body;
}

async function downloadBytes(fetchImpl: typeof globalThis.fetch, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`RunningHub output download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function uploadBlob(options: FilesV4UploadFileCallOptions): Promise<Blob> {
  if (options.data.type === 'text') return new Blob([options.data.text], { type: options.mediaType });
  if (options.data.type === 'data') {
    const data = typeof options.data.data === 'string' ? base64ToBytes(options.data.data) : options.data.data;
    return new Blob([data as BlobPart], { type: options.mediaType });
  }
  const blob = await new Response(options.data.stream).blob();
  return blob.type ? blob : new Blob([blob], { type: options.mediaType });
}

function nodeSchema(nodes: RunninghubNode[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(nodes
      .filter(node => node.nodeId !== undefined && node.fieldName)
      .map(node => [`${node.nodeId}_${node.fieldName}`, {
        type: node.fieldType && /int|float|number/i.test(node.fieldType) ? 'number' : 'string',
        title: node.fieldName,
        ...(node.fieldValue !== undefined ? { default: node.fieldValue } : {}),
      }])),
  };
}

function normalizeFileValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? normalizeFileValue(value[0]) : value;
  if (value && typeof value === 'object' && 'url' in value) return (value as { url: unknown }).url;
  return value;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function definedHeaders(
  headers?: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function videoMediaType(url: string): string {
  if (/\.webm(?:$|\?)/i.test(url)) return 'video/webm';
  if (/\.mov(?:$|\?)/i.test(url)) return 'video/quicktime';
  return 'video/mp4';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function runninghubMetadata(values: Record<string, JSONValue> = {}): SharedV4ProviderMetadata {
  return {
    runninghub: {
      images: [],
      ...values,
    },
  };
}

function imageMetadata(
  metadata: SharedV4ProviderMetadata,
  urls: string[],
): ImageModelV4ProviderMetadata {
  return {
    ...metadata,
    runninghub: {
      ...(metadata.runninghub ?? {}),
      images: urls,
    },
  };
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}
