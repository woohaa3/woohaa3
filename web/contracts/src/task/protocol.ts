/**
 * Task Service 内部 v1 协议（change: split-web-runtime-services，任务 1.3 / design D4）。
 *
 * 语义（精确路径可在实现时调整，语义固定）：
 * ```
 * PUT  /internal/v1/tasks/:workerTaskKey        幂等 submit
 * POST /internal/v1/tasks/:workerTaskKey/cancel  幂等 cancel
 * GET  /internal/v1/tasks/:workerTaskKey         单条 status
 * GET  /internal/v1/task-history?after=&limit=   持久化 history（恢复事实源）
 * GET  /internal/v1/task-events?after=           已持久化事实的事件流（仅降延迟）
 * ```
 *
 * 关键约束：submit 在 durable accepted 后返回；相同 key+payload 返回同一记录；
 * 相同 key+不同 payload 稳定拒绝（`key-reused`）。Task 不回写 Canvas（无 webhook）。
 */
import { isBoundedId, isJsonObject, isNonNegativeInteger, isValidStorageKey } from "../validation.js";
import { catalogModelBindings,
  isCanvasTaskModelType,
  isCanvasTaskNodeType,
  isNodeModelTypeMatch,
  type CanvasReferenceMediaKind,
  type CanvasTaskCatalogModel,
  type CanvasTaskInput,
  type CanvasTaskModelType,
  type CanvasTaskNodeType } from "./dto.js";
import {
  isModelInteractionDescriptor,
  isModelKey,
  type ModelInteractionDescriptor
} from "./model-identity.js";
import { decodeWorldCaptureGenerationBinding } from "../canvas/world-capture-pipeline-contract.js";
import { worldCaptureReferenceInput, withWorldCaptureTaskInput } from "./world-capture-input.js";
import type { TaskExecutionDetail, TaskExecutionState, TaskHistoryQuery } from "./history.js";

export const DEFAULT_TASK_INTERNAL_BASE_PATH = "/internal/v1";

/** submit 请求体：由 Canvas 从 published Y.Doc 解析后构造。 */
export type TaskSubmitRequest = {
  /** In-process Canvas port only; HTTP decoder deliberately does not accept caller-supplied owners. */
  serviceConnection?: { serviceConnectionId: string; owner: string };
  /** 稳定幂等 key：Canvas 生成，同一 run 重试用同一值。 */
  workerTaskKey: string;
  canvasId: string;
  nodeId: string;
  runId: string;
  jobId: string;
  nodeType: CanvasTaskNodeType;
  modelType: CanvasTaskModelType;
  /** 稳定 opaque catalog 身份（change: add-pluggable-model-interactions，D1）。 */
  modelKey: string;
  /** catalog 声明的交互 identity；Task 校验其与当前 catalog 一致。 */
  interaction?: ModelInteractionDescriptor;
  prompt: string;
  parameters: Record<string, unknown>;
  /** 只含稳定媒体引用；Task 通过 Media Service 校验并签出执行期 URL。 */
  inputs: CanvasTaskInput[];
  /**
   * T10 static world framing frozen at acceptance. It is stable metadata only (no
   * bytes/URL); it is recorded so a completed run can be traced to the exact captured
   * media and version, independent of later canvas changes.
   */
  worldCapture?: import("../canvas/world-capture-pipeline-contract.js").WorldCaptureGenerationBinding;
  /**
   * 执行时显示快照（由 Canvas 提交方从可信 catalog/画布投影；change:
   * improve-task-history-experience，任务 1.3）。缺省时旧记录降级为稳定 ID。
   */
  modelTitle?: string;
  providerName?: string;
  canvasTitle?: string;
  nodeTitle?: string;
};

/** submit 响应：accepted 不等待 provider 终态。 */
export type TaskSubmitResponse = {
  workerTaskKey: string;
  state: TaskExecutionState;
  /** true 表示这是已存在的记录（幂等命中）。 */
  reused: boolean;
  canvasId: string;
  nodeId: string;
  runId: string;
};

/** cancel 响应。 */
export type TaskCancelResponse = {
  workerTaskKey: string;
  state: TaskExecutionState;
};

/** 单条 status（内部视图，含安全摘要）。 */
export type TaskStatusResponse = TaskExecutionDetail;

export type TaskHistoryResponse = {
  items: TaskExecutionDetail[];
  nextCursor?: string;
};

/** 内部历史查询与浏览器只读历史查询共用同一筛选语义。 */
export type InternalTaskHistoryQuery = TaskHistoryQuery;

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const REFERENCE_MEDIA_KINDS: readonly CanvasReferenceMediaKind[] = ["image", "video", "audio"];

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function readInputs(raw: unknown): DecodeResult<CanvasTaskInput[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail("malformed-request", "inputs 必须是数组");
  const inputs: CanvasTaskInput[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isJsonObject(entry)) return fail("malformed-request", `inputs[${index}] 必须是对象`);
    if (!isBoundedId(entry.assetId) || !isBoundedId(entry.role)) {
      return fail("malformed-request", `inputs[${index}] 缺少 assetId/role`);
    }
    if (!isValidStorageKey(entry.storageKey)) {
      return fail("malformed-request", `inputs[${index}] 的 storageKey 不是受控对象键`);
    }
    if (typeof entry.mediaType !== "string" || entry.mediaType === "") {
      return fail("malformed-request", `inputs[${index}] 缺少 mediaType`);
    }
    const mediaKind =
      entry.mediaKind === undefined
        ? undefined
        : REFERENCE_MEDIA_KINDS.includes(entry.mediaKind as CanvasReferenceMediaKind)
          ? (entry.mediaKind as CanvasReferenceMediaKind)
          : null;
    if (mediaKind === null) {
      return fail("malformed-request", `inputs[${index}] 的 mediaKind 不合法`);
    }
    const slotId =
      entry.slotId === undefined ? undefined : isBoundedId(entry.slotId) ? entry.slotId : null;
    if (slotId === null) {
      return fail("malformed-request", `inputs[${index}] 的 slotId 不合法`);
    }
    const sourceNodeId =
      entry.sourceNodeId === undefined ? undefined : isBoundedId(entry.sourceNodeId) ? entry.sourceNodeId : null;
    if (entry.sourceNodeId !== undefined && sourceNodeId === null) {
      return fail("malformed-request", `inputs[${index}] 的 sourceNodeId 不合法`);
    }
    const order =
      entry.order === undefined
        ? undefined
        : typeof entry.order === "number" && Number.isInteger(entry.order) && entry.order >= 0
          ? entry.order
          : null;
    if (order === null) {
      return fail("malformed-request", `inputs[${index}] 的 order 必须是非负整数`);
    }
    inputs.push({
      assetId: entry.assetId,
      role: entry.role,
      storageKey: entry.storageKey,
      mediaType: entry.mediaType,
      ...(mediaKind ? { mediaKind } : {}),
      ...(slotId ? { slotId } : {}),
      ...(sourceNodeId ? { sourceNodeId } : {}),
      ...(order !== undefined ? { order } : {})
    });
  }
  return { ok: true, value: inputs };
}

/**
 * 解码并**结构校验**内部 submit 请求。
 *
 * 只做协议层形态校验（不走 catalog / 不访问 Media）；能力校验（模型启用、参考 role/count/
 * media type、prompt 长度）由 Task Service 在 catalog 与 Media 边界内独立完成。
 */
export function decodeTaskSubmitRequest(
  body: unknown,
  options: { maxPromptChars?: number } = {}
): DecodeResult<TaskSubmitRequest> {
  const maxPromptChars = options.maxPromptChars ?? 8000;
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是 JSON 对象");

  const workerTaskKey = body.workerTaskKey;
  if (!isBoundedId(workerTaskKey)) return fail("malformed-request", "workerTaskKey 必须是非空字符串");
  const canvasId = body.canvasId;
  if (!isBoundedId(canvasId)) return fail("malformed-request", "canvasId 必须是非空字符串");
  const nodeId = body.nodeId;
  if (!isBoundedId(nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  const runId = body.runId;
  if (!isBoundedId(runId)) return fail("malformed-request", "runId 必须是非空字符串");
  const jobId = body.jobId;
  if (!isBoundedId(jobId)) return fail("malformed-request", "jobId 必须是非空字符串");

  if (!isCanvasTaskNodeType(body.nodeType)) {
    return fail("malformed-request", `不支持的节点类型：${String(body.nodeType)}`);
  }
  if (!isCanvasTaskModelType(body.modelType)) {
    return fail("malformed-request", `不支持的模型类型：${String(body.modelType)}`);
  }
  const nodeType = body.nodeType;
  const modelType = body.modelType;
  if (!isNodeModelTypeMatch(nodeType, modelType)) {
    return fail("malformed-request", `${nodeType} 节点不能使用 ${modelType} 模型`);
  }

  const modelKey = body.modelKey;
  if (!isModelKey(modelKey)) return fail("malformed-request", "modelKey 必须是非空合法字符串");
  const interaction = body.interaction;
  if (interaction !== undefined && !isModelInteractionDescriptor(interaction)) {
    return fail("malformed-request", "interaction 必须是合法的 {id,version}");
  }
  if (typeof body.prompt !== "string") return fail("malformed-request", "prompt 必须是字符串");
  if (body.prompt.length > maxPromptChars) {
    return fail("limit-exceeded", `prompt 超过 ${maxPromptChars} 字上限`);
  }

  const parameters = isJsonObject(body.parameters) ? body.parameters : {};
  const inputs = readInputs(body.inputs);
  if (!inputs.ok) return inputs;

  const worldCapture = body.worldCapture === undefined
    ? undefined
    : decodeWorldCaptureGenerationBinding(body.worldCapture);
  if (worldCapture && !worldCapture.ok) {
    return fail("malformed-request", "worldCapture 不是可信冻结输入");
  }
  if (worldCapture?.ok && !worldCaptureReferenceInput(worldCapture.value).ok) {
    // A capture binding without verified media cannot become a provider reference;
    // accepting it would silently fall back to a text-only generation.
    return fail("malformed-request", "worldCapture 缺少可信媒体元数据");
  }

  return {
    ok: true,
    value: {
      workerTaskKey,
      canvasId,
      nodeId,
      runId,
      jobId,
      nodeType,
      modelType,
      modelKey,
      ...(interaction ? { interaction: interaction as ModelInteractionDescriptor } : {}),
      prompt: body.prompt,
      parameters,
      inputs: withWorldCaptureTaskInput(inputs.value, worldCapture?.ok ? worldCapture.value : undefined),
      ...(worldCapture?.ok ? { worldCapture: worldCapture.value } : {}),
      ...readOptionalTitle(body.modelTitle, "modelTitle"),
      ...readOptionalTitle(body.providerName, "providerName"),
      ...readOptionalTitle(body.canvasTitle, "canvasTitle"),
      ...readOptionalTitle(body.nodeTitle, "nodeTitle")
    }
  };
}

/** 可选显示名快照：只接受有界非空字符串，否则忽略（页面降级为稳定 ID）。 */
function readOptionalTitle(
  value: unknown,
  field: string
): { modelTitle?: string; providerName?: string; canvasTitle?: string; nodeTitle?: string } {
  if (typeof value !== "string" || value === "" || value.length > 200) return {};
  return { [field]: value } as { modelTitle?: string; providerName?: string; canvasTitle?: string; nodeTitle?: string };
}

/**
 * 校验模型能力（在 catalog 已解析之后调用）。
 *
 * 按 bindings 校验：每个输入必须匹配某个 binding 的 role、mediaKind（缺失时按 mediaType
 * 推断）和 mediaType；各 binding 的数量分别有上限。旧 catalog（只有图片字段）通过
 * `catalogModelBindings()` 兼容读取。
 */
/** 能力门禁的失败码：调用方必须原样转发（不要把「超上限」降级成「不支持」）。 */
export type ModelCapabilityFailure = {
  ok: false;
  code: "unsupported" | "limit-exceeded";
  message: string;
};

function capabilityFail(code: ModelCapabilityFailure["code"], message: string): ModelCapabilityFailure {
  return { ok: false, code, message };
}

export function checkModelCapability(
  request: TaskSubmitRequest,
  model: CanvasTaskCatalogModel
): { ok: true } | ModelCapabilityFailure {
  if (model.modelType !== request.modelType) {
    return capabilityFail("unsupported", `模型 ${model.modelKey} 类型与请求不一致`);
  }
  if (request.inputs.length === 0) return { ok: true };
  const bindings = catalogModelBindings(model);
  if (bindings.length === 0) {
    return capabilityFail("unsupported", `模型 ${model.modelKey} 不接受参考输入`);
  }
  const counts = new Map<string, number>();
  for (const input of request.inputs) {
    const mediaKind = input.mediaKind ?? inferMediaKindFromType(input.mediaType);
    const match = bindings.find(
      (binding) =>
        binding.roles.includes(input.role) &&
        binding.mediaTypes.includes(input.mediaType) &&
        (mediaKind === undefined || binding.mediaKinds.includes(mediaKind))
    );
    if (!match) {
      return capabilityFail(
        "unsupported",
        `模型 ${model.modelKey} 不接受参考输入（role=${input.role} type=${input.mediaType}）`
      );
    }
    const used = (counts.get(match.field) ?? 0) + 1;
    if (used > match.maxItems) {
      return capabilityFail(
        "limit-exceeded",
        `参考输入数量 ${used} 超过模型 ${model.modelKey} 对 ${match.field} 的上限 ${match.maxItems}`
      );
    }
    counts.set(match.field, used);
  }
  return { ok: true };
}

/** mediaType → mediaKind 的兜底推断（旧客户端缺 mediaKind 时）。 */
export function inferMediaKindFromType(mediaType: string): CanvasReferenceMediaKind | undefined {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return undefined;
}

export function isSubmitResponse(value: unknown): value is TaskSubmitResponse {
  if (!isJsonObject(value)) return false;
  return (
    isBoundedId(value.workerTaskKey) &&
    typeof value.state === "string" &&
    typeof value.reused === "boolean" &&
    typeof value.canvasId === "string" &&
    typeof value.nodeId === "string" &&
    typeof value.runId === "string"
  );
}

export function isNonNegativeIntegerField(value: unknown): value is number {
  return isNonNegativeInteger(value);
}
