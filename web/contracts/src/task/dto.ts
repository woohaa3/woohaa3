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
   * 槽位展示名（如「控制图」）。空表示按角色名兜底。
   *
   * 展示名随模型/工作流版本走，不在客户端硬编码：加一种条件输入不该要求客户端发版。
   */
  label?: string;
  /**
   * 该槽位不填充就不能执行。
   *
   * 只对参考槽位有意义。普通参数的必填由参数 schema 表达，两处各写一份会让
   * 「这条必填谁说了算」没有答案。
   */
  required?: boolean;
  /**
   * 这个 binding 是否描述一个**模型显式声明的具名槽位**。
   *
   * 只有它为真时才为未填充的槽位渲染空位。按模型类型兜底的默认绑定（视频模型的
   * `first_frame` / `last_frame`）表达的是"这类模型可以接"，不是"这个模型等你填"，
   * 给它们都渲染空槽会让参考区凭空多出几个永远没人用的位置。
   */
  declaredSlot?: boolean;
};

/** 参考槽位的运行期身份：模型声明的一个槽，可能已填充也可能还空着。 */
export type CanvasReferenceSlot = {
  /** 槽位身份，与 binding 的 role 一致（reference_image / control_image…）。 */
  role: string;
  /** 展示名；binding 没声明时按角色兜底。 */
  label: string;
  mediaKind: CanvasReferenceMediaKind;
  maxItems: number;
  required: boolean;
  /**
   * 该槽位的绑定字段名。
   *
   * 派发按 role 找落点，但目录里一个槽位就是一条件，`field` 与 `role` 在远端工作流
   * 模型上相同；留字段名是为了让不相等的情形（上游网关模型）也能被正确描述。
   */
  field: string;
  /**
   * 这个槽位由模型**显式声明**，而不是按模型类型兜底推出来的。
   *
   * 只有显式声明的槽位才会在未填充时渲染空位：兜底绑定里的 `first_frame` 表达的是
   * "这类模型可以接首帧"，不是"这个模型正在等首帧"。
   */
  declared: boolean;
};

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

/** 槽位展示名上限，与服务端 `MaxBindingLabelChars` 一致。 */
export const MAX_REFERENCE_LABEL_CHARS = 24;

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
    // 槽位元数据只透传形状合法的值：展示名过长或必填声明在非参考角色上，
    // 都说明上游声明有问题，静默带上它只会让面板显示一个错的东西。
    const label = typeof entry.label === "string" && entry.label.trim() !== ""
      ? entry.label.trim().slice(0, MAX_REFERENCE_LABEL_CHARS)
      : undefined;
    const required = entry.required === true;
    const declaredSlot = entry.declaredSlot === true;
    bindings.push({
      field: typeof entry.field === "string" && entry.field !== "" ? entry.field : semantic,
      semantic,
      roles: roles.length > 0 ? roles : [...DEFAULT_BINDING_ROLES[mediaKind]],
      mediaKinds: mediaKinds.length > 0 ? mediaKinds : [mediaKind],
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : [...DEFAULT_BINDING_MEDIA_TYPES[mediaKind]],
      maxItems,
      valueFormat: entry.valueFormat === "reference" ? "reference" : "url",
      ...(label !== undefined ? { label } : {}),
      ...(required ? { required } : {}),
      ...(declaredSlot ? { declaredSlot } : {})
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
    scanned.push(...normalizeInputBindings([{ field: key, semantic, maxItems }]));
  }
  if (scanned.length > 0) return summarizeBindings(scanned);

  return summarizeBindings([]);
}

/**
 * 把 bindings 展开成「模型声明的参考槽位」清单。
 *
 * 一个 binding 通常声明一个 role，但上游网关模型（如视频模型的 `urls`）会在一条
 * binding 里列出 `reference_image` / `first_frame` / `last_frame` 三个角色——那是
 * **三种角色共用一个落点**，属于"角色在字段内可互换"，不是三个独立槽位。所以这里按
 * role 展开，而不是按 field 展开。
 *
 * 顺序即面板顺序：以 binding 顺序为准，同一 binding 内保持 roles 声明顺序。让客户端
 * 按角色名重排会让「控制图在参考图前还是后」由字典序决定。
 */
export function declaredReferenceSlots(
  bindings: readonly CanvasTaskInputBinding[]
): CanvasReferenceSlot[] {
  const slots: CanvasReferenceSlot[] = [];
  for (const binding of bindings) {
    const mediaKind = binding.mediaKinds[0];
    if (mediaKind === undefined) continue;
    for (const role of binding.roles) {
      slots.push({
        role,
        label: referenceSlotLabel(binding, role),
        mediaKind,
        maxItems: binding.maxItems,
        required: binding.required === true,
        field: binding.field,
        declared: binding.declaredSlot === true
      });
    }
  }
  return slots;
}

/**
 * 槽位的展示名。
 *
 * 一条 binding 声明多个角色时不能直接用它自己的 label：那个名字说的是整个字段
 * （「参考图」），套到 `first_frame` 上会让人以为首帧和参考图是同一回事。
 */
function referenceSlotLabel(binding: CanvasTaskInputBinding, role: string): string {
  const declared = binding.label?.trim();
  if (declared !== undefined && declared !== "" && binding.roles.length === 1) return declared;
  return REFERENCE_ROLE_LABELS[role] ?? role;
}

/** 内置角色的中文名。自定义槽位没声明 label 时退回角色名本身。 */
export const REFERENCE_ROLE_LABELS: Readonly<Record<string, string>> = {
  reference_image: "参考图",
  reference_video: "参考视频",
  reference_audio: "参考音频",
  first_frame: "首帧",
  last_frame: "尾帧",
  edit_video: "编辑视频",
  voice_sample: "音色样本"
};

/**
 * 必填槽位里还没被填充的那些。
 *
 * 返回稳定顺序的原因串，供面板与提交前门禁共用：两处各算一遍会让「面板说缺控制图、
 * 提交却过了」或反过来。没有槽位声明时返回空数组（旧模型不受影响）。
 */
export function missingRequiredSlots(
  bindings: readonly CanvasTaskInputBinding[],
  filledRoles: Iterable<string>
): string[] {
  const filled = new Set(filledRoles);
  const reasons: string[] = [];
  for (const slot of declaredReferenceSlots(bindings)) {
    // 没声明的槽位不参与必填判定：必填是声明的一部分，兜底绑定不会声明必填。
    if (!slot.declared) continue;
    if (!slot.required || filled.has(slot.role)) continue;
    reasons.push(`缺少必填参考槽位：${slot.label}`);
  }
  return reasons;
}

/**
 * 把连线推断出的角色对齐到模型**实际声明的槽位**。
 *
 * 连线的角色来自源节点类型（图片源 → `reference_image`），而工作流驱动的模型只声明
 * 它自己要的槽位（例如只有 `control_image`）。不对齐的话，用户连一张控制图过来会得到
 * 「所选模型不接受参考角色 reference_image」——功能明明支持，却被判成不支持。
 *
 * 规则（只在当前角色不被任何 binding 接受时生效）：
 *   1. 找出模型声明的、媒体类别相同、且**还没被别的连线占用**的槽位；
 *   2. 恰好一个 → 用它（用户只有这一种可能，不需要选）；
 *   3. 多个 → 不猜，保持原角色让面板显示「不接受」，由用户显式指定；
 *   4. 没有 → 保持原角色（真的不支持该媒体类别）。
 *
 * 面板投影（`resolveReferenceItems`）与提交门禁（前端预检、Canvas Service 权威解析）
 * 共用这一份规则：三处各算一遍会出现「面板说就绪、提交却拦住」。
 */
export function alignRoleToDeclaredSlot(options: {
  inferredRole: string;
  mediaKind: CanvasReferenceMediaKind;
  bindings: readonly CanvasTaskInputBinding[] | undefined;
  /** 已被其它连线占用（或显式指定）的角色。 */
  claimedRoles: ReadonlySet<string>;
}): string {
  const { inferredRole, mediaKind, bindings, claimedRoles } = options;
  if (bindings === undefined) return inferredRole;
  const accepted = bindings.some(
    (entry) => entry.roles.includes(inferredRole) && entry.mediaKinds.includes(mediaKind)
  );
  if (accepted) return inferredRole;
  const candidates = declaredReferenceSlots(bindings).filter(
    (slot) => slot.declared && slot.mediaKind === mediaKind && !claimedRoles.has(slot.role)
  );
  return candidates.length === 1 ? candidates[0]!.role : inferredRole;
}
