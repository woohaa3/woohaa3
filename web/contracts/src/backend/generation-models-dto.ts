/**
 * 生成模型管理协议 DTO
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1 / design D2）。
 *
 * 管理员经平台管理 API 增删/启停/设默认模型；权威在生成模型策略存储。公开响应不含秘密。
 * 路径：`/api/generation-models`、`/api/generation-models/config`（同源 ingress）。
 */
import { isJsonObject, isNonNegativeInteger } from "../validation.js";

export const DEFAULT_GENERATION_MODELS_BASE_PATH = "/api/generation-models";

/** 单个模型策略（公开视图）。 */
export type GenerationModelPolicyView = {
  modelKey: string;
  providerId: string;
  modelType: "language" | "image" | "video" | "audio";
  title?: string;
  enabled: boolean;
  isDefault: boolean;
  order?: number;
  taskTimeoutMs?: number;
  interaction?: { id: string; version: number };
  tombstone?: boolean;
  /** 是否在注册表中可执行（未注册 = 不可执行，仅策略占位）。 */
  executable: boolean;
  /**
   * 提供该模型的宿主插件 id（change: 2026-10-20-reserve-remote-generation-provider 的展示补齐）。
   *
   * 由注册表投影得出：Provider 注册时声明的 `extensionId`。设置页用它把没有
   * `providers.<id>` 配置段的 Provider（例如「服务端接入」）的模型归到自己的卡片。
   * 策略里残留的历史行（Provider 已卸载）没有这个字段。缺省 = 旧宿主 / 历史策略行。
   */
  extensionId?: string;
};

export type GenerationModelsSnapshot = {
  revision: number;
  initialized: boolean;
  models: GenerationModelPolicyView[];
  /**
   * 当前任务目录修订（change: 2026-10-20-reserve-remote-generation-provider）。
   *
   * 浏览器已经周期轮询本快照；Provider 注册/可用性/模型描述版本变化时该值单调前进，
   * 前端据此使任务目录缓存失效。缺省视为「无此信号」（旧宿主）。
   */
  catalogRevision?: number;
};

/** 管理写入请求（expectedRevision 并发控制）。 */
export type GenerationModelsWriteRequest = {
  expectedRevision: number;
  models: Array<{
    modelKey: string;
    enabled: boolean;
    isDefault?: boolean;
    title?: string;
    order?: number;
    taskTimeoutMs?: number;
    interaction?: { id: string; version: number };
    tombstone?: boolean;
  }>;
};

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

export function decodeGenerationModelsWrite(body: unknown): DecodeResult<GenerationModelsWriteRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是 JSON 对象");
  if (!isNonNegativeInteger(body.expectedRevision)) return fail("malformed-request", "expectedRevision 必须是非负整数");
  if (!Array.isArray(body.models)) return fail("malformed-request", "models 必须是数组");
  const models: GenerationModelsWriteRequest["models"] = [];
  for (const [index, entry] of body.models.entries()) {
    if (!isJsonObject(entry)) return fail("malformed-request", `models[${index}] 必须是对象`);
    if (typeof entry.modelKey !== "string" || entry.modelKey === "") return fail("malformed-request", `models[${index}].modelKey 非法`);
    if (typeof entry.enabled !== "boolean") return fail("malformed-request", `models[${index}].enabled 必须是布尔值`);
    if (entry.isDefault !== undefined && typeof entry.isDefault !== "boolean") return fail("malformed-request", `models[${index}].isDefault 必须是布尔值`);
    if (entry.tombstone !== undefined && typeof entry.tombstone !== "boolean") return fail("malformed-request", `models[${index}].tombstone 必须是布尔值`);
    if (entry.title !== undefined && typeof entry.title !== "string") return fail("malformed-request", `models[${index}].title 必须是字符串`);
    if (entry.order !== undefined && (!Number.isInteger(entry.order) || (entry.order as number) < 0)) return fail("malformed-request", `models[${index}].order 非法`);
    if (entry.taskTimeoutMs !== undefined && (!Number.isInteger(entry.taskTimeoutMs) || (entry.taskTimeoutMs as number) < 0)) return fail("malformed-request", `models[${index}].taskTimeoutMs 非法`);
    if (entry.interaction !== undefined && !isInteraction(entry.interaction)) return fail("malformed-request", `models[${index}].interaction 非法`);
    models.push({
      modelKey: entry.modelKey,
      enabled: entry.enabled,
      ...(entry.isDefault !== undefined ? { isDefault: entry.isDefault } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.order !== undefined ? { order: entry.order as number } : {}),
      ...(entry.taskTimeoutMs !== undefined ? { taskTimeoutMs: entry.taskTimeoutMs as number } : {}),
      ...(entry.tombstone !== undefined ? { tombstone: entry.tombstone } : {}),
      ...(entry.interaction !== undefined ? { interaction: entry.interaction as { id: string; version: number } } : {})
    });
  }
  return { ok: true, value: { expectedRevision: body.expectedRevision, models } };
}

function isInteraction(value: unknown): value is { id: string; version: number } {
  return isJsonObject(value) && typeof value.id === "string" && value.id !== "" && isNonNegativeInteger(value.version) && value.version >= 1;
}
