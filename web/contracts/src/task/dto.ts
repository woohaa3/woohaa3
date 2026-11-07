/**
 * pptask 任务 DTO（change: split-web-runtime-services，任务 1.3；源自前置 change 的
 * `apps/site/shared/tasks.ts`）。
 *
 * 这是**唯一**的任务协议来源：浏览器 run/cancel、Canvas 提交、Task Service 校验与
 * 响应都用同一套类型，避免两侧各写一份而漂移。只含类型与稳定常量，不含任何凭据或
 * 服务端依赖，因此可以安全地被浏览器 bundle 引用。
 *
 * 约束：
 * - 输入只携带**稳定媒体引用**（assetId + role + storageKey + mediaType），
 *   绝不携带 bytes、浏览器 URL 或临时签名 URL。
 * - 图片成功结果只携带稳定 COS metadata，不携带图片 base64/Blob。
 */
import type { GenerationModelCapabilityFacts } from "./model-capabilities.js";
import type { CanvasReferencePolicy } from "./reference-policy.js";

/** 可执行的节点类型。text/image/video/audio 有执行入口。 */
export type CanvasTaskNodeType = "image" | "text" | "video" | "audio";

/** 任务类型：与 ExecutionPanel 的 taskKind 对齐。 */
export type CanvasTaskKind =
  | "text-generation"
  | "image-generation"
  | "video-generation"
  | "audio-generation";

/** 服务端 catalog 中模型的 provider 类型。 */
export type CanvasTaskModelType = "language" | "image" | "video" | "audio";

/** 任务结果的媒体类别（稳定摘要的判别字段）。 */
export type CanvasTaskMediaKind = "text" | "image" | "video" | "audio";

/** 模型可接受的参考输入媒体类别。 */
export type CanvasReferenceMediaKind = "image" | "video" | "audio";

export const DEFAULT_TASK_TIMEOUT_MS = {
  language: 2 * 60_000,
  image: 8 * 60_000,
  audio: 8 * 60_000,
  video: 20 * 60_000
} as const;

export const DEFAULT_HTTP_CALL_TIMEOUT_MS = Math.max(...Object.values(DEFAULT_TASK_TIMEOUT_MS));

/** 节点 `nodeData.taskStatus`（画布域）取值。 */
export type CanvasNodeTaskStatus =
  | "idle"
  | "pending"
  | "processing"
  | "successed"
  | "failed"
  | "cancelled"
  | "unknown";

/** 节点 `jobs[].status`（画布域的 `GenerationStatus`）取值。 */
export type CanvasJobStatus =
  | "idle"
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "draft"
  | "ready"
  | "archived";

export function nodeTaskStatusFromJob(status: CanvasJobStatus): CanvasNodeTaskStatus {
  if (status === "success") return "successed";
  if (status === "failed") return "failed";
  if (status === "idle") return "idle";
  return "processing";
}

export const CANVAS_TASK_LIMITS = {
  promptMaxChars: 8000,
  maxReferences: 16,
  maxTextOutputChars: 200_000,
  maxImageOutputBytes: 32 * 1024 * 1024,
  maxAudioOutputBytes: 64 * 1024 * 1024,
  maxVideoOutputBytes: 256 * 1024 * 1024,
  referenceUrlTtlSeconds: 900
} as const;

export const NODE_TYPE_TO_TASK_KIND: Readonly<Record<CanvasTaskNodeType, CanvasTaskKind>> = {
  image: "image-generation",
  text: "text-generation",
  video: "video-generation",
  audio: "audio-generation"
};

export const TASK_KIND_TO_MODEL_TYPE: Readonly<Record<CanvasTaskKind, CanvasTaskModelType>> = {
  "text-generation": "language",
  "image-generation": "image",
  "video-generation": "video",
  "audio-generation": "audio"
};

export function isCanvasTaskNodeType(value: unknown): value is CanvasTaskNodeType {
  return value === "image" || value === "text" || value === "video" || value === "audio";
}

export function isCanvasTaskModelType(value: unknown): value is CanvasTaskModelType {
  return value === "language" || value === "image" || value === "video" || value === "audio";
}

/** 节点类型与模型类型的合法配对（图片↔image 等）。 */
export function isNodeModelTypeMatch(
  nodeType: CanvasTaskNodeType,
  modelType: CanvasTaskModelType
): boolean {
  return NODE_TYPE_TO_TASK_KIND[nodeType] === modelKindToTaskKind(modelType);
}

function modelKindToTaskKind(modelType: CanvasTaskModelType): CanvasTaskKind {
  switch (modelType) {
    case "language":
      return "text-generation";
    case "image":
      return "image-generation";
    case "video":
      return "video-generation";
    case "audio":
      return "audio-generation";
  }
}

/** 稳定媒体引用：只提交这些字段，执行前由 Task 通过 Media Service 重新校验并签名。 */
export type CanvasTaskInput = {
  assetId: string;
  role: string;
  storageKey: string;
  mediaType: string;
  /** 稳定媒体类别；Task Service 按 binding 校验。旧客户端可缺省（按 mediaType 推断）。 */
  mediaKind?: CanvasReferenceMediaKind;
  /**
   * 这张图写进模型表单的哪个字段（`CanvasTaskInputBinding.field`，如 ppserver 的 `3_image`）。
   *
   * 一个模型可能有多个同类字段（主图 / 参考图），角色却相同；只靠 `role + mediaKind` 会把它们
   * 全部落到第一个字段上，于是第二张图就撞上「主图上限 1」。由 Canvas 在权威解析时按绑定容量
   * 分配好后随输入一起提交；Task 不重新猜。
   *
   * 旧客户端可缺省：缺省时 Task 按 `role + mediaKind` 找第一个匹配的绑定（旧行为）。
   */
  field?: string;
  /**
   * 提交快照里的参考身份（change: 2026-11-06-require-identity-reference）。
   *
   * `slotId` / `sourceNodeId` / `order` 只描述这次提交选中的输入槽与稳定顺序；
   * 它们不授予执行权限，Task Service 仍按 storageKey / assetId 重新校验。
   * 旧客户端可缺省，服务端按输入数组顺序补全。
   */
  slotId?: string;
  sourceNodeId?: string;
  order?: number;
};

/** 浏览器/Canvas 提交的任务请求体。 */
export type CanvasTaskRequest = {
  runId: string;
  nodeId: string;
  nodeType: CanvasTaskNodeType;
  modelType: CanvasTaskModelType;
  /** 稳定 catalog 身份；新代码只使用它做查找与路由。 */
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  inputs: CanvasTaskInput[];
};

export type CanvasTaskTextOutput = {
  kind: "text";
  text: string;
};

/** 二进制成功结果：写入 COS 后返回的稳定 metadata。 */
export type CanvasTaskBinaryOutput = {
  kind: "image" | "video" | "audio";
  storageKey: string;
  contentType: string;
  size: number;
  checksum: string;
  durationSeconds?: number;
  /** 可选海报（视频末帧/封面）的稳定 metadata。 */
  poster?: CanvasTaskBinaryMediaMetadata;
};

/** 二进制媒体 metadata（主媒体或海报）。 */
export type CanvasTaskBinaryMediaMetadata = {
  storageKey: string;
  contentType: string;
  size: number;
  checksum: string;
};

export type CanvasTaskImageOutput = Extract<CanvasTaskBinaryOutput, { kind: "image" }>;
export type CanvasTaskVideoOutput = Extract<CanvasTaskBinaryOutput, { kind: "video" }>;
export type CanvasTaskAudioOutput = Extract<CanvasTaskBinaryOutput, { kind: "audio" }>;

export type CanvasTaskOutput = CanvasTaskTextOutput | CanvasTaskBinaryOutput;

/**
 * 模型参考输入的 binding（design D4）。
 *
 * 取代旧的图片专用布尔/数组字段：一个 binding 描述一个输入 field 接受哪些
 * media kind、role、media type、数量以及 valueFormat。
 */
export type CanvasTaskInputBinding = {
  field: string;
  semantic: "reference-image" | "reference-video" | "reference-audio";
  roles: string[];
  mediaKinds: CanvasReferenceMediaKind[];
  mediaTypes: string[];
  maxItems: number;
  valueFormat: "url" | "reference";
  /**
   * 字段在表单上的显示名（如「主图像」「上传参考图像」），只用于界面标签。
   *
   * 一个模型有多个同类字段时，光看 `field` 用户分不清哪个是主图——两张缩略图长得一样。
   * 缺省时界面退回按角色显示，不影响校验与分配。
   */
  label?: string;
};

/**
 * 按「角色 + 媒体类别 + 媒体类型」挑一个绑定，**优先挑还有剩余容量的那个**。
 *
 * 一个模型可以有多条同类绑定（ppserver 的「主图」`3_image` 上限 1、「参考图」`1x_image` 上限 9），
 * 它们的 roles / mediaKinds 常常完全一样。只取第一个匹配会让第二张图撞上主图的上限 1，
 * 于是「两张参考图」被误判成超限。这里的规则：
 *
 * 1. 先按匹配条件筛出候选，保持 catalog 里的声明顺序；
 * 2. 在候选里取第一个还没满的（`used[field] < maxItems`）；
 * 3. 全都满了才退回第一个候选 —— 让调用方报出「上限 N」那条原始错误，而不是变成「不接受」。
 *
 * `used` 由调用方维护（同一份解析里累计各 field 已占用的数量）。
 */
export function pickInputBinding(
  bindings: readonly CanvasTaskInputBinding[],
  input: { role: string; mediaKind?: CanvasReferenceMediaKind; mediaType: string },
  used: ReadonlyMap<string, number> = new Map()
): CanvasTaskInputBinding | undefined {
  const readUsed = (field: string): number => used.get(field) ?? 0;
  const candidates = bindings.filter(
    (binding) =>
      binding.roles.includes(input.role) &&
      (input.mediaKind === undefined || binding.mediaKinds.includes(input.mediaKind)) &&
      binding.mediaTypes.includes(input.mediaType)
  );
  return candidates.find((binding) => readUsed(binding.field) < binding.maxItems) ?? candidates[0];
}

/** catalog 中单个模型的可投影描述。 */
export type CanvasTaskCatalogModel = {
  /**
   * catalog 内唯一、opaque 的调用身份（change: add-pluggable-model-interactions，D1）。
   * 调用方只做查找；**不得** 解析出 Provider 或原始模型 id。
   */
  modelKey: string;
  providerId: string;
  /** Provider 自己的原始模型 id；只传给对应 Provider adapter。 */
  providerModelId: string;
  modelType: CanvasTaskModelType;
  title: string;
  /**
   * 受信任配置选择的非执行交互 identity（design D2）。Catalog 不承载 UI DSL，
   * 只声明本地 Registry 的 `{ id, version }`。
   */
  interaction: ModelInteractionDescriptor;
  inputSchema: Record<string, unknown>;
  defaultInput: Record<string, unknown>;
  /** 规范化多模态参考输入 bindings（新服务只写这一项）。 */
  bindings: CanvasTaskInputBinding[];
  /**
   * 模型声明的身份一致性参考策略；缺省 `optional`。
   * 节点设置 `nodeData.referencePolicy` 优先于本字段。
   */
  referencePolicy?: CanvasReferencePolicy;
  taskTimeoutMs: number;
  /**
   * 模型级 prompt 要求（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 3.4）。
   * required 保持既有规则；optional/none 允许纯素材工作流。
   * 旧 catalog 无此字段时按 required 处理。
   */
  promptRequirement?: "required" | "optional" | "none";
  /** 取消能力（design D6）；缺省 local。 */
  cancel?: "local" | "remote" | "unsupported";
  /** 该模型运行配置的 schema 版本（change: ...，任务 3.1）。 */
  schemaRevision?: number;
  /** 该模型运行配置版本（不可变配置快照；恢复依据）。 */
  configVersion?: number;
  /** 声明能力摘要（operation 等）；不含秘密。 */
  capabilities?: Record<string, unknown>;
  /**
   * 模型事实能力（Provider 声明、目录校验后透传）。
   *
   * 读取请用 `canvasModelCapabilities(model)`：参考输入由 bindings 派生，reasoning
   * 取本字段；缺省 = 未声明（按不支持处理）。
   */
  capabilityFacts?: GenerationModelCapabilityFacts;
};

/** `GET /api/pptask/catalog` 的响应。 */
export type CanvasTaskCatalog = {
  available: boolean;
  reason?: string;
  models: CanvasTaskCatalogModel[];
  /** 默认模型按 `modelKey` 引用（change: add-pluggable-model-interactions，D1）。 */
  defaultModels: Partial<Record<CanvasTaskModelType, string>>;
  /**
   * 单调 catalog 修订（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 3.1）。
   * 随模型集合/运营策略变化推进；客户端只用它做失效判断，不是模型数据事实源。
   */
  catalogRevision?: number;
};

/**
 * catalog 中参考输入能力的**规范化读取结果**（由 `CanvasTaskInputBinding[]` 派生的只读摘要）。
 *
 * bindings 是唯一输入契约；旧图片专用字段（acceptsImages/image/maxReferences/roles/mediaTypes）
 * 已不再被读取（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，B04）。
 */
export type ReferenceInputCapability = {
  acceptsImages: boolean;
  roles: string[];
  maxItems: number;
  mediaTypes: string[];
  bindings: CanvasTaskInputBinding[];
};

export const DEFAULT_IMAGE_REFERENCE_ROLES: readonly string[] = ["reference_image"];
export const DEFAULT_IMAGE_REFERENCE_MEDIA_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp"
];

export const REFERENCE_IMAGE_SEMANTIC = "reference-image";
export const REFERENCE_VIDEO_SEMANTIC = "reference-video";
export const REFERENCE_AUDIO_SEMANTIC = "reference-audio";

const SEMANTIC_TO_MEDIA_KIND: Readonly<Record<string, CanvasReferenceMediaKind>> = {
  [REFERENCE_IMAGE_SEMANTIC]: "image",
  [REFERENCE_VIDEO_SEMANTIC]: "video",
  [REFERENCE_AUDIO_SEMANTIC]: "audio"
};

const DEFAULT_BINDING_MEDIA_TYPES: Readonly<Record<CanvasReferenceMediaKind, readonly string[]>> = {
  image: DEFAULT_IMAGE_REFERENCE_MEDIA_TYPES,
  video: ["video/mp4", "video/webm"],
  audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"]
};

const DEFAULT_BINDING_ROLES: Readonly<Record<CanvasReferenceMediaKind, readonly string[]>> = {
  image: DEFAULT_IMAGE_REFERENCE_ROLES,
  video: ["reference_video"],
  audio: ["reference_audio"]
};

/** 把任意 binding 列表规范化为稳定形状（去空、夹 maxItems）。 */
export function normalizeInputBindings(input: unknown): CanvasTaskInputBinding[] {
  if (!Array.isArray(input)) return [];
  const bindings: CanvasTaskInputBinding[] = [];
  for (const entry of input) {
    if (!isJsonObject(entry)) continue;
    const semantic = entry.semantic;
    if (
      semantic !== REFERENCE_IMAGE_SEMANTIC &&
      semantic !== REFERENCE_VIDEO_SEMANTIC &&
      semantic !== REFERENCE_AUDIO_SEMANTIC
    ) {
      continue;
    }
    const mediaKind = SEMANTIC_TO_MEDIA_KIND[semantic];
    const roles = Array.isArray(entry.roles)
      ? entry.roles.filter((role): role is string => typeof role === "string" && role !== "")
      : [];
    const mediaTypes = Array.isArray(entry.mediaTypes)
      ? entry.mediaTypes.filter((type): type is string => typeof type === "string" && type !== "")
      : [];
    const mediaKinds = Array.isArray(entry.mediaKinds)
      ? entry.mediaKinds.filter(
          (kind): kind is CanvasReferenceMediaKind =>
            kind === "image" || kind === "video" || kind === "audio"
        )
      : [];
    const rawMax = entry.maxItems ?? entry.maxReferences;
    const maxItems =
      typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
        ? Math.min(Math.floor(rawMax), CANVAS_TASK_LIMITS.maxReferences)
        : 0;
    bindings.push({
      field: typeof entry.field === "string" && entry.field !== "" ? entry.field : semantic,
      semantic,
      roles: roles.length > 0 ? roles : [...DEFAULT_BINDING_ROLES[mediaKind]],
      mediaKinds: mediaKinds.length > 0 ? mediaKinds : [mediaKind],
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : [...DEFAULT_BINDING_MEDIA_TYPES[mediaKind]],
      maxItems,
      valueFormat: entry.valueFormat === "reference" ? "reference" : "url",
      ...(typeof entry.label === "string" && entry.label.trim() !== "" ? { label: entry.label.trim() } : {})
    });
  }
  return bindings;
}

/**
 * 读取 catalog 模型的 bindings（唯一输入契约）。
 *
 * catalog 只写出 `bindings`；不再读取旧图片能力字段（change:
 * 2026-10-07-remove-residual-compatibility）。
 */
export function catalogModelBindings(model: {
  bindings?: unknown;
}): CanvasTaskInputBinding[] {
  return normalizeInputBindings(model.bindings);
}

export function readReferenceInputCapability(
  capabilities: Record<string, unknown> | undefined
): ReferenceInputCapability {
  const raw = (capabilities?.referenceInput ?? {}) as Record<string, unknown>;
  // capabilities.referenceInput 只接受 `bindings` 数组；旧图片字段不再生效。
  const bindings = normalizeInputBindings(raw.bindings);
  return summarizeBindings(bindings);
}

/** 由规范 bindings 派生只读摘要（acceptsImages/roles/maxItems/mediaTypes）。 */
export function summarizeBindings(bindings: CanvasTaskInputBinding[]): ReferenceInputCapability {
  return {
    acceptsImages: bindings.some((binding) => binding.semantic === REFERENCE_IMAGE_SEMANTIC),
    roles: [...new Set(bindings.flatMap((binding) => binding.roles))],
    maxItems: bindings.reduce((max, binding) => Math.max(max, binding.maxItems), 0),
    mediaTypes: [...new Set(bindings.flatMap((binding) => binding.mediaTypes))],
    bindings
  };
}

import { isJsonObject } from "../validation.js";
import type { ModelInteractionDescriptor } from "./model-identity.js";

export function referenceInputCapabilityFromDescription(description: {
  inputSchema?: Record<string, unknown>;
  defaultInput?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}): ReferenceInputCapability {
  const declared = readReferenceInputCapability(description.capabilities);
  if (declared.bindings.length > 0) return declared;

  // 无显式 capability 时扫描 inputSchema 的 `x-pptask-semantic`（图片/视频/音频）。
  const properties = isJsonObject(description.inputSchema?.properties)
    ? (description.inputSchema.properties as Record<string, unknown>)
    : {};
  const scanned: CanvasTaskInputBinding[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonObject(value)) continue;
    const semantic = value["x-pptask-semantic"];
    if (typeof semantic !== "string") continue;
    if (!(semantic in SEMANTIC_TO_MEDIA_KIND)) continue;
    const rawMax = value.maxItems;
    const maxItems =
      typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
        ? Math.min(Math.floor(rawMax), CANVAS_TASK_LIMITS.maxReferences)
        : CANVAS_TASK_LIMITS.maxReferences;
    scanned.push(
      ...normalizeInputBindings([
        {
          field: key,
          semantic,
          maxItems,
          // 表单标题随绑定带下去：界面靠它区分「主图像」和「参考图」。
          ...(typeof value.title === "string" && value.title.trim() !== "" ? { label: value.title } : {})
        }
      ])
    );
  }
  if (scanned.length > 0) return summarizeBindings(scanned);

  return summarizeBindings([]);
}
