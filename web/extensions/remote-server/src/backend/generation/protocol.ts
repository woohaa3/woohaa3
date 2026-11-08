/**
 * 服务端托管生成的线格式解释（change: 2026-10-20-reserve-remote-generation-provider，tasks 5.1/5.4）。
 *
 * 契约冻结在本仓库的 `api/gen/es/woohaa/generation/v1alpha1/generation_pb.ts`。本模块只做两件事：
 * 1. **容忍 ProtoJSON**：uint64 可能是字符串、枚举可能是字符串或数字、未知字段一律忽略；
 * 2. **归一成客户端 catalog 契约**（`GenerationModelDefinition`）与 pptask 的任务结果形状。
 *
 * 为什么不用生成的 ES 绑定：宿主只发几个 HTTP/JSON 调用，不为它拖一整套生成代码；两端共享的
 * 是生成绑定的字段语义，不是生成的类型（与 `connect.ts` 同一决定）。
 *
 * 安全：远端正文（message / reason / unavailable_reason / upstream_code）不进浏览器、不进日志。
 * 本模块只输出稳定码与稳定短语；原始 text 只用于**模型目录的展示字段**与**任务结果正文**
 * （两者本来就是业务数据），其余远端字符串一律丢弃。
 */
import {
  DEFAULT_TASK_TIMEOUT_MS,
  GENERIC_MODEL_INTERACTION_ID,
  GENERIC_MODEL_INTERACTION_VERSION,
  isGenerationModelCapabilityFacts,
  isMediaLocator,
  isModelInteractionDescriptor,
  isPromptRequirement,
  isValidStorageKey,
  type CanvasTaskModelType,
  type GenerationCancelCapability,
  type GenerationModelDefinition,
  type ModelInteractionDescriptor,
  type PromptRequirement
} from "@woohaa3/contracts";
// 通道词表（生成任务失败码）：唯一来源是 api/proto，经 generrors 生成。
import { GENERATION_FAILURE, GENERATION_FAILURE_TEXTS } from "../../../../../../api/gen/es/woohaa/errors/v1alpha1/wirecodes_gen.js";

/** 服务名（与 proto 的 `package` + `service` 逐字一致）。 */
export const GENERATION_SERVICE = "woohaa.generation.v1alpha1.GenerationService";

/** 5 个一元 RPC 的方法名（冻结）。 */
export const GENERATION_METHODS = {
  getCapabilities: "GetCapabilities",
  getCatalog: "GetCatalog",
  submitTask: "SubmitTask",
  getTask: "GetTask",
  cancelTask: "CancelTask"
} as const;

/** 客户端内置协议版本（与 proto 注释里的 `protocol_version` 承诺同值）。 */
export const GENERATION_PROTOCOL_VERSION = 1;

/** v1 必须出现的能力标识：没有它就不拉目录，保持休眠。 */
export const GENERATION_CATALOG_FEATURE = "catalog";

/** 本扩展在 catalog 中的 Provider 身份（`modelKey = remote-server:<model_key>`）。 */
export const REMOTE_GENERATION_PROVIDER_ID = "remote-server";

/**
 * 服务端 `model_key` 的本地收口：`[A-Za-z0-9._-]{1,128}` 且不含 `:`。
 *
 * 不含冒号是为了让 `<providerId>:<providerModelId>` 仍能被既有解析安全拆分；超出形状的模型
 * 单条跳过（记诊断），不影响整份目录。
 */
export const REMOTE_GENERATION_MODEL_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** 客户端能消费的四种模型类型（其余单条跳过）。 */
export const REMOTE_GENERATION_MODEL_TYPES = ["language", "image", "video", "audio"] as const;

export function isRemoteGenerationModelType(value: unknown): value is CanvasTaskModelType {
  return typeof value === "string" && (REMOTE_GENERATION_MODEL_TYPES as readonly string[]).includes(value);
}

/**
 * 归一 `model_type`。
 *
 * 接受三种形态：
 * - 小写字符串（契约形态）：`image`；
 * - ProtoJSON 枚举形态：`MODEL_TYPE_IMAGE`（某些实现会把枚举写进字符串字段）；
 * - 数字（手写 fake / 网关转码）：按 proto enum 顺序 0=UNSPECIFIED、1..4。
 *
 * 未知值返回 null：调用方跳过该模型，不猜测类型。
 */
export function normalizeRemoteModelType(value: unknown): CanvasTaskModelType | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const byNumber: CanvasTaskModelType[] = ["language", "image", "video", "audio"];
    if (value >= 1 && value <= byNumber.length) return byNumber[value - 1] ?? null;
    return null;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;
  if (isRemoteGenerationModelType(raw)) return raw;
  const upper = raw.toUpperCase();
  if (upper.startsWith("MODEL_TYPE_")) {
    const candidate = upper.slice("MODEL_TYPE_".length).toLowerCase();
    if (isRemoteGenerationModelType(candidate)) return candidate;
  }
  return null;
}

/** 任务状态（proto enum）。客户端必须穷举；`unspecified` 一律按失败处理。 */
export const REMOTE_TASK_STATES = ["unspecified", "queued", "pending", "running", "succeeded", "failed", "cancelled"] as const;
export type RemoteTaskState = (typeof REMOTE_TASK_STATES)[number];

/**
 * 归一任务状态：接受 `TASK_STATE_SUCCEEDED`、`succeeded`、数字 0..6。
 *
 * 枚举顺序与 proto 一致：0 UNSPECIFIED、1 QUEUED、2 PENDING、3 RUNNING、4 SUCCEEDED、
 * 5 FAILED、6 CANCELLED。无法识别的值返回 null（调用方按"实现有缺陷"处理，不猜终态）。
 */
export function normalizeRemoteTaskState(value: unknown): RemoteTaskState | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 0 && value < REMOTE_TASK_STATES.length) return REMOTE_TASK_STATES[value] ?? null;
    return null;
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;
  const lower = raw.toLowerCase();
  if ((REMOTE_TASK_STATES as readonly string[]).includes(lower)) return lower as RemoteTaskState;
  const upper = raw.toUpperCase();
  if (upper.startsWith("TASK_STATE_")) {
    const candidate = upper.slice("TASK_STATE_".length).toLowerCase();
    if ((REMOTE_TASK_STATES as readonly string[]).includes(candidate)) return candidate as RemoteTaskState;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 容错读取（ProtoJSON：uint64 字符串、枚举字符串或数字、未知字段忽略）
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 依次按候选键取字符串；空串视为没有。 */
export function readStringField(value: unknown, ...keys: readonly string[]): string | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw !== "") return raw;
  }
  return null;
}

/**
 * 依次按候选键取整数：接受数字与 ProtoJSON 的十进制字符串。
 *
 * 不做 `Number("")` 之类的隐式转换；解析不出有限值就返回 null（绝不把 NaN 当数字往下传）。
 */
export function readIntField(value: unknown, ...keys: readonly string[]): number | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** 读布尔：只认真正的布尔值（ProtoJSON 的 false 会缺省，缺省语义由调用方决定）。 */
export function readBoolField(value: unknown, ...keys: readonly string[]): boolean | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "boolean") return raw;
  }
  return null;
}

export function readRecordField(value: unknown, ...keys: readonly string[]): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested !== null) return nested;
  }
  return null;
}

export function readArrayField(value: unknown, ...keys: readonly string[]): unknown[] | null {
  const record = asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    const raw = record[key];
    if (Array.isArray(raw)) return raw;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 稳定错误短语（不透传远端正文）
// ---------------------------------------------------------------------------

/**
 * 传输层错误（Connect `code`）→ 稳定短语。
 *
 * 只描述「调用是否到达服务端」，与业务失败（任务状态 + error.code）分开；这里刻意不读远端
 * 的 `message`，避免把内部细节带进浏览器或日志。
 */
export function generationRpcErrorText(code: string): string {
  switch (code) {
    case "unauthenticated":
      return "凭证无效或会话已失效";
    case "permission_denied":
      return "该账号没有所需权限";
    case "unimplemented":
      return "服务端尚未实现托管生成";
    case "not_found":
      return "服务端没有该生成接口或任务";
    case "invalid_argument":
    case "failed_precondition":
      return "服务端拒绝了这次请求";
    case "unavailable":
    case "internal":
    case "unknown":
      return "远端服务暂不可用";
    case "timeout":
      return "远端响应超时";
    case "unreachable":
      return "无法连接远端服务端";
    default:
      return "远端调用失败";
  }
}

/**
 * 这些传输层结果意味着「服务端没有提供托管生成」或「当前不该继续用它」，客户端保持休眠：
 * 未实现、版本/路径不存在、未认证、不可达。它们是**正常状态**，不是故障（design D7）。
 */
export function isGenerationDormantCode(code: string): boolean {
  switch (code) {
    case "unimplemented":
    case "not_found":
    case "unauthenticated":
    case "permission_denied":
    case "unavailable":
    case "timeout":
    case "unreachable":
    case "internal":
    case "unknown":
      return true;
    default:
      return code.startsWith("http-");
  }
}

/**
 * 哪些传输层失败意味着「远端只是暂时不可达」，已注册的目录应保留（design D7）：
 * 一次网络抖动不该让整份目录消失；只有会话失效/未实现/目录为空才翻转不可用。
 */
export function isGenerationTransientCode(code: string): boolean {
  return code === "unavailable" || code === "timeout" || code === "unreachable" || code === "internal" || code === "unknown" || code.startsWith("http-5");
}

/**
 * 业务失败稳定码。
 *
 * **码与文案都不在本文件**：它们来自 api/proto 的 `GenerationFailure` 枚举（generrors
 * 生成到 `wirecodes_gen`）。这里再抄一份就是第二份契约——服务端新增一个码时，客户端
 * 会静默把新码当作"服务端任务失败"，这正是 2026-10-22 那次事故的形状。
 */
export type GenerationFailureCode = (typeof GENERATION_FAILURE)[keyof typeof GENERATION_FAILURE];

/** 业务失败码 → 可读短语；未知码回落成一句稳定的「任务失败」。 */
export function generationFailureText(code: string): string {
  return GENERATION_FAILURE_TEXTS[code] ?? "服务端任务失败";
}

// ---------------------------------------------------------------------------
// GetCapabilities
// ---------------------------------------------------------------------------

export type DecodedGenerationCapabilities = {
  protocolVersion: number | null;
  features: readonly string[];
  pollAfterMs: number | null;
  maxInputs: number | null;
  idempotencyRetentionSeconds: number | null;
  modelTypes: readonly string[];
  cancelScopes: readonly string[];
};

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
}

/** 解出能力协商字段；未知字段忽略，缺失字段为 null（交给协商逻辑判断）。 */
export function decodeGenerationCapabilities(payload: unknown): DecodedGenerationCapabilities {
  const record = asRecord(payload) ?? {};
  return {
    protocolVersion: readIntField(record, "protocolVersion", "protocol_version"),
    features: readStringArray(record.features),
    pollAfterMs: readIntField(record, "pollAfterMs", "poll_after_ms"),
    maxInputs: readIntField(readRecordField(record, "limits") ?? {}, "maxInputs", "max_inputs"),
    idempotencyRetentionSeconds: readIntField(
      readRecordField(record, "limits") ?? {},
      "idempotencyRetentionSeconds",
      "idempotency_retention_seconds"
    ),
    modelTypes: readStringArray(record.modelTypes ?? record.model_types),
    cancelScopes: readStringArray(record.cancelScopes ?? record.cancel_scopes)
  };
}

export type CapabilityNegotiation =
  | { ok: true; pollAfterMs: number | null }
  | { ok: false; code: "protocol-version" | "catalog-feature" };

/** 协商：版本必须相等，且 features 必须含 `catalog`；否则休眠（不是故障）。 */
export function negotiateGenerationCapabilities(capabilities: DecodedGenerationCapabilities): CapabilityNegotiation {
  if (capabilities.protocolVersion !== GENERATION_PROTOCOL_VERSION) {
    return { ok: false, code: "protocol-version" };
  }
  if (!capabilities.features.includes(GENERATION_CATALOG_FEATURE)) {
    return { ok: false, code: "catalog-feature" };
  }
  return { ok: true, pollAfterMs: capabilities.pollAfterMs };
}

// ---------------------------------------------------------------------------
// GetCatalog → GenerationModelDefinition[]
// ---------------------------------------------------------------------------

export type GenerationAdmission = {
  catalogRevision: number;
  schemaRevision: number;
  configVersion: number;
};

export type DecodedGenerationCatalog = {
  available: boolean;
  reason: string | null;
  catalogRevision: number | null;
  models: GenerationModelDefinition[];
  /** `providerModelId`（即服务端 model_key）→ 受理版本。 */
  admission: Map<string, GenerationAdmission>;
  skippedModels: number;
  /** 未知 interaction 被归一成 generic 的次数（诊断用，不含模型名）。 */
  interactionFallbacks: number;
};

function normalizeCancel(value: unknown): GenerationCancelCapability {
  return value === "remote" || value === "unsupported" || value === "local" ? value : "local";
}

function normalizePromptRequirement(value: unknown): PromptRequirement {
  return isPromptRequirement(value) ? value : "required";
}

function normalizeInteraction(value: unknown): { interaction: ModelInteractionDescriptor; fallback: boolean } {
  const record = asRecord(value);
  if (record === null) {
    return {
      interaction: { id: GENERIC_MODEL_INTERACTION_ID, version: GENERIC_MODEL_INTERACTION_VERSION },
      fallback: false
    };
  }
  const candidate: Record<string, unknown> = {
    id: record.id,
    version: readIntField(record, "version") ?? record.version
  };
  // v1 远端只能声明 generic：其它 identity 在当前客户端没有对应 Panel，一律归一，
  // 避免整份目录因 missing-plugin 不可用（design D3/D9）。形状非法时同样回落。
  if (
    isModelInteractionDescriptor(candidate) &&
    candidate.id === GENERIC_MODEL_INTERACTION_ID &&
    candidate.version === GENERIC_MODEL_INTERACTION_VERSION
  ) {
    return { interaction: candidate, fallback: false };
  }
  return {
    interaction: { id: GENERIC_MODEL_INTERACTION_ID, version: GENERIC_MODEL_INTERACTION_VERSION },
    fallback: true
  };
}

/** 把服务端 bindings 合并进 `capabilities.referenceInput.bindings`（catalog 的唯一输入契约）。 */
function mergeBindings(capabilities: Record<string, unknown> | undefined, bindings: unknown[] | null): Record<string, unknown> | undefined {
  if (bindings === null || bindings.length === 0) return capabilities;
  const referenceInput = asRecord(capabilities?.referenceInput) ?? {};
  return { ...(capabilities ?? {}), referenceInput: { ...referenceInput, bindings } };
}

function decodeModel(
  raw: unknown,
  providerId: string,
  catalogRevision: number
): { model: GenerationModelDefinition; admission: GenerationAdmission } | null {
  const record = asRecord(raw);
  if (record === null) return null;

  const modelKey = readStringField(record, "modelKey", "model_key") ?? readStringField(record, "providerModelId", "provider_model_id");
  if (modelKey === null || !REMOTE_GENERATION_MODEL_KEY_PATTERN.test(modelKey)) return null;

  const modelType = normalizeRemoteModelType(record.modelType ?? record.model_type);
  if (modelType === null) return null;

  const inputSchema = readRecordField(record, "inputSchema", "input_schema") ?? undefined;
  const defaultInput = readRecordField(record, "defaultInput", "default_input") ?? undefined;
  const rawCapabilities = readRecordField(record, "capabilities") ?? undefined;
  const bindings = readArrayField(record, "bindings");
  const capabilities = mergeBindings(rawCapabilities, bindings);
  const capabilityFacts = warnCapabilityFacts(record);

  const { interaction } = normalizeInteraction(readRecordField(record, "interaction"));

  const declaredTimeout = readIntField(record, "taskTimeoutMs", "task_timeout_ms");
  const taskTimeoutMs =
    declaredTimeout !== null && declaredTimeout > 0
      ? declaredTimeout
      : (DEFAULT_TASK_TIMEOUT_MS[modelType] ?? 0);

  const title = readStringField(record, "title");
  const executable = readBoolField(record, "executable");

  const model: GenerationModelDefinition = {
    providerId,
    providerModelId: modelKey,
    modelType,
    ...(title !== null ? { title } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(defaultInput !== undefined ? { defaultInput } : {}),
    interaction,
    cancel: normalizeCancel(readStringField(record, "cancel")),
    promptRequirement: normalizePromptRequirement(readStringField(record, "promptRequirement", "prompt_requirement")),
    taskTimeoutMs,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(capabilityFacts !== undefined ? { capabilityFacts } : {}),
    // 只有显式 false 才标记不可执行；缺省按可执行处理（proto 用 optional bool 保留
    // presence：服务端明确不可执行时会发 false，未声明时省略）。
    ...(executable === false ? { executable: false } : {})
  };

  const admission: GenerationAdmission = {
    catalogRevision: Math.max(0, catalogRevision),
    schemaRevision: Math.max(0, readIntField(record, "schemaRevision", "schema_revision") ?? 0),
    configVersion: Math.max(0, readIntField(record, "configVersion", "config_version") ?? 0)
  };

  return { model, admission };
}

/** capabilityFacts 形状非法时丢弃该字段（单模型降级），不影响可执行性。 */
function warnCapabilityFacts(record: Record<string, unknown>): GenerationModelDefinition["capabilityFacts"] | undefined {
  const raw = record.capabilityFacts ?? record.capability_facts;
  if (raw === undefined) return undefined;
  return isGenerationModelCapabilityFacts(raw) ? raw : undefined;
}

/**
 * 解析整份目录。
 *
 * 逐条校验：未知/非法类型的模型只跳过该条并计数；`available=false` 时上层保持休眠。
 * `catalogRevision` 缺失按 0 处理（只用于失效判断，不是数据事实源）。
 */
export function decodeGenerationCatalog(payload: unknown, providerId: string): DecodedGenerationCatalog {
  const record = asRecord(payload);
  if (record === null) {
    return { available: false, reason: null, catalogRevision: null, models: [], admission: new Map(), skippedModels: 0, interactionFallbacks: 0 };
  }
  const available = readBoolField(record, "available") === true;
  const reason = readStringField(record, "reason");
  const catalogRevision = readIntField(record, "catalogRevision", "catalog_revision");
  const rawModels = readArrayField(record, "models") ?? [];
  const models: GenerationModelDefinition[] = [];
  const admission = new Map<string, GenerationAdmission>();
  let skippedModels = 0;
  for (const raw of rawModels) {
    const decoded = decodeModel(raw, providerId, catalogRevision ?? 0);
    if (decoded === null) {
      skippedModels += 1;
      continue;
    }
    models.push(decoded.model);
    admission.set(decoded.model.providerModelId, decoded.admission);
  }
  let interactionFallbacks = 0;
  for (const raw of rawModels) {
    const interaction = asRecord(asRecord(raw)?.interaction);
    if (interaction === null) continue;
    const candidate: Record<string, unknown> = { id: interaction.id, version: readIntField(interaction, "version") ?? interaction.version };
    if (!isModelInteractionDescriptor(candidate)) interactionFallbacks += 1;
  }
  return { available, reason, catalogRevision, models, admission, skippedModels, interactionFallbacks };
}

// ---------------------------------------------------------------------------
// SubmitTask / GetTask / CancelTask
// ---------------------------------------------------------------------------

export type DecodedSubmitResponse = {
  taskId: string | null;
  state: RemoteTaskState | null;
  reused: boolean;
  idempotencyKey: string | null;
};

export function decodeSubmitResponse(payload: unknown): DecodedSubmitResponse {
  const record = asRecord(payload) ?? {};
  return {
    taskId: readStringField(record, "taskId", "task_id"),
    state: normalizeRemoteTaskState(record.state),
    reused: readBoolField(record, "reused") === true,
    idempotencyKey: readStringField(record, "idempotencyKey", "idempotency_key")
  };
}

export type DecodedTaskFailure = { code: string; retryable: boolean };

export type DecodedTaskText = { content: Array<{ type: "text"; text: string }> };
export type DecodedTaskMedia = {
  media: {
    /** 画布命名空间内的逻辑键（旧契约）；主体命名空间没有它。 */
    storageKey?: string;
    /** 结果字节的不透明位置（新契约）；远端托管生成必有。 */
    locator?: string;
    contentType: string;
    size: number;
    checksum?: string;
    durationSeconds?: number;
    poster?: { storageKey?: string; locator?: string; contentType: string; size: number; checksum?: string };
  };
};

export type DecodedTask = {
  taskId: string | null;
  state: RemoteTaskState | null;
  progress: number | null;
  failure: DecodedTaskFailure | null;
  /** 成功终态的文本结果（language 模型）。 */
  text: DecodedTaskText | null;
  /** 成功终态的稳定媒体结果（image/audio/video 模型）。 */
  media: DecodedTaskMedia | null;
  /** 成功终态但结果形状不可识别（调用方按稳定失败处理）。 */
  resultInvalid: boolean;
};

function readProgress(record: Record<string, unknown>): number | null {
  const raw = record.progress;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.min(1, Math.max(0, raw));
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return Math.min(1, Math.max(0, parsed));
  }
  return null;
}

function decodeMedia(value: unknown): DecodedTaskMedia | null {
  const record = asRecord(value);
  if (record === null) return null;
  const storageKey = readStringField(record, "storageKey", "storage_key");
  const locator = readStringField(record, "mediaLocator", "media_locator");
  const contentType = readStringField(record, "contentType", "content_type");
  const size = readIntField(record, "size");
  if (contentType === null || size === null || size < 0) return null;
  const hasKey = storageKey !== null && isValidStorageKey(storageKey);
  const hasLocator = locator !== null && isMediaLocator(locator);
  // 位置二选一：新契约给 locator（主体命名空间没有画布逻辑键），旧契约给 storage_key。
  if (!hasKey && !hasLocator) return null;
  const durationSeconds = readIntField(record, "durationSeconds", "duration_seconds");
  const posterRecord = readRecordField(record, "poster");
  let poster: NonNullable<DecodedTaskMedia["media"]["poster"]> | undefined;
  if (posterRecord !== null) {
    const posterKey = readStringField(posterRecord, "storageKey", "storage_key");
    const posterLocator = readStringField(posterRecord, "mediaLocator", "media_locator");
    const posterType = readStringField(posterRecord, "contentType", "content_type");
    const posterSize = readIntField(posterRecord, "size");
    const posterHasKey = posterKey !== null && isValidStorageKey(posterKey);
    const posterHasLocator = posterLocator !== null && isMediaLocator(posterLocator);
    if (posterType !== null && posterSize !== null && posterSize >= 0 && (posterHasKey || posterHasLocator)) {
      poster = {
        ...(posterHasKey ? { storageKey: posterKey as string } : {}),
        ...(posterHasLocator ? { locator: posterLocator as string } : {}),
        contentType: posterType,
        size: posterSize,
        ...(readStringField(posterRecord, "checksum") !== null ? { checksum: readStringField(posterRecord, "checksum") as string } : {})
      };
    }
  }
  return {
    media: {
      ...(hasKey ? { storageKey: storageKey as string } : {}),
      ...(hasLocator ? { locator: locator as string } : {}),
      contentType,
      size,
      ...(readStringField(record, "checksum") !== null ? { checksum: readStringField(record, "checksum") as string } : {}),
      ...(durationSeconds !== null && durationSeconds >= 0 ? { durationSeconds } : {}),
      ...(poster !== undefined ? { poster } : {})
    }
  };
}

function decodeText(value: unknown): DecodedTaskText | null {
  if (typeof value === "string") {
    return value === "" ? null : { content: [{ type: "text", text: value }] };
  }
  const record = asRecord(value);
  if (record === null) return null;
  const text = readStringField(record, "text");
  if (text === null) return null;
  // 截断标志不是客户端契约的一部分；正文本身由服务端按 limits 收敛。
  return { content: [{ type: "text", text }] };
}

/**
 * 解析 GetTask 响应。
 *
 * 结果 oneof 在 ProtoJSON 里是**同级字段**（`text` / `media`）；这里同时兼容包在 `result`
 * 里以及直接平铺这两种形态，未知字段忽略。
 */
export function decodeTask(payload: unknown): DecodedTask {
  const record = asRecord(payload);
  if (record === null) {
    return { taskId: null, state: null, progress: null, failure: null, text: null, media: null, resultInvalid: false };
  }
  const failureRecord = readRecordField(record, "error");
  const failureCode = failureRecord === null ? null : readStringField(failureRecord, "code");
  const failure: DecodedTaskFailure | null =
    failureCode === null
      ? null
      : { code: failureCode, retryable: readBoolField(failureRecord as Record<string, unknown>, "retryable") === true };

  const resultRecord = readRecordField(record, "result");
  const textRaw = record.text ?? resultRecord?.text;
  const mediaRaw = record.media ?? resultRecord?.media;
  const text = textRaw === undefined ? null : decodeText(textRaw);
  const media = mediaRaw === undefined ? null : decodeMedia(mediaRaw);

  const state = normalizeRemoteTaskState(record.state);
  const succeeded = state === "succeeded";
  const resultInvalid = succeeded && text === null && media === null;

  return {
    taskId: readStringField(record, "taskId", "task_id"),
    state,
    progress: readProgress(record),
    failure,
    text,
    media,
    resultInvalid
  };
}

/** 解析 CreateTask/取消的返回状态（只取 state，其余字段忽略）。 */
export function decodeCancelResponse(payload: unknown): RemoteTaskState | null {
  return normalizeRemoteTaskState(asRecord(payload)?.state);
}
