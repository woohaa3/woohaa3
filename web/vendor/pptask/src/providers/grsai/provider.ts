import type { FilesV4 } from '@ai-sdk/provider';
import type { PptaskDescription, PptaskProvider } from '../../core/types.ts';
import { createHttpProvider } from '../shared/provider.ts';
import { jsonRequest, mergeHeaders, normalizeProviderConfig, request, requestJson, uploadBlob } from '../shared/http.ts';
import { isRecord } from '../shared/input.ts';
import type { CommonProviderOptions, HttpProviderProtocol, HttpStatus } from '../shared/types.ts';

export type GrsaiProviderOptions = CommonProviderOptions & {
  apiKey: string;
  baseURL: string;
  uploadApiKey?: string;
  uploadBaseURL?: string;
};

export function createGrsaiProvider(options: GrsaiProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig('grsai', options, options.baseURL);
  const auth = { ...config.headers, authorization: `Bearer ${config.apiKey}` };
  const protocol: HttpProviderProtocol = {
    providerId: 'grsai', fetch: config.fetch, modelTypes: ['image'], mode: () => 'async',
    files: createFiles(options, config.fetch),
    async start(context) {
      const response = await request(config.fetch, 'grsai', jsonRequest(
        `${config.baseURL}/v1/draw/nano-banana`,
        { ...context.input, model: context.modelId },
        mergeHeaders(auth, context.headers),
      ), context.signal);
      const raw = await parseResponse(response, true);
      if (raw?.code !== undefined && raw.code !== 0) throw new Error(String(raw.msg ?? 'Grsai API error'));
      const data = raw.data ?? raw;
      if (typeof data?.id !== 'string') throw new Error('grsai createTask did not return id');
      return { operation: { taskId: data.id }, metadata: { taskId: data.id } };
    },
    async status(context) {
      const taskId = operationId(context.operation);
      const response = await request(config.fetch, 'grsai', jsonRequest(
        `${config.baseURL}/v1/draw/result`, { id: taskId }, mergeHeaders(auth, context.headers),
      ), context.signal);
      const raw = await parseResponse(response);
      if (raw?.code !== undefined && raw.code !== 0) throw new Error(String(raw.msg ?? 'Grsai API error'));
      return mapStatus(raw.data ?? raw, taskId);
    },
    describe: async modelId => description(modelId),
  };
  return createHttpProvider(protocol, options);
}

async function parseResponse(response: Response, firstOnly = false): Promise<any> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Grsai response body is not readable');
  const decoder = new TextDecoder();
  let buffer = '';
  const events: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const parsed = JSON.parse(line.slice(5).trim());
      if (firstOnly) { await reader.cancel(); return parsed; }
      events.push(parsed);
    }
  }
  if (events.length) return events[events.length - 1];
  try { return JSON.parse(buffer); } catch { throw new Error('Grsai returned invalid SSE'); }
}

function mapStatus(data: Record<string, any>, taskId: string): HttpStatus {
  const metadata = { taskId, status: String(data.status ?? ''), raw: data } as any;
  switch (String(data.status ?? '').toLowerCase()) {
    case 'pending': return { state: 'pending', phase: 'queued', progress: number(data.progress), metadata };
    case 'running': return { state: 'pending', phase: 'running', progress: number(data.progress), metadata };
    case 'succeeded': return { state: 'completed', output: data.results ?? data, metadata };
    case 'failed':
    case 'cancelled': return { state: 'failed', error: String(data.error ?? data.failure_reason ?? `Grsai task ${data.status}`), metadata };
    default: return { state: 'pending', phase: 'running', progress: number(data.progress), metadata };
  }
}

function createFiles(options: GrsaiProviderOptions, fetchImpl: typeof globalThis.fetch): FilesV4 {
  return {
    specificationVersion: 'v4', provider: 'grsai',
    async uploadFile(uploadOptions) {
      const blob = await uploadBlob(uploadOptions);
      const extension = (uploadOptions.filename?.split('.').pop() ?? 'png').toLowerCase();
      const baseURL = (options.uploadBaseURL ?? options.baseURL).replace(/\/+$/, '');
      const raw = await requestJson<any>(fetchImpl, 'grsai', jsonRequest(
        `${baseURL}/client/resource/newUploadTokenZH`, { sux: extension },
        { authorization: `Bearer ${options.uploadApiKey ?? options.apiKey}` },
      ), uploadOptions.abortSignal);
      const data = raw.data;
      if (!data?.url || !data?.token || !data?.key || !data?.domain) throw new Error('grsai upload token response is incomplete');
      const form = new FormData();
      form.append('token', data.token); form.append('key', data.key);
      form.append('file', blob, uploadOptions.filename ?? `upload.${extension}`);
      await request(fetchImpl, 'grsai', { url: data.url, method: 'POST', body: form }, uploadOptions.abortSignal);
      const url = `${String(data.domain).replace(/\/+$/, '')}/${String(data.key).replace(/^\/+/, '')}`;
      return { providerReference: { grsai: url }, mediaType: uploadOptions.mediaType,
        filename: uploadOptions.filename, byteSize: blob.size,
        providerMetadata: { grsai: { url } }, warnings: [] };
    },
  };
}

function description(modelId: string): PptaskDescription {
  return { providerId: 'grsai', modelId, modelType: 'image', title: modelId,
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, urls: { type: 'array' }, aspectRatio: { type: 'string' }, imageSize: { type: 'string' } } },
    defaultInput: { aspectRatio: 'auto', imageSize: '1K' },
    capabilities: { operation: 'job', cancel: false, upload: true } };
}

function operationId(value: unknown): string {
  if (isRecord(value) && typeof value.taskId === 'string') return value.taskId;
  throw new Error('Invalid Grsai operation reference');
}
function number(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
