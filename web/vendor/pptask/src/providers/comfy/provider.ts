import type { FilesV4, JSONValue } from '@ai-sdk/provider';
import type { PptaskDescription, PptaskProvider } from '../../core/types.ts';
import { createHttpProvider } from '../shared/provider.ts';
import { jsonRequest, mergeHeaders, normalizeProviderConfig, request, requestJson, uploadBlob } from '../shared/http.ts';
import { isRecord } from '../shared/input.ts';
import type { CommonProviderOptions, HttpProviderProtocol, HttpStatus } from '../shared/types.ts';

export type ComfyProviderOptions = Omit<CommonProviderOptions, 'apiKey'> & {
  baseURL: string;
  apiKey?: string;
};

export function createComfyProvider(options: ComfyProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig('comfy', options, options.baseURL, false);
  const auth = config.apiKey ? { ...config.headers, authorization: `Bearer ${config.apiKey}` } : config.headers;
  const protocol: HttpProviderProtocol = {
    providerId: 'comfy', fetch: config.fetch, modelTypes: ['image', 'video'], mode: () => 'async',
    files: createFiles(config.fetch, config.baseURL, auth),
    async start(context) {
      const prompt = isRecord(context.input.prompt) ? context.input.prompt : context.input;
      const raw = await requestJson<any>(config.fetch, 'comfy', jsonRequest(
        `${config.baseURL}/prompt`, { prompt, client_id: context.input.client_id, extra_data: context.input.extra_data },
        mergeHeaders(auth, context.headers),
      ), context.signal);
      const taskId = raw.prompt_id ?? raw.id;
      if (typeof taskId !== 'string' || !taskId) throw new Error('comfy createTask did not return prompt_id');
      return { operation: { taskId }, metadata: { taskId, workflowId: context.modelId } };
    },
    async status(context) {
      const taskId = operationId(context.operation);
      const historyResponse = await config.fetch(`${config.baseURL}/history/${encodeURIComponent(taskId)}`, {
        headers: mergeHeaders(auth, context.headers), signal: context.signal,
      });
      if (historyResponse.ok) {
        const raw = await historyResponse.json() as any;
        const entry = raw[taskId] ?? raw.history?.[taskId] ?? raw.data?.[taskId] ?? raw;
        return historyStatus(entry, taskId, config.baseURL);
      }
      const queue = await requestJson<any>(config.fetch, 'comfy', {
        url: `${config.baseURL}/queue`, headers: mergeHeaders(auth, context.headers),
      }, context.signal);
      const running = inQueue(queue.queue_running, taskId);
      return { state: 'pending', phase: running ? 'running' : 'queued', metadata: { taskId } };
    },
    async cancel(context) {
      const taskId = operationId(context.operation);
      await request(config.fetch, 'comfy', { url: `${config.baseURL}/interrupt`, method: 'POST', headers: auth }, context.signal);
      await request(config.fetch, 'comfy', jsonRequest(`${config.baseURL}/queue`, { delete: [taskId] }, auth), context.signal);
    },
    async describe(modelId, modelType) {
      let objectInfo: unknown;
      try { objectInfo = await requestJson(config.fetch, 'comfy', { url: `${config.baseURL}/object_info`, headers: auth }); }
      catch { objectInfo = undefined; }
      return { providerId: 'comfy', modelId, modelType, title: modelId,
        inputSchema: { type: 'object', properties: { prompt: { type: 'object' } } },
        capabilities: { operation: 'prompt', cancel: true, upload: true },
        providerMetadata: { comfy: { objectInfo: (objectInfo ?? null) as JSONValue } } };
    },
  };
  return createHttpProvider(protocol, options);
}

function historyStatus(entry: any, taskId: string, baseURL: string): HttpStatus {
  const rawStatus = entry?.status?.status_str ?? entry?.status?.status ?? entry?.status?.state;
  const status = String(rawStatus ?? '').toLowerCase();
  const metadata = { taskId, status, raw: entry } as any;
  if (['failed', 'error'].includes(status)) return { state: 'failed', error: String(entry?.status?.messages ?? 'Comfy task failed'), metadata };
  if (['cancelled', 'canceled'].includes(status)) return { state: 'failed', error: 'Comfy task cancelled', metadata };
  if (entry?.outputs || ['completed', 'success'].includes(status)) {
    return { state: 'completed', output: comfyOutputs(entry?.outputs, baseURL), metadata };
  }
  return { state: 'pending', phase: ['running', 'processing', 'executing'].includes(status) ? 'running' : 'queued',
    progress: typeof entry?.status?.progress === 'number' ? entry.status.progress : undefined, metadata };
}

function comfyOutputs(outputs: unknown, baseURL: string): unknown[] {
  if (!isRecord(outputs)) return [];
  const result: unknown[] = [];
  for (const node of Object.values(outputs)) {
    if (!isRecord(node)) continue;
    for (const key of ['images', 'videos', 'files']) {
      const values = node[key];
      if (!Array.isArray(values)) continue;
      for (const item of values) {
        if (!isRecord(item) || typeof item.filename !== 'string') continue;
        const url = new URL(`${baseURL}/view`);
        url.searchParams.set('filename', item.filename);
        if (typeof item.subfolder === 'string') url.searchParams.set('subfolder', item.subfolder);
        url.searchParams.set('type', typeof item.type === 'string' ? item.type : 'output');
        result.push({ ...item, url: url.toString() });
      }
    }
  }
  return result;
}

function createFiles(fetchImpl: typeof globalThis.fetch, baseURL: string, headers: Record<string, string>): FilesV4 {
  return { specificationVersion: 'v4', provider: 'comfy', async uploadFile(options) {
    const blob = await uploadBlob(options); const form = new FormData();
    form.append('image', blob, options.filename ?? `upload-${Date.now()}`);
    const raw = await requestJson<any>(fetchImpl, 'comfy', { url: `${baseURL}/upload/image`, method: 'POST', headers, body: form }, options.abortSignal);
    const reference = String(raw.name ?? raw.filename ?? '');
    if (!reference) throw new Error('comfy upload did not return a file name');
    return { providerReference: { comfy: reference }, mediaType: options.mediaType,
      filename: options.filename, byteSize: blob.size, providerMetadata: { comfy: { file: raw as JSONValue } }, warnings: [] };
  } };
}

function inQueue(value: unknown, taskId: string): boolean {
  return Array.isArray(value) && value.some(item => Array.isArray(item) ? item.includes(taskId) : isRecord(item) && (item.id === taskId || item.prompt_id === taskId));
}
function operationId(value: unknown): string { if (isRecord(value) && typeof value.taskId === 'string') return value.taskId; throw new Error('Invalid Comfy operation reference'); }
