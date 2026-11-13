/**
 * 从 TokenHub `GET /v1/models` 读取当前可调用模型。
 *
 * 响应没有类型字段，只有 id / name / status。能对上生成协议的 id 归到图片或视频；
 * 其余在线模型默认是语言模型（Chat Completions）。语音、向量、3D 和没有协议的
 * 视觉模型不注册。
 */
import { reasoningEffortsForModel, type GenerationModelDefinition } from "@woohaa3/contracts";
import { TOKENHUB_PROVIDER_ID, tokenHubOrigin } from "./shared.js";
import { routeModel, type TokenHubKind } from "./routes.js";

export type DiscoveredModel = {
  id: string;
  modelType: TokenHubKind;
  title: string;
};

export type DiscoveryResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; message: string };

const DISCOVERY_TIMEOUT_MS = 15_000;
const USABLE_STATUS = new Set(["online", "pre-offline"]);

/** 这些 id 不是 Chat Completions，也不能落到已实现的图片/视频协议。 */
const NON_CHAT = /embedding|asr|speech|music|voice|dubbing|3d|world|tripo|rigging|retopology|texture|panorama|vita|hy-vision|hunyuan-t1-vision|hunyuan-turbos-vision/i;

export function classifyListedModel(id: string): TokenHubKind | undefined {
  const route = routeModel(id);
  if (route) return route.kind;
  if (NON_CHAT.test(id) || /image|video/i.test(id)) return undefined;
  return "language";
}

export function parseModelList(payload: unknown): DiscoveredModel[] {
  const list = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { id?: unknown; name?: unknown; status?: unknown };
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const status = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    if (status && !USABLE_STATUS.has(status)) continue;
    const modelType = id ? classifyListedModel(id) : undefined;
    if (!id || !modelType || seen.has(id)) continue;
    seen.add(id);
    const title = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
    models.push({ id, modelType, title });
  }
  models.sort((a, b) => a.modelType.localeCompare(b.modelType) || a.id.localeCompare(b.id));
  return models;
}

export function tokenHubModelDefinitions(models: readonly DiscoveredModel[]): GenerationModelDefinition[] {
  return models.map((model) => ({
    providerId: TOKENHUB_PROVIDER_ID,
    providerModelId: model.id,
    modelType: model.modelType,
    title: model.title,
    promptRequirement: "required" as const,
    ...(model.modelType === "language" && reasoningEffortsForModel(model.id)
      ? { capabilityFacts: { reasoning: { supported: true, efforts: reasoningEffortsForModel(model.id) } } }
      : {})
  }));
}

export async function discoverTokenHubModels(options: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${tokenHubOrigin(options.baseUrl)}/v1/models`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS)
    });
    if (!response.ok) return { ok: false, message: `读取 TokenHub 模型目录失败（HTTP ${response.status}）` };
    return { ok: true, models: parseModelList(await response.json()) };
  } catch (error) {
    return { ok: false, message: `读取 TokenHub 模型目录失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
