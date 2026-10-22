/**
 * RunningHub Provider 插件的共享身份、API 逻辑模型清单与路由
 * （change: 2026-10-06-add-runninghub-api-models-and-provider-credentials，任务 1.2–1.3 / design D1/D1b）。
 *
 * 只含身份、`data/models.json` 的确定性清单、纯函数路由与 schema；不含执行实现、网络或秘密。
 * 前后端均可导入。
 */
import type {
  ApplicationExtensionMetadata,
  GenerationModelDefinition,
  PromptRequirement
} from "@woohaa3/contracts";
import modelsData from "../data/models.json";

// 稳定 identity 移到叶子模块，使纯 metadata / 薄 activation 入口不必可达模型清单 barrel。
export * from "./shared/identity.js";
import { RUNNINGHUB_PLUGIN_ID, RUNNINGHUB_PROVIDER_ID } from "./shared/identity.js";

/** 受控 API 地址（写死在插件内，MUST NOT 由用户输入）。全球站（CN 节点已下线）。 */
export const DEFAULT_RUNNINGHUB_API_BASE = "https://www.runninghub.ai/openapi/v2";

export type RunningHubMediaKind = "image" | "video" | "audio";

/** 路由匹配条件（按数组顺序取首个命中；缺省表示兜底）。 */
export type RunningHubRouteMatch = {
  /** 至少需要这么多图片参考（与 `anyMedia` 为「或」关系）。 */
  minImages?: number;
  /** 至少需要其中之一类参考（与 `minImages` 为「或」关系）。 */
  anyMedia?: RunningHubMediaKind[];
  /** 仅当该参数取此值（如 `quality=ultra`）。 */
  param?: { key: string; value: string };
};

export type RunningHubRoute = {
  /** 具体 API endpoint（不含 `api/` 前缀）。 */
  endpoint: string;
  /** 该操作的媒体字段：插件据此把稳定引用放入对应字段。 */
  collect: string[];
  match: RunningHubRouteMatch;
};

export type RunningHubLogicalModel = {
  /** 逻辑模型 id（endpoint 去掉操作后缀）。 */
  id: string;
  family: string;
  outputType: "image" | "video";
  label: string;
  promptRequirement: PromptRequirement;
  cancel: "local" | "remote" | "unsupported";
  routes: RunningHubRoute[];
  inputSchema: Record<string, unknown>;
  defaultInput: Record<string, unknown>;
};

export type RunningHubRegistry = {
  provider: string;
  generatedFrom: string;
  models: RunningHubLogicalModel[];
};

/** 解析并校验入库清单（失败即抛：构建时产物不应静默漂移）。 */
export function runningHubRegistry(): RunningHubRegistry {
  if (cachedRegistry) return cachedRegistry;
  const raw = modelsData as unknown as RunningHubRegistry;
  if (!raw || !Array.isArray(raw.models)) throw new Error("RunningHub 模型清单缺失或非法");
  for (const model of raw.models) {
    if (typeof model.id !== "string" || model.id === "") throw new Error("RunningHub 逻辑模型缺少 id");
    if (model.outputType !== "image" && model.outputType !== "video") throw new Error(`RunningHub 模型 ${model.id} outputType 非法`);
    if (!Array.isArray(model.routes) || model.routes.length === 0) throw new Error(`RunningHub 模型 ${model.id} 缺少 routes`);
  }
  cachedRegistry = raw;
  return raw;
}

let cachedRegistry: RunningHubRegistry | undefined;

/** 逻辑模型 id → catalog 身份（`api/<id>`）。执行 endpoint 由 `resolveProviderModel` 决定。 */
export function runningHubProviderModelId(logicalId: string): string {
  return `api/${logicalId}`;
}

/** catalog 身份 `api/<id>` → 逻辑模型。 */
export function findRunningHubModel(providerModelId: string): RunningHubLogicalModel | undefined {
  if (!providerModelId.startsWith("api/")) return undefined;
  const id = providerModelId.slice("api/".length);
  return runningHubRegistry().models.find((model) => model.id === id);
}

/** 由入库清单构造生成模型定义（资源定义；执行目标由插件路由解析）。 */
export function runningHubModelDefinitions(): GenerationModelDefinition[] {
  return runningHubRegistry().models.map((model) => ({
    providerId: RUNNINGHUB_PROVIDER_ID,
    providerModelId: runningHubModelProviderId(model),
    modelType: model.outputType,
    title: model.label,
    promptRequirement: model.promptRequirement,
    cancel: model.cancel,
    inputSchema: model.inputSchema,
    defaultInput: model.defaultInput
  }));
}

function runningHubModelProviderId(model: RunningHubLogicalModel): string {
  return runningHubProviderModelId(model.id);
}

/** 规范参考输入（与契约 `GenerationPrepareInput.references` 同形）。 */
export type RunningHubReference = {
  role: string;
  mediaKind?: string;
  mediaType: string;
  /** 执行期地址；`referenceHandling: "storage-key"` 的 Provider 不会走到这里，缺省即跳过。 */
  url?: string;
};

export type RunningHubRouteInput = {
  prompt: string;
  parameters: Record<string, unknown>;
  references: ReadonlyArray<RunningHubReference>;
};

function mediaKindOf(reference: RunningHubReference): RunningHubMediaKind {
  if (reference.mediaKind === "image" || reference.mediaKind === "video" || reference.mediaKind === "audio") {
    return reference.mediaKind;
  }
  const role = reference.role.toLowerCase();
  if (role.includes("video")) return "video";
  if (role.includes("audio") || role.includes("voice")) return "audio";
  return "image";
}

/** 依据输入（图片数量、视频/音频参考、`quality` 参数）选择具体 route。 */
export function pickRunningHubRoute(model: RunningHubLogicalModel, input: RunningHubRouteInput): RunningHubRoute {
  const counts = countMedia(input.references);
  for (const route of model.routes) {
    const match = route.match;
    if (match.param) {
      if (String(input.parameters[match.param.key] ?? "") !== match.param.value) continue;
    }
    // minImages 与 anyMedia 为「或」：命中任一即可进入该 route。
    const mediaHit =
      (match.minImages !== undefined && counts.image >= match.minImages) ||
      (match.anyMedia !== undefined && match.anyMedia.some((kind) => counts[kind] > 0));
    if (!mediaHit && (match.minImages !== undefined || match.anyMedia !== undefined)) continue;
    return route;
  }
  return model.routes[model.routes.length - 1]!;
}

function countMedia(references: ReadonlyArray<RunningHubReference>): Record<RunningHubMediaKind, number> {
  const counts: Record<RunningHubMediaKind, number> = { image: 0, video: 0, audio: 0 };
  for (const reference of references) {
    if (!reference.url) continue;
    counts[mediaKindOf(reference)] += 1;
  }
  return counts;
}

/** 路由选中的 endpoint 的完整 providerModelId（`api/<endpoint>`）。 */
export function runningHubEndpointModelId(route: RunningHubRoute): string {
  return `api/${route.endpoint}`;
}

/**
 * 把规范输入编译为 RunningHub `providerOptions.runninghub.input`。
 *
 * - `prompt` 只在非空时写入；
 * - 参数按路由选中操作的原样写入，但剥离**仅路由用**的参数（`x-pptask-routing`）；
 * - 媒体引用按 route.collect 放入对应字段：复数（`imageUrls`）收全部，单数字段（`firstFrameUrl`）按序取一。
 */
export function prepareRunningHubInput(
  model: RunningHubLogicalModel,
  route: RunningHubRoute,
  input: RunningHubRouteInput
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (input.prompt !== "") fields.prompt = input.prompt;

  const properties = (model.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(input.parameters)) {
    if (value === undefined) continue;
    if (properties[key]?.["x-pptask-routing"] === true) continue;
    fields[key] = value;
  }

  assignMediaFields(fields, route.collect, input.references);
  return fields;
}

function assignMediaFields(
  fields: Record<string, unknown>,
  collect: readonly string[],
  references: ReadonlyArray<RunningHubReference>
): void {
  const imageFields = collect.filter((field) => /image|frame/i.test(field));
  const videoFields = collect.filter((field) => /video/i.test(field));
  const audioFields = collect.filter((field) => /audio/i.test(field));

  assignKind(fields, imageFields, references.filter((reference) => reference.url && mediaKindOf(reference) === "image"));
  assignKind(fields, videoFields, references.filter((reference) => reference.url && mediaKindOf(reference) === "video"));
  assignKind(fields, audioFields, references.filter((reference) => reference.url && mediaKindOf(reference) === "audio"));
}

function assignKind(
  fields: Record<string, unknown>,
  candidateFields: readonly string[],
  references: ReadonlyArray<RunningHubReference>
): void {
  if (candidateFields.length === 0 || references.length === 0) return;
  const pluralField = candidateFields.find((field) => field.endsWith("s"));
  if (pluralField) {
    fields[pluralField] = references
      .map((reference) => reference.url)
      .filter((url): url is string => typeof url === "string" && url !== "");
    return;
  }
  // 单数字段（首尾帧等）：按序各取一个。
  candidateFields.forEach((field, index) => {
    const reference = references[index];
    if (reference?.url) fields[field] = reference.url;
  });
}

export const RUNNINGHUB_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: RUNNINGHUB_PLUGIN_ID,
  name: "RunningHub Provider",
  description: "RunningHub 生成 Provider：入库的 API 逻辑模型（t2i/i2i/文生视频/图生视频/多模态）。",
  version: "2.0.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "runninghub-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};
