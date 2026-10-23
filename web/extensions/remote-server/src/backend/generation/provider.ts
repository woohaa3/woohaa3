/**
 * 远端托管生成的 pptask Provider（change: 2026-10-20-reserve-remote-generation-provider，tasks 5.3/5.4）。
 *
 * 形状与其它站点扩展 Provider 一致：`languageModel/imageModel/videoModel/audioModel` 各返回带
 * `doStart/doStatus/doCancel` 的实现。执行语义完全复用既有 worker：
 * - `doStart` → `SubmitTask`（提交立即返回，operation 只放可 JSON 化的任务句柄）；
 * - `doStatus` → `GetTask`（状态/进度/稳定结果）；
 * - `doCancel` → `CancelTask`（幂等）。
 *
 * 三条边界：
 * 1. **不在 operation 里放令牌**：operation 会随调度记录持久化；会话每次现取。
 * 2. **不发签名 URL**：提交只带 `storage_key` / `asset_id`，服务端按画布作用域读自己的对象。
 * 3. **不透传远端正文**：失败只出稳定码与稳定短语。
 */
import { isMediaLocator,
  GENERIC_MODEL_INTERACTION_ID,
  GENERIC_MODEL_INTERACTION_VERSION,
  type GenerationModelDefinition,
  type GenerationPrepareInput,
  type GenerationStableMediaResult
} from "@woohaa3/contracts";
import { createPptaskProvider } from "@sdppp/pptask";
import type {
  PptaskAudioModelImplementation,
  PptaskImageModelImplementation,
  PptaskLanguageModelImplementation,
  PptaskOperationStartResult,
  PptaskOperationStatusResult,
  PptaskProvider,
  PptaskVideoModelImplementation
} from "@sdppp/pptask";
import type { RemoteSession } from "../session.js";
// 失败码来自契约生成物（api/proto 的 GenerationFailure 枚举），不在本文件写字面量。
import { GENERATION_FAILURE } from "../../../../../../api/gen/es/woohaa/errors/v1alpha1/wirecodes_gen.js";
import { generationFailureText, generationRpcErrorText, isRemoteGenerationModelType, asRecord, decodeCancelResponse, decodeSubmitResponse, decodeTask, REMOTE_GENERATION_PROVIDER_ID, type GenerationAdmission } from "./protocol.js";
import { convergeGenerationParameters } from "./parameters.js";
import { translateImageParameters } from "./image-models.js";
import type { GenerationClient, GenerationSessionRef } from "./client.js";

/** 稳定错误：`code` 会由 pptask 的 `serializeError` 落进任务记录，界面/诊断只展示稳定短语。 */
export class RemoteGenerationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteGenerationError";
    this.code = code;
  }
}

/** 交给 doStart 的已编译提交输入（prepareInput 的产物；会随调度记录持久化，不含凭据）。 */
export type RemotePreparedInput = {
  /** 本扩展的 prepared 形状标记：防止把别的 Provider 的输入误当成本 Provider 的。 */
  __remoteServerGeneration: 1;
  idempotencyKey: string;
  canvasId?: string;
  modelKey: string;
  modelType: string;
  prompt: string;
  parameters: Record<string, unknown>;
  inputs: Array<{ assetId?: string; role: string; mediaLocator: string; mediaType: string; mediaKind?: string }>;
  interaction: { id: string; version: number };
  admission?: GenerationAdmission;
  runId?: string;
};

/** operation（持久化在调度记录里）：只放任务身份，不放令牌、不放结果。 */
type RemoteOperation = {
  taskId: string;
  modelKey: string;
  modelType: string;
  serverUrl: string;
};

export type RemoteGenerationProviderOptions = {
  client: GenerationClient;
  /** 当前会话（唯一来源；没有会话时执行按稳定失败收敛）。 */
  session: () => Promise<Pick<RemoteSession, "serverUrl" | "token"> | null>;
  /** 已归一模型（prepareInput 需要 interaction）。 */
  modelFor: (providerModelId: string) => GenerationModelDefinition | undefined;
  /** 目录受理版本（catalogRevision/schemaRevision/configVersion）。 */
  admissionFor: (providerModelId: string) => GenerationAdmission | undefined;
  /** 轮询间隔（毫秒）；缺省交给 pptask（1000）。 */
  pollIntervalMs?: number;
  providerId?: string;
  /** 把参考字节推到本部署存储并返回 locator（由后端装配注入）。 */
  putReference?: (input: { bytes: Uint8Array; contentType: string; canvasId?: string; storageKey?: string }) => Promise<string | undefined>;
};

function requireSession(session: Pick<RemoteSession, "serverUrl" | "token"> | null): GenerationSessionRef {
  if (session === null) throw new RemoteGenerationError("unauthenticated", "服务端会话已失效，请重新登录");
  return session;
}

/**
 * 从规范输入构造 SubmitTask 请求（tasks 5.3）。
 *
 * 只接受稳定引用：`storage_key` 是服务端按 `(canvas_id, storage_key)` 读取的稳定键，`url`
 * 一律丢弃（签名地址会过期，服务端也不该抓取任意地址）。缺画布身份/幂等键/稳定素材键时
 * 立即抛稳定失败，而不是提交一个服务端注定拒绝的请求。
 */
export function prepareRemoteGenerationInput(
  input: GenerationPrepareInput,
  deps: Pick<RemoteGenerationProviderOptions, "modelFor" | "admissionFor">
): RemotePreparedInput {
  const canvasId = typeof input.canvasId === "string" ? input.canvasId.trim() : "";
  const idempotencyKey = typeof input.taskKey === "string" ? input.taskKey.trim() : "";
  if (idempotencyKey === "") {
    throw new RemoteGenerationError("idempotency-key-missing", "缺少提交幂等键");
  }
  const model = deps.modelFor(input.providerModelId);
  if (model === undefined) {
    throw new RemoteGenerationError(GENERATION_FAILURE.catalogChanged, generationFailureText(GENERATION_FAILURE.catalogChanged));
  }
  const inputs: RemotePreparedInput["inputs"] = [];
  for (const reference of input.references) {
    // 服务端只认它自己能读的对象：locator 优先（远端 uploadReference 刚写好的位置），
    // 其次透传契约里已有的 locator。裸 storageKey 不再作为跨进程凭据。
    // 只读 locator：Task 已经把位置放在这个字段里，不再从 url 里猜。
    const locator =
      typeof reference.locator === "string" && isMediaLocator(reference.locator) ? reference.locator : "";
    if (locator === "") {
      // 键缺失/非法就不要把这次提交送出去：交一个服务端读不到的键，只会在执行期变成
      // 一个更难懂的失败；而按文生图静默出图更糟。
      throw new RemoteGenerationError(GENERATION_FAILURE.mediaNotFound, generationFailureText(GENERATION_FAILURE.mediaNotFound));
    }
    inputs.push({
      ...(typeof reference.assetId === "string" && reference.assetId !== "" ? { assetId: reference.assetId } : {}),
      role: reference.role,
      mediaLocator: locator,
      mediaType: reference.mediaType,
      ...(reference.mediaKind !== undefined ? { mediaKind: reference.mediaKind } : {})
    });
  }
  const admission = deps.admissionFor(input.providerModelId);
  return {
    __remoteServerGeneration: 1,
    idempotencyKey,
    canvasId,
    modelKey: input.providerModelId,
    modelType: input.modelType,
    prompt: input.prompt,
    // 两步，顺序不能反：
    // 1. **收敛**：默认值合并 + 脏值清洗 + 已声明字段按 enum/type 校准。untrusted 的
    //    参数（面板的隐藏字段、清空后留下的空串、批处理残留的旧模型参数）在这里被拦下，
    //    不把「用户没选的值」当成「用户选了这个值」发给服务端。
    // 2. **翻译**：面板语义（resolution / aspectRatio）→ 上游字段（像素 size /
    //    image_size / aspect_ratio）。服务端把 parameters 原样转给 LiteLLM，不认语义键。
    parameters: translateImageParameters(
      input.providerModelId,
      convergeGenerationParameters({
        inputSchema: model.inputSchema,
        defaultInput: model.defaultInput,
        parameters: input.parameters
      })
    ),
    inputs,
    interaction: model.interaction ?? {
      id: GENERIC_MODEL_INTERACTION_ID,
      version: GENERIC_MODEL_INTERACTION_VERSION
    },
    ...(admission !== undefined
      ? {
          admission: {
            catalogRevision: admission.catalogRevision,
            schemaRevision: admission.schemaRevision,
            configVersion: admission.configVersion
          }
        }
      : {}),
    ...(typeof input.runId === "string" && input.runId !== "" ? { runId: input.runId } : {})
  };
}

/** 取 prepareInput 的产物；形状不符时给出稳定失败（不猜字段）。 */
function readPreparedInput(value: unknown): RemotePreparedInput {
  const record = asRecord(value);
  if (record === null || record.__remoteServerGeneration !== 1) {
    throw new RemoteGenerationError(GENERATION_FAILURE.unsupported, "提交输入不可识别");
  }
  return record as unknown as RemotePreparedInput;
}

function toSubmitBody(prepared: RemotePreparedInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    idempotencyKey: prepared.idempotencyKey,
    canvasId: prepared.canvasId,
    modelKey: prepared.modelKey,
    modelType: prepared.modelType,
    prompt: prepared.prompt,
    parameters: prepared.parameters,
    inputs: prepared.inputs,
    interaction: prepared.interaction,
    ...(prepared.admission !== undefined ? { admission: prepared.admission } : {}),
    ...(prepared.runId !== undefined ? { runId: prepared.runId } : {})
  };
  return body;
}

function readOperation(value: unknown): RemoteOperation {
  const record = asRecord(value);
  const taskId = record?.taskId;
  if (typeof taskId !== "string" || taskId === "") {
    throw new RemoteGenerationError("invalid-operation", "执行句柄不可识别");
  }
  return {
    taskId,
    modelKey: typeof record?.modelKey === "string" ? record.modelKey : "",
    modelType: typeof record?.modelType === "string" ? record.modelType : "",
    serverUrl: typeof record?.serverUrl === "string" ? record.serverUrl : ""
  };
}

/** doStatus 的返回：与 pptask 的三种 status 同形，结果按模型类型装成文本或稳定媒体。 */
type RemoteStatus =
  | { status: "pending"; phase: "queued" | "running"; progress?: number }
  | { status: "error"; error: string }
  | { status: "completed"; content?: Array<{ type: "text"; text: string }>; media?: GenerationStableMediaResult["media"] };

/**
 * GetTask → pptask 状态。
 *
 * `unknown`/`cancelled` 都按稳定失败抛出（带 `code`），这样任务记录里留下的是稳定码而不是
 * 远端正文；瞬态传输错误同样抛出，由 worker 的有界重试兜住。
 */
async function pollRemoteTask(
  options: RemoteGenerationProviderOptions,
  modelType: string,
  operationValue: unknown
): Promise<RemoteStatus> {
  const operation = readOperation(operationValue);
  const session = requireSession(await options.session());
  const result = await options.client.getTask(session, { taskId: operation.taskId });
  if (!result.ok) {
    if (result.code === "not_found") {
      throw new RemoteGenerationError("task-lost", "服务端任务已丢失");
    }
    if (result.code === "unauthenticated") {
      throw new RemoteGenerationError("unauthenticated", generationRpcErrorText(result.code));
    }
    throw new RemoteGenerationError(GENERATION_FAILURE.unavailable, generationRpcErrorText(result.code));
  }
  const task = decodeTask(result.value);
  const progress = task.progress ?? undefined;
  switch (task.state) {
    case "queued":
    case "pending":
      return { status: "pending", phase: "queued", ...(progress !== undefined ? { progress } : {}) };
    case "running":
      return { status: "pending", phase: "running", ...(progress !== undefined ? { progress } : {}) };
    case "succeeded": {
      if (modelType === "language") {
        if (task.text === null) {
          throw new RemoteGenerationError(GENERATION_FAILURE.unsupported, "服务端没有返回文本结果");
        }
        return { status: "completed", content: task.text.content };
      }
      if (task.media === null) {
        throw new RemoteGenerationError(GENERATION_FAILURE.storageFailed, "服务端没有返回可用的媒体结果");
      }
      return {
        status: "completed",
        media: { ...task.media.media, storageKey: task.media.media.storageKey ?? "" }
      };
    }
    case "failed": {
      const code = task.failure?.code ?? GENERATION_FAILURE.unsupported;
      throw new RemoteGenerationError(code, generationFailureText(code));
    }
    case "cancelled":
      throw new RemoteGenerationError("cancelled", "服务端任务已取消");
    case "unspecified":
    default:
      throw new RemoteGenerationError("unspecified-state", "服务端返回了未设置的任务状态");
  }
}

/** SubmitTask：把已编译输入送出去，返回可持久化的任务句柄。 */
async function startRemoteTask(
  options: RemoteGenerationProviderOptions,
  modelType: string,
  preparedValue: unknown
): Promise<PptaskOperationStartResult> {
  if (!isRemoteGenerationModelType(modelType)) {
    throw new RemoteGenerationError(GENERATION_FAILURE.unsupported, generationFailureText(GENERATION_FAILURE.unsupported));
  }
  const prepared = readPreparedInput(preparedValue);
  const session = requireSession(await options.session());
  const submitted = await options.client.submitTask(session, toSubmitBody(prepared));
  if (!submitted.ok) {
    throw new RemoteGenerationError(
      submitted.code === "unauthenticated" ? "unauthenticated" : GENERATION_FAILURE.unavailable,
      generationRpcErrorText(submitted.code)
    );
  }
  const response = decodeSubmitResponse(submitted.value);
  if (response.taskId === null) {
    throw new RemoteGenerationError(GENERATION_FAILURE.unavailable, "服务端没有返回任务号");
  }
  // 稳定拒绝（key-reused / canvas-not-shared / catalog-changed …）以 FAILED 状态返回：
  // 稳定码在 GetTask 的 error.code 里（proto 注释 D1/D8）。
  if (response.state === "failed") {
    const detail = await options.client.getTask(session, { taskId: response.taskId });
    const task = detail.ok ? decodeTask(detail.value) : null;
    const code = task?.failure?.code ?? GENERATION_FAILURE.unsupported;
    throw new RemoteGenerationError(code, generationFailureText(code));
  }
  const operation: RemoteOperation = {
    taskId: response.taskId,
    modelKey: prepared.modelKey,
    modelType,
    // 只用于诊断/切服判断，不是凭据。
    serverUrl: session.serverUrl
  };
  return {
    operation: operation as unknown as PptaskOperationStartResult["operation"],
    providerMetadata: { remoteServer: { taskId: response.taskId, reused: response.reused } }
  };
}

async function cancelRemoteTask(options: RemoteGenerationProviderOptions, operationValue: unknown): Promise<void> {
  const operation = readOperation(operationValue);
  const session = requireSession(await options.session());
  const result = await options.client.cancelTask(session, operation.taskId);
  if (!result.ok) {
    throw new RemoteGenerationError(GENERATION_FAILURE.unavailable, generationRpcErrorText(result.code));
  }
  const state = decodeCancelResponse(result.value);
  if (state === null) {
    throw new RemoteGenerationError(GENERATION_FAILURE.unsupported, "服务端没有返回取消结果");
  }
}

/**
 * 构造 Provider。
 *
 * `providerId` 参与 `modelKey = <providerId>:<model_key>`；站点扩展注册时与
 * `GenerationProvider.providerId` 必须是同一个值。
 */
export function createRemoteGenerationProvider(options: RemoteGenerationProviderOptions): PptaskProvider {
  const providerId = options.providerId ?? REMOTE_GENERATION_PROVIDER_ID;
  /** doStatus 的返回类型对每种模型不同（ImageModelV4Result / …），结果形状由我们定义后单点收口。 */
  const statusFor = async (modelType: string, operation: unknown) =>
    ({ ...(await pollRemoteTask(options, modelType, operation)) }) as unknown as PptaskOperationStatusResult<Record<string, unknown>>;
  const startFor = (modelType: string) => (input: unknown) => startRemoteTask(options, modelType, input);
  const cancelFor = (operation: unknown) => cancelRemoteTask(options, operation);

  const languageModel = (): PptaskLanguageModelImplementation => ({
    supportedUrls: {},
    doStart: startFor("language"),
    doStatus: ((args: { operation: unknown }) => statusFor("language", args.operation)) as unknown as PptaskLanguageModelImplementation["doStatus"],
    doCancel: ((args: { operation: unknown }) => cancelFor(args.operation)) as unknown as PptaskLanguageModelImplementation["doCancel"]
  });

  const imageModel = (): PptaskImageModelImplementation => ({
    maxImagesPerCall: 1,
    doStart: startFor("image"),
    doStatus: ((args: { operation: unknown }) => statusFor("image", args.operation)) as unknown as PptaskImageModelImplementation["doStatus"],
    doCancel: ((args: { operation: unknown }) => cancelFor(args.operation)) as unknown as PptaskImageModelImplementation["doCancel"]
  });

  const videoModel = (): PptaskVideoModelImplementation => ({
    maxVideosPerCall: 1,
    doStart: startFor("video") as unknown as PptaskVideoModelImplementation["doStart"],
    doStatus: ((args: { operation: unknown }) => statusFor("video", args.operation)) as unknown as PptaskVideoModelImplementation["doStatus"],
    doCancel: ((args: { operation: unknown }) => cancelFor(args.operation)) as unknown as PptaskVideoModelImplementation["doCancel"]
  });

  const audioModel = (): PptaskAudioModelImplementation => ({
    doStart: startFor("audio"),
    doStatus: ((args: { operation: unknown }) => statusFor("audio", args.operation)) as unknown as PptaskAudioModelImplementation["doStatus"],
    doCancel: ((args: { operation: unknown }) => cancelFor(args.operation)) as unknown as PptaskAudioModelImplementation["doCancel"]
  });

  return createPptaskProvider({
    providerId,
    languageModel,
    imageModel,
    videoModel,
    audioModel,
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
  });
}
