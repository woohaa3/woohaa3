import type { JSONValue } from '@ai-sdk/provider';
import type { PptaskDescription, PptaskModelType, PptaskProvider } from '../../core/types.ts';
import { createHttpProvider } from '../shared/provider.ts';
import { basicAuth, jsonRequest, mergeHeaders, normalizeProviderConfig, request, requestJson } from '../shared/http.ts';
import { isRecord } from '../shared/input.ts';
import type { CommonProviderOptions, HttpExecutionContext, HttpProviderProtocol, HttpStatus } from '../shared/types.ts';

export type ModernProviderId = 'fish' | 'deepinfra' | 'openrouter' | 'tavus' | 'scenario' | 'xai' | 'cloudflare' | 'vertex' | 'bedrock' | 'azure' | 'nvidia' | 'leonardo' | 'heygen' | 'did' | 'cartesia' | 'deepgram' | 'fireworks';

export type ModernProviderOptions = CommonProviderOptions & {
  apiKey: string;
  operationPath?: string;
  catalogURL?: string;
  accountId?: string;
  authScheme?: 'bearer' | 'basic' | 'api-key';
  referer?: string;
};

export type ModernCatalogItem = { id: string; name?: string; description?: string; type?: string; raw: unknown };
export type ModernProviderMetadata = { catalogSource: 'dynamic' | 'openapi' | 'docs' | 'account' | 'none'; describeGranularity: 'resource' | 'operation' | 'task-family'; media: Array<'image' | 'video' | 'audio' | 'avatar' | 'workflow'> };

export const MODERN_PROVIDER_METADATA: Record<ModernProviderId, ModernProviderMetadata> = {
  fish: { catalogSource: 'dynamic', describeGranularity: 'operation', media: ['audio'] },
  deepinfra: { catalogSource: 'dynamic', describeGranularity: 'task-family', media: ['image', 'video', 'audio'] },
  openrouter: { catalogSource: 'dynamic', describeGranularity: 'task-family', media: ['image', 'audio'] },
  tavus: { catalogSource: 'openapi', describeGranularity: 'operation', media: ['video', 'avatar'] },
  scenario: { catalogSource: 'account', describeGranularity: 'operation', media: ['image', 'video', 'workflow'] },
  xai: { catalogSource: 'account', describeGranularity: 'task-family', media: ['image', 'video', 'audio'] },
  cloudflare: { catalogSource: 'account', describeGranularity: 'task-family', media: ['image', 'video', 'audio'] },
  vertex: { catalogSource: 'account', describeGranularity: 'operation', media: ['image', 'video', 'audio'] },
  bedrock: { catalogSource: 'account', describeGranularity: 'task-family', media: ['image', 'video', 'audio'] },
  azure: { catalogSource: 'account', describeGranularity: 'task-family', media: ['image', 'video', 'audio'] },
  nvidia: { catalogSource: 'dynamic', describeGranularity: 'task-family', media: ['image', 'video', 'audio'] },
  leonardo: { catalogSource: 'account', describeGranularity: 'operation', media: ['image', 'video'] },
  heygen: { catalogSource: 'account', describeGranularity: 'resource', media: ['video', 'avatar', 'audio'] },
  did: { catalogSource: 'account', describeGranularity: 'resource', media: ['video', 'avatar', 'audio'] },
  cartesia: { catalogSource: 'account', describeGranularity: 'operation', media: ['audio'] },
  deepgram: { catalogSource: 'docs', describeGranularity: 'task-family', media: ['audio'] },
  fireworks: { catalogSource: 'account', describeGranularity: 'task-family', media: ['image', 'video', 'audio'] },
};

const defaults: Record<ModernProviderId, string> = {
  fish: 'https://api.fish.audio', deepinfra: 'https://api.deepinfra.com', openrouter: 'https://openrouter.ai',
  tavus: 'https://tavusapi.com', scenario: 'https://api.cloud.scenario.com', xai: 'https://api.x.ai',
  cloudflare: 'https://api.cloudflare.com', vertex: '', bedrock: '', azure: '', nvidia: 'https://integrate.api.nvidia.com',
  leonardo: 'https://cloud.leonardo.ai', heygen: 'https://api.heygen.com', did: 'https://api.d-id.com',
  cartesia: 'https://api.cartesia.ai', deepgram: 'https://api.deepgram.com', fireworks: 'https://api.fireworks.ai',
};

const catalogDefaults: Partial<Record<ModernProviderId, string>> = {
  fish: 'https://api.fish.audio/model', deepinfra: 'https://api.deepinfra.com/models/list', openrouter: 'https://openrouter.ai/api/v1/models',
  nvidia: 'https://integrate.api.nvidia.com/v1/models', fireworks: 'https://api.fireworks.ai/inference/v1/models', scenario: 'https://api.cloud.scenario.com/v1/models',
  tavus: 'https://tavusapi.com/v2/faces', heygen: 'https://api.heygen.com/v2/avatars', deepgram: 'https://api.deepgram.com/v1/models', cartesia: 'https://api.cartesia.ai/voices',
};

const asyncSpecs: Partial<Record<ModernProviderId, { create: string; status(id: string): string; ids: string[] }>> = {
  tavus: { create: '/v2/videos', status: id => `/v2/videos/${encodeURIComponent(id)}`, ids: ['video_id', 'id'] },
  heygen: { create: '/v2/video/generate', status: id => `/v1/video_status.get?video_id=${encodeURIComponent(id)}`, ids: ['video_id', 'id'] },
  did: { create: '/talks', status: id => `/talks/${encodeURIComponent(id)}`, ids: ['id', 'talk_id'] },
  leonardo: { create: '/api/rest/v1/generations', status: id => `/api/rest/v1/generations/${encodeURIComponent(id)}`, ids: ['generationId', 'generation_id', 'id'] },
};

export async function listModernCatalog(providerId: ModernProviderId, options: ModernProviderOptions): Promise<ModernCatalogItem[]> {
  const config = normalizeProviderConfig(providerId, options, defaults[providerId]);
  let url = options.catalogURL ?? catalogDefaults[providerId];
  if (!url && providerId === 'cloudflare' && options.accountId) url = `${config.baseURL}/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/models/search`;
  if (!url) throw new Error(`${providerId} requires catalogURL for catalog discovery`);
  const raw = await requestJson<any>(config.fetch, providerId, { url, headers: authHeaders(options, config.headers) });
  const items = arraySource(raw);
  return items.map((item: any) => ({ id: String(item.id ?? item.model_name ?? item.model ?? item.avatar_id ?? item.voice_id ?? item.face_id ?? item.name ?? ''), name: item.name ?? item.model_name ?? item.id, description: item.description, type: item.type ?? item.task, raw: item })).filter(item => item.id);
}

function createModernProvider(providerId: ModernProviderId, options: ModernProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig(providerId, options, defaults[providerId]);
  if (!config.baseURL) throw new Error(`${providerId} baseURL is required`);
  const auth = authHeaders(options, config.headers);
  const execute = (context: HttpExecutionContext) => executeSync(providerId, context, options, config.baseURL, config.fetch, auth);
  const protocol: HttpProviderProtocol = {
    providerId, fetch: config.fetch,
    mode: (_modelId, modelType) => asyncSpecs[providerId] || modelType === 'video' ? 'async' : 'sync',
    execute,
    async start(context) {
      const spec = asyncSpecs[providerId];
      if (!spec) {
        const output = await execute(context);
        return {
          operation: { completed: output as JSONValue },
          metadata: { completedSynchronously: true } as Record<string, JSONValue>,
        };
      }
      const raw = await requestJson<any>(config.fetch, providerId, jsonRequest(`${config.baseURL}${spec.create}`, context.input, mergeHeaders(auth, context.headers)), context.signal);
      const taskId = firstString(raw, spec.ids) ?? firstString(raw.data, spec.ids);
      if (!taskId) throw new Error(`${providerId} create response did not include a task id`);
      return {
        operation: { taskId, statusURL: `${config.baseURL}${spec.status(taskId)}` },
        metadata: { taskId } as Record<string, JSONValue>,
      };
    },
    async status(context) {
      const operationRecord = isRecord(context.operation)
        ? context.operation as Record<string, unknown>
        : undefined;
      if (operationRecord?.completed !== undefined) {
        return { state: 'completed', output: operationRecord.completed };
      }
      const operation = taskOperation(context.operation);
      const raw = await requestJson<any>(config.fetch, providerId, { url: operation.statusURL, headers: mergeHeaders(auth, context.headers) }, context.signal);
      return modernStatus(providerId, raw, operation.taskId);
    },
    describe: async (modelId, modelType) => modernDescription(providerId, modelId, modelType),
  };
  return createHttpProvider(protocol, options);
}

async function executeSync(providerId: ModernProviderId, context: HttpExecutionContext, options: ModernProviderOptions, baseURL: string, fetchImpl: typeof globalThis.fetch, auth: Record<string, string>): Promise<unknown> {
  const path = operationPath(providerId, context.modelId, options);
  const body = { ...context.input };
  if (['openrouter', 'xai'].includes(providerId) && body.model === undefined) body.model = context.modelId;
  const response = await request(fetchImpl, providerId, jsonRequest(`${baseURL}${path}`, body, mergeHeaders(auth, context.headers, providerId === 'openrouter' ? { 'http-referer': options.referer ?? 'https://github.com/sd-ppp/pptask' } : undefined)), context.signal);
  const contentType = response.headers.get('content-type') ?? '';
  if (/^(audio|video|image)\//i.test(contentType) || contentType.includes('octet-stream')) {
    const bytes = new Uint8Array(await response.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    return { url: `data:${contentType || 'application/octet-stream'};base64,${btoa(binary)}` };
  }
  const text = await response.text(); try { return JSON.parse(text); } catch { return { text }; }
}

function operationPath(providerId: ModernProviderId, modelId: string, options: ModernProviderOptions): string {
  if (options.operationPath) return slash(options.operationPath);
  if (providerId === 'fish') return '/v1/tts';
  if (providerId === 'deepinfra') return `/v1/inference/${modelId.replace(/^\/+/, '')}`;
  if (providerId === 'openrouter' || providerId === 'xai') return '/v1/chat/completions';
  if (providerId === 'cloudflare' && options.accountId) return `/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${modelId}`;
  if (modelId.startsWith('/')) return modelId;
  throw new Error(`${providerId} requires operationPath for model ${modelId}`);
}

function modernStatus(providerId: ModernProviderId, raw: any, taskId: string): HttpStatus {
  const status = String(raw.status ?? raw.state ?? raw.data?.status ?? raw.data?.state ?? '').toLowerCase();
  const metadata = { taskId, status, raw } as any;
  if (/fail|error|cancel/.test(status)) return { state: 'failed', error: String(raw.error ?? raw.message ?? `${providerId} task ${status}`), metadata };
  if (/complete|success|done|ready/.test(status)) return { state: 'completed', output: raw, metadata };
  return { state: 'pending', phase: /run|process|generat/.test(status) ? 'running' : 'queued', progress: typeof raw.progress === 'number' ? raw.progress : undefined, metadata };
}

function modernDescription(providerId: ModernProviderId, modelId: string, modelType: PptaskModelType): PptaskDescription { return { providerId, modelId, modelType, title: modelId,
  inputSchema: providerId === 'fish' ? { type: 'object', properties: { text: { type: 'string' }, reference_id: { type: 'string' }, format: { type: 'string' } } }
    : { type: 'object', properties: { prompt: { type: 'string' }, input: { type: 'object' } } },
  capabilities: { ...MODERN_PROVIDER_METADATA[providerId], operation: asyncSpecs[providerId] ? 'job' : 'request', cancel: false } }; }

function authHeaders(options: ModernProviderOptions, base: Record<string, string>): Record<string, string> { if (options.authScheme === 'basic') return { ...base, authorization: basicAuth(`${options.apiKey}:`) }; if (options.authScheme === 'api-key') return { ...base, 'x-api-key': options.apiKey }; return { ...base, authorization: `Bearer ${options.apiKey}` }; }
function arraySource(raw: any): any[] { if (Array.isArray(raw)) return raw; for (const value of [raw.data, raw.data?.avatars, raw.data?.voices, raw.models, raw.stt, raw.tts, raw.voices, raw.items, raw.result?.models, raw.result]) if (Array.isArray(value)) return value; return []; }
function firstString(value: any, fields: string[]): string | undefined { for (const field of fields) if (typeof value?.[field] === 'string') return value[field]; return undefined; }
function taskOperation(value: unknown): { taskId: string; statusURL: string } { if (isRecord(value) && typeof value.taskId === 'string' && typeof value.statusURL === 'string') return value as any; throw new Error('Invalid modern provider operation reference'); }
function slash(value: string): string { return value.startsWith('/') ? value : `/${value}`; }

export const createFishProvider = (options: ModernProviderOptions) => createModernProvider('fish', options);
export const createDeepinfraProvider = (options: ModernProviderOptions) => createModernProvider('deepinfra', options);
export const createOpenrouterProvider = (options: ModernProviderOptions) => createModernProvider('openrouter', options);
export const createTavusProvider = (options: ModernProviderOptions) => createModernProvider('tavus', options);
export const createScenarioProvider = (options: ModernProviderOptions) => createModernProvider('scenario', options);
export const createXaiProvider = (options: ModernProviderOptions) => createModernProvider('xai', options);
export const createCloudflareProvider = (options: ModernProviderOptions) => createModernProvider('cloudflare', options);
export const createVertexProvider = (options: ModernProviderOptions) => createModernProvider('vertex', options);
export const createBedrockProvider = (options: ModernProviderOptions) => createModernProvider('bedrock', options);
export const createAzureProvider = (options: ModernProviderOptions) => createModernProvider('azure', options);
export const createNvidiaProvider = (options: ModernProviderOptions) => createModernProvider('nvidia', options);
export const createLeonardoProvider = (options: ModernProviderOptions) => createModernProvider('leonardo', options);
export const createHeygenProvider = (options: ModernProviderOptions) => createModernProvider('heygen', options);
export const createDidProvider = (options: ModernProviderOptions) => createModernProvider('did', options);
export const createCartesiaProvider = (options: ModernProviderOptions) => createModernProvider('cartesia', options);
export const createDeepgramProvider = (options: ModernProviderOptions) => createModernProvider('deepgram', options);
export const createFireworksProvider = (options: ModernProviderOptions) => createModernProvider('fireworks', options);
