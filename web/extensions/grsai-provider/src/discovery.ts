/**
 * 从 grsai 的公开模型列表发现可用模型。
 *
 * `POST /client/serverGrsai/getModelListV2` 不需要 Key：返回 `{code,msg,data:{list:[{name,type,
 * closeModel,maintenance,...}]}}`。`closeModel` 为真（含维护中的）不注册；类型只认
 * image / video / text，其余（例如未来的 3D）跳过。
 */
import type { GenerationModelDefinition } from "@woohaa3/contracts";
import { GRSAI_MODEL_LIST_PATH, GRSAI_PROVIDER_ID, grsaiOrigin } from "./shared.js";

export type GrsaiKind = "image" | "video" | "language";

export type GrsaiModel = {
  id: string;
  kind: GrsaiKind;
  title: string;
};

export type DiscoveryResult =
  | { ok: true; models: GrsaiModel[]; message?: string }
  | { ok: false; message: string };

const DISCOVERY_TIMEOUT_MS = 15_000;

export function classifyListedModel(type: string): GrsaiKind | undefined {
  const value = type.trim().toLowerCase();
  if (value === "image") return "image";
  if (value === "video") return "video";
  if (value === "text" || value === "chat" || value === "llm") return "language";
  return undefined;
}

export function parseModelList(payload: unknown): GrsaiModel[] {
  const record = isRecord(payload) ? payload : {};
  const data = isRecord(record.data) ? record.data : undefined;
  const list = Array.isArray(data?.list) ? data.list : Array.isArray(record.data) ? record.data : [];
  const seen = new Set<string>();
  const models: GrsaiModel[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!id || seen.has(id)) continue;
    if (raw.closeModel === true) continue;
    if (typeof raw.maintenance === "string" && raw.maintenance.trim() !== "") continue;
    const kind = classifyListedModel(typeof raw.type === "string" ? raw.type : "");
    if (!kind) continue;
    seen.add(id);
    models.push({ id, kind, title: id });
  }
  models.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return models;
}

export function grsaiModelDefinitions(models: readonly GrsaiModel[]): GenerationModelDefinition[] {
  return models.map((model) => ({
    providerId: GRSAI_PROVIDER_ID,
    providerModelId: model.id,
    modelType: model.kind,
    title: model.title,
    promptRequirement: "required" as const
  }));
}

export async function discoverGrsaiModels(options: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${grsaiOrigin(options.baseUrl)}${GRSAI_MODEL_LIST_PATH}`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {})
      },
      body: "{}",
      signal: AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS)
    });
    if (!response.ok) return { ok: false, message: `读取 grsai 模型表失败（HTTP ${response.status}）` };
    const payload = (await response.json()) as { code?: unknown; msg?: unknown };
    if (payload?.code !== undefined && payload.code !== 0 && payload.code !== "0") {
      return { ok: false, message: typeof payload.msg === "string" && payload.msg.trim() ? payload.msg.trim() : `模型表返回 code=${String(payload.code)}` };
    }
    const models = parseModelList(payload);
    if (models.length === 0) return { ok: false, message: "模型表里没有可用的图片、视频或文本模型" };
    return { ok: true, models };
  } catch (error) {
    return { ok: false, message: `读取 grsai 模型表失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
