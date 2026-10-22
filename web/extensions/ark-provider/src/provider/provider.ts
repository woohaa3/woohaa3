import type { PptaskDescription, PptaskProvider } from '@sdppp/pptask';
import { createHttpProvider } from '@sdppp/pptask/providers/shared';
import { jsonRequest, mergeHeaders, requestJson } from '@sdppp/pptask/providers/shared';
import type { CommonProviderOptions, HttpExecutionContext, HttpProviderProtocol, HttpStatus } from '@sdppp/pptask/providers/shared';
import { ARK_DEFAULT_BASE_URL, ARK_PROVIDER_ID, arkApiRoot, assertArkModel, findArkModel } from './catalog.js';
import { buildArkSeedreamRequestBody, describeArkImage } from './images.js';
import { buildArkChatRequestBody, describeArkLanguage } from './language.js';
import { buildSeedanceCreateBody, describeArkVideo } from './video.js';

export type ArkProviderOptions = CommonProviderOptions & {
  apiKey: string;
  /** 视频参考图提交前换成素材库 URI。图片生成仍使用 HTTPS 或 data URL。 */
  materializeImage?: (url: string, signal?: AbortSignal) => Promise<string>;
  /**
   * 目录模型 ID → 推理接入点（`ep-`）。
   * 给出这份映射后，请求体的 `model` 用接入点；没映射到的模型拒绝调用。
   * 不传时仍用目录里的 Model ID（供直接按模型调用的测试）。
   */
  endpoints?: Record<string, string>;
};

export function describeArkModel(modelId: string): PptaskDescription {
  const model = assertArkModel(modelId);
  if (model.kind === 'language') return describeArkLanguage(modelId, model.title);
  if (model.kind === 'image') return describeArkImage(modelId, model);
  return describeArkVideo(modelId, model);
}

/**
 * 火山方舟：文本同步走 Chat Completions，图片同步走 images/generations，
 * 视频异步走 contents/generations/tasks。
 */
export function createArkProvider(options: ArkProviderOptions): PptaskProvider {
  const root = arkApiRoot(options.baseURL ?? ARK_DEFAULT_BASE_URL);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('ark apiKey is required');
  if (!fetchImpl) throw new Error('ark provider requires fetch');
  const materializeImage = options.materializeImage;
  const endpoints = options.endpoints;

  const protocol: HttpProviderProtocol = {
    providerId: ARK_PROVIDER_ID,
    fetch: fetchImpl,
    modelTypes: ['language', 'image', 'video'],
    mode: (_modelId, modelType) => (modelType === 'video' ? 'async' : 'sync'),
    validateModel(modelId, modelType) {
      if (modelType !== 'language' && modelType !== 'image' && modelType !== 'video') {
        throw new Error(`Unsupported Ark model: ${modelId}`);
      }
      const model = assertArkModel(modelId, modelType);
      if (endpoints && !endpoints[model.id]) throw new Error(`Ark 模型 ${modelId} 未配置推理接入点`);
    },
    async execute(context) {
      if (context.modelType === 'language') {
        const body = buildArkChatRequestBody(context.modelId, context.input);
        applyEndpoint(body, context.modelId, endpoints);
        return postJson(fetchImpl, apiKey, `${root}/chat/completions`, body, context);
      }
      const body = buildArkSeedreamRequestBody(context.modelId, context.input);
      applyEndpoint(body, context.modelId, endpoints);
      return postJson(fetchImpl, apiKey, `${root}/images/generations`, body, context);
    },
    async start(context) {
      const body = buildSeedanceCreateBody(context.modelId, context.input);
      applyEndpoint(body, context.modelId, endpoints);
      await materializeVideoImages(body, materializeImage, context.signal);
      const response = await postJson(fetchImpl, apiKey, `${root}/contents/generations/tasks`, body, context);
      const taskId = readPath(response, ['id', 'task_id', 'taskId', 'data.id', 'data.task_id']);
      if (!taskId) throw new Error('Ark 未返回任务 ID');
      return { operation: { taskId } };
    },
    async status(context) {
      return readVideoStatus(fetchImpl, apiKey, root, context);
    },
    describe: async (modelId) => describeArkModel(modelId),
  };

  return createHttpProvider(protocol, { ...options, apiKey, baseURL: root, fetch: fetchImpl });
}

function applyEndpoint(body: Record<string, unknown>, modelId: string, endpoints?: Record<string, string>): void {
  if (!endpoints) return;
  const id = findArkModel(modelId)?.id ?? modelId;
  const endpoint = endpoints[id];
  if (!endpoint) throw new Error(`Ark 模型 ${modelId} 未配置推理接入点`);
  body.model = endpoint;
}

async function materializeVideoImages(
  body: Record<string, unknown>,
  materialize: ArkProviderOptions['materializeImage'],
  signal?: AbortSignal,
): Promise<void> {
  if (!materialize) return;
  const materials = new Map<string, string>();
  const content = Array.isArray(body.content) ? body.content : [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;
    if (record.type !== 'image_url') continue;
    const image = record.image_url;
    if (!image || typeof image !== 'object') continue;
    const url = (image as { url?: unknown }).url;
    if (typeof url !== 'string') continue;
    let uri = materials.get(url);
    if (!uri) {
      uri = await materialize(url, signal);
      materials.set(url, uri);
    }
    (image as { url: string }).url = uri;
  }
}

async function readVideoStatus(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  root: string,
  context: HttpExecutionContext & { operation?: unknown },
): Promise<HttpStatus> {
  const taskId = readOperationTaskId(context.operation);
  if (!taskId) return { state: 'failed', error: 'Ark 任务缺少 task id' };
  const response = await requestJson<Record<string, unknown>>(
    fetchImpl,
    ARK_PROVIDER_ID,
    {
      url: `${root}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: authHeaders(apiKey, context.headers),
    },
    context.signal,
  );
  const status = readStatus(response);
  if (status === 'failed' || status === 'cancelled') {
    return { state: 'failed', error: readPath(response, ['error.message', 'error', 'message']) ?? 'Ark 视频生成失败' };
  }
  if (status !== 'succeeded') {
    return {
      state: 'pending',
      phase: status === 'running' ? 'running' : 'queued',
      progress: numberAt(response, ['progress', 'data.progress']),
    };
  }
  const url = readPath(response, ['video_url', 'content.video_url', 'url', 'data.video_url', 'data.url', 'result.video_url', 'output.url']);
  if (!url) return { state: 'failed', error: 'Ark 视频已完成但未返回 URL' };
  const posterUrl = readPath(response, ['last_frame_url', 'content.last_frame_url', 'data.last_frame_url', 'result.last_frame_url']);
  return {
    state: 'completed',
    output: response,
    ...(posterUrl ? { metadata: { posterUrl } } : {}),
  };
}

async function postJson(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
  url: string,
  body: Record<string, unknown>,
  context: HttpExecutionContext,
): Promise<Record<string, unknown>> {
  return requestJson(
    fetchImpl,
    ARK_PROVIDER_ID,
    jsonRequest(url, body, authHeaders(apiKey, context.headers)),
    context.signal,
  );
}

function authHeaders(apiKey: string, extra?: Record<string, string | undefined>): Record<string, string> {
  return mergeHeaders({ authorization: `Bearer ${apiKey}` }, extra);
}

function readOperationTaskId(operation: unknown): string {
  if (!operation || typeof operation !== 'object') return '';
  const taskId = (operation as Record<string, unknown>).taskId;
  return typeof taskId === 'string' ? taskId : '';
}

function readStatus(body: Record<string, unknown>): 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' {
  const status = (readPath(body, ['status', 'data.status', 'task.status']) ?? 'running').toLowerCase();
  if (['success', 'succeeded', 'completed', 'done'].includes(status)) return 'succeeded';
  if (['failed', 'error'].includes(status)) return 'failed';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  if (['queued', 'pending', 'submitted'].includes(status)) return 'queued';
  return 'running';
}

function readPath(input: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    let value: unknown = input;
    for (const part of path.split('.')) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    }
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function numberAt(input: Record<string, unknown>, paths: string[]): number | undefined {
  const value = readPath(input, paths);
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
