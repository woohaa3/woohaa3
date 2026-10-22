/**
 * 生成能力扩展点契约
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 1.2 / design D1/D2/D4）。
 *
 * 生成 Provider 作为后端 Cordis 应用插件贡献；生成模块（Task 领域）消费这些注册来构建
 * catalog、执行、投影。契约只含稳定 DTO 与不透明 provider 句柄，**不**引入 provider SDK、
 * 依赖或凭据。
 */
import type { CanvasTaskModelType } from "../task/dto.js";
import type { ModelInteractionDescriptor } from "../task/model-identity.js";
import type { GenerationModelCapabilityFacts } from "../task/model-capabilities.js";
import { isValidStorageKey } from "../validation.js";

/** 模型级 prompt 要求（design D4）：required 保持既有规则，optional/none 允许纯素材工作流。 */
export const PROMPT_REQUIREMENTS = ["required", "optional", "none"] as const;
export type PromptRequirement = (typeof PROMPT_REQUIREMENTS)[number];

export function isPromptRequirement(value: unknown): value is PromptRequirement {
  return typeof value === "string" && (PROMPT_REQUIREMENTS as readonly string[]).includes(value);
}

/** 模型级取消能力：区分本地取消与远端取消。 */
export type GenerationCancelCapability = "local" | "remote" | "unsupported";

/** 模型定义（资源定义 + 运营身份；不含秘密）。 */
export type GenerationModelDefinition = {
  providerId: string;
  providerModelId: string;
  modelType: CanvasTaskModelType;
  operation?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  defaultInput?: Record<string, unknown>;
  /** 模型级 prompt 要求；缺省 required（保持既有语义）。 */
  promptRequirement?: PromptRequirement;
  /** 受信任 interaction identity；缺省由生成模块回落到 generic。 */
  interaction?: ModelInteractionDescriptor;
  /** 取消能力；缺省 local。 */
  cancel?: GenerationCancelCapability;
  /**
   * 该模型当前能否执行。缺省表示跟随 Provider 的 `available`。
   * Provider 已就绪但这个模型还缺自己的配置（例如方舟接入点）时为 false：设置页仍列出，任务目录不收录。
   */
  executable?: boolean;
  taskTimeoutMs?: number;
  /** 参考输入声明（role/mediaKind/binding 等）；结构由生成模块校验。 */
  capabilities?: Record<string, unknown>;
  /**
   * 模型事实能力（change: 2026-10-20-declare-generation-model-capabilities）。
   *
   * 只承载 inputSchema/bindings 表达不了的事实（本期为 reasoning）；参考媒体输入
   * 仍由 inputSchema 的 bindings 表达。缺省 = 未声明（消费者按不支持处理）。
   */
  capabilityFacts?: GenerationModelCapabilityFacts;
};

/** 生成 Provider 的不透明句柄：由插件提供，生成模块原样交给运行时执行。 */
export type GenerationProviderHandle = unknown;

/**
 * 一个可执行的生成 Provider 注册。
 *
 * `provider` 是 pptask `PptaskProvider` 的不透明句柄（契约层不引入其类型）。
 * 生成模块负责把它交给 worker 运行时。
 */
export type GenerationProvider = {
  extensionId: string;
  providerId: string;
  /** 该 Provider 当前是否可执行（凭据/配置就绪）。 */
  available: boolean;
  /**
   * 模型启用集合的权威来源（change: 2026-10-20-reserve-remote-generation-provider）。
   *
   * 缺省 `local`：按站点运营策略过滤；`server`：Provider 自己的目录（例如远端托管生成）
   * 就是权威，模型直接进入 catalog，本地策略 MUST NOT 过滤，也不因此改写策略存储。
   */
  selectionAuthority?: "local" | "server";
  /**
   * 目录版本（可选，单调）。Provider 只改 schema/能力、不改模型 id 集合时，用它参与
   * 生成签名，使 catalog 失效重算；缺省不参与。
   */
  catalogRevision?: number;
  /** 不透明执行句柄。 */
  provider: GenerationProviderHandle;
  /** 模型注册表 + 静态描述（describe 不发网络请求）。 */
  models: GenerationModelDefinition[];
  /** 按 providerModelId 取模型定义。 */
  describe?: (providerModelId: string) => GenerationModelDefinition | undefined;
  /**
   * 把已校验参数与稳定参考输入编译成 Provider 真正需要的输入
   * （change: 2026-10-04-...，任务 4.2/4.4 / design D4）。
   *
   * 缺省时生成模块使用通用 `prompt + parameters + urls/videoUrls/audioUrls` 形状。
   * RunningHub 之类需要 `providerOptions.<providerId>.input` 的 Provider 提供本钩子。
   * 输入只含稳定引用与已校验参数，不含凭据或任意 URL。
   */
  prepareInput?: (input: GenerationPrepareInput) => Record<string, unknown>;
  /**
   * 参考输入的传递方式（缺省 `url`）。
   *
   * `storage-key` 表示 Provider 直接消费稳定 `storageKey`（不签 URL、不上传字节），
   * 此时 Task 不会调用 `uploadReference`，也不会调用 Media 的 `sign`。
   */
  referenceHandling?: GenerationReferenceHandling;
  /**
   * Provider 自带上传参考素材（设计稿 storage-extension-point 的生成链路 ①）。
   *
   * 提交时 Task 先问 Provider：有本钩子且能把参考字节读出来，就交给它自己上传（返回的地址
   * 直接进参考输入）；返回空或没实现时才走存储的 `expose` 签出地址。凭据不出插件。
   */
  uploadReference?: GenerationReferenceUpload;
  /**
   * 动态描述一个模型（含 `inputSchema`/`defaultInput`/`capabilities`），用于构建 catalog。
   * （change: 2026-10-06-add-runninghub-api-models-and-provider-credentials，任务 1.3）
   *
   * Provider 自己的 `describe` 是参数 schema 的权威（litellm 图像走 OpenAI Images 字段、
   * runninghub 的 params 都在此）；缺省时 catalog 只用注册时声明的静态 `inputSchema`。
   * 返回的 providerId/modelId MUST NOT 覆盖注册表身份（生成模块只取描述字段）。
   */
  describeModel?: (input: { providerModelId: string; modelType: "language" | "image" | "video" | "audio" }) =>
    Promise<GenerationModelDescription | undefined> | GenerationModelDescription | undefined;
  /**
   * 逻辑模型 → 具体执行 endpoint 的路由（change: 2026-10-06-add-runninghub-api-models-and-provider-credentials，
   * design D1b）。合并模型（如 t2i/i2i 合并）在提交时按输入选择具体 providerModelId；
   * 缺省时执行身份仍是 catalog 的 providerModelId。
   */
  resolveProviderModel?: (input: GenerationResolveModelInput) => string;
};

/** Provider 对单个模型的动态描述（catalog 用；身份仍由注册表固定）。 */
export type GenerationModelDescription = {
  providerId?: string;
  modelId?: string;
  modelType?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
  defaultInput?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  /** 模型事实能力；缺省 = 未声明（消费者按不支持处理）。 */
  capabilityFacts?: GenerationModelCapabilityFacts;
  promptRequirement?: PromptRequirement;
  cancel?: GenerationCancelCapability;
};

/**
 * 参考输入的传递方式（`GenerationProvider.referenceHandling`，缺省 `url`）。
 *
 * - `url`：Task 先问 Provider 的 `uploadReference`，否则由存储 `expose` 签出执行期地址，
 *   写进 `GenerationTaskReference.url`；Provider 只认地址。
 * - `storage-key`：Task **不签地址、也不上传**，直接把稳定 `storageKey` 交给 Provider。
 *   远端托管生成属于这一类：服务端按 `(canvasId, storageKey)` 读**自己的**对象，
 *   而这张画布的媒体已经由归属路由放在服务端（见 docs/design/canvas-media-and-reference-flow.md）。
 */
export type GenerationReferenceHandling = "url" | "storage-key";

/** 稳定参考输入（`url` 模式下的形状，顺序与提交一致）。 */
export type GenerationReference = { role: string; mediaKind?: string; mediaType: string; url: string };

/**
 * 交给 Provider 的稳定参考输入：执行期地址 + 原始稳定身份。
 *
 * `url` 只在 `referenceHandling: "url"` 时存在。`storage-key` 模式下 MUST NOT 读取 `url`：
 * 那类 Provider 拿 `storageKey` 就够，任何地址都会被服务端丢弃。
 */
export type GenerationTaskReference = {
  role: string;
  mediaKind?: string;
  mediaType: string;
  /** 执行期地址（`url` 模式必有；`storage-key` 模式缺省）。 */
  url?: string;
  assetId?: string;
  /** media namespace 内的稳定键；`storage-key` 模式下是唯一传递凭据。 */
  storageKey?: string;
};

/**
 * Provider 自带上传的输入（设计稿 storage-extension-point 的生成链路 ①）。
 *
 * 有 `uploadReference` 的 Provider 先自己把参考素材传到它的素材服务，返回可直接传给生成
 * API 的地址/句柄；返回空表示这次不做，由宿主按存储的 expose 解析顺序签出地址。
 * 凭据不出插件。
 */
export type GenerationReferenceUploadInput = {
  reference: { role: string; mediaKind?: string; mediaType: string };
  bytes: Uint8Array;
  contentType: string;
  /**
   * 这次提交属于哪张画布。
   *
   * 远端托管 Provider 要把素材写进服务端存储的**画布作用域**（服务端按
   * `(canvas_id, storage_key)` 读自己的对象），没有画布身份就无法落对位置。
   * 本机 Provider 忽略它。
   */
  canvasId?: string;
  /** 素材在本机的稳定键（诊断与去重可用；远端 Provider 用它对齐提交键）。 */
  storageKey?: string;
};

export type GenerationReferenceUpload = (
  input: GenerationReferenceUploadInput
) => Promise<string | undefined> | string | undefined;

/** 生成模块交给插件 `prepareInput` 的规范输入。 */
export type GenerationPrepareInput = {
  providerModelId: string;
  modelType: "language" | "image" | "video" | "audio";
  prompt: string;
  parameters: Record<string, unknown>;
  /** 稳定参考输入（顺序与提交一致）。 */
  references: ReadonlyArray<GenerationTaskReference>;
  /** 这次执行属于哪张画布（远端 ACL 与对象键作用域都需要）。 */
  canvasId?: string;
  /** 客户端幂等执行键（通常等于 workerTaskKey）。 */
  taskKey?: string;
  runId?: string;
  /** 插件在 `resolveProviderModel` 中选出的具体 endpoint（合并模型路由结果）。 */
  endpoint?: string;
};

/** 生成模块交给插件 `resolveProviderModel` 的规范输入。 */
export type GenerationResolveModelInput = {
  providerModelId: string;
  modelType: "language" | "image" | "video" | "audio";
  prompt: string;
  parameters: Record<string, unknown>;
  references: ReadonlyArray<GenerationTaskReference>;
  canvasId?: string;
  taskKey?: string;
  runId?: string;
};

/**
 * 已被服务端持久化的稳定媒体结果（change: 2026-10-20-reserve-remote-generation-provider）。
 *
 * Provider（典型是远端托管生成）可直接返回这种形状；Task worker 会先用 Media `verify`
 * 按画布作用域确认对象可读，再写 `TaskResultSummary`，**不再搬运字节**。顺序：主媒体在前，
 * `poster` 只用于视频。MUST NOT 包含签名 URL 或字节。
 */
export type GenerationStableMediaResult = {
  media: {
    storageKey: string;
    contentType: string;
    size: number;
    checksum?: string;
    durationSeconds?: number;
    poster?: { storageKey: string; contentType: string; size: number; checksum?: string };
  };
};

/** 识别稳定媒体结果；非法形状一律返回 false（调用方回落到既有 URL/bytes 路径）。 */
export function isGenerationStableMediaResult(value: unknown): value is GenerationStableMediaResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const media = (value as { media?: unknown }).media;
  if (typeof media !== "object" || media === null || Array.isArray(media)) return false;
  const entry = media as Record<string, unknown>;
  if (typeof entry.storageKey !== "string" || !isValidStorageKey(entry.storageKey)) return false;
  if (typeof entry.contentType !== "string" || entry.contentType === "") return false;
  if (typeof entry.size !== "number" || !Number.isFinite(entry.size) || entry.size < 0) return false;
  if (entry.checksum !== undefined && typeof entry.checksum !== "string") return false;
  if (entry.durationSeconds !== undefined && (typeof entry.durationSeconds !== "number" || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds < 0)) return false;
  if (entry.poster !== undefined) {
    if (typeof entry.poster !== "object" || entry.poster === null || Array.isArray(entry.poster)) return false;
    const poster = entry.poster as Record<string, unknown>;
    if (typeof poster.storageKey !== "string" || !isValidStorageKey(poster.storageKey)) return false;
    if (typeof poster.contentType !== "string" || poster.contentType === "") return false;
    if (typeof poster.size !== "number" || !Number.isFinite(poster.size) || poster.size < 0) return false;
    if (poster.checksum !== undefined && typeof poster.checksum !== "string") return false;
  }
  return true;
}
