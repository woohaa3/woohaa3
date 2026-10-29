import { getAppPublicFetch } from './app-base-path.js';

export type SceneReceipt = {
  canvasId: string; operationId: string; packageHash: string; importedAt?: string;
  manifest: { format: 'woohaa-scene'; version: 1; datasetId: string; contentHash: string;
    recipeVersion: number; kind: 'text'|'image'|'model3d'; title: string;
    views: {overview200: string[];overview300: string[];distant: string[]}; };
};
export type SceneJob = { operationId: string; canvasId: string; packageHash: string;
  phase: 'uploaded'|'validating'|'staging-media'|'committing'|'ready'|'failed'|'cancelled';
  completedMedia: number; totalMedia: number; error?: {code:string;message:string;retryable:boolean}; };
export function decodeReceipt(value: unknown, canvasId: string): SceneReceipt | null {
  const r = value as SceneReceipt | null;
  const m = r?.manifest;
  if (!r || r.canvasId !== canvasId || typeof r.operationId !== 'string' || typeof r.packageHash !== 'string'
    || !m || m.format !== 'woohaa-scene' || m.version !== 1 || typeof m.datasetId !== 'string'
    || typeof m.contentHash !== 'string' || !Number.isInteger(m.recipeVersion)
    || !['text','image','model3d'].includes(m.kind) || typeof m.title !== 'string') return null;
  for (const key of ['overview200','overview300','distant'] as const) {
    const ids = m.views?.[key];
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return null;
  }
  return r;
}
export function createScenePackageClient(fetcher: typeof fetch = getAppPublicFetch()) {
  const base = '/api/scene-packages';
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(base + path, init);
    if (!response.ok) throw new Error(response.status === 503 ? '当前宿主不支持场景包，请使用本机桌面宿主。' : `场景包操作失败（${response.status}）`);
    return response.json() as Promise<T>;
  }
  return {
    available: (signal?: AbortSignal) => request<{available:boolean}>('',{signal}),
    receipt: async (canvasId:string, signal?:AbortSignal) => {
      const response = await fetcher(`${base}/canvases/${encodeURIComponent(canvasId)}`, {signal});
      if(response.status === 404 || response.status === 503) return null;
      if(!response.ok) throw new Error('无法读取场景导入回执');
      return decodeReceipt((await response.json()).receipt,canvasId);
    },
    importFile: (file: Blob, importId:string, copy=false, signal?:AbortSignal) => request<{job:SceneJob;duplicate?:boolean;receipt?:SceneReceipt}>(copy ? '?copy=1' : '',{
      method:'POST',headers:{'Content-Type':'application/octet-stream','X-Woohaa-Import-Id':importId},body:file,signal}),
    job: (id:string,signal?:AbortSignal) => request<{job:SceneJob}>(`/jobs/${encodeURIComponent(id)}`,{signal}),
    cancel: (id:string,signal?:AbortSignal) => request<{job:SceneJob}>(`/jobs/${encodeURIComponent(id)}/cancel`,{method:'POST',signal}),
    reset: (canvasId:string,importId:string,signal?:AbortSignal) => request<{job:SceneJob}>(`/canvases/${encodeURIComponent(canvasId)}/reset`,{
      method:'POST',headers:{'X-Woohaa-Import-Id':importId},signal}),
  };
}
