/**
 * Task 历史 repository：白名单裁剪与预算
 * （自 `history-repository.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R04）。
 *
 * 写入时即做白名单裁剪，绝不落 prompt、provider 原始 input/output、bytes、签名 URL、
 * Authorization、堆栈或凭据。
 */
import type { TaskErrorSummary, TaskRequestSummary, TaskResultSummary } from "@woohaa3/contracts";

/** 结果白名单裁剪：只保留 mediaKind + 稳定 metadata/时长/海报 或安全文本摘要。 */
export function sanitizeResult(result: TaskResultSummary): TaskResultSummary {
  const text =
    result.text !== undefined && result.text.length > 2000 ? result.text.slice(0, 2000) : result.text;
  return {
    mediaKind: result.mediaKind,
    ...(text !== undefined ? { text } : {}),
    ...(result.textTruncated || (result.text !== undefined && result.text.length > 2000)
      ? { textTruncated: true }
      : {}),
    ...(result.storageKey !== undefined ? { storageKey: result.storageKey } : {}),
    ...(result.contentType !== undefined ? { contentType: result.contentType } : {}),
    ...(result.size !== undefined ? { size: result.size } : {}),
    ...(result.checksum !== undefined ? { checksum: result.checksum } : {}),
    ...(result.durationSeconds !== undefined ? { durationSeconds: result.durationSeconds } : {}),
    ...(result.poster ? { poster: { ...result.poster } } : {})
  };
}

/**
 * 错误白名单裁剪：name + message + 结构化状态码，绝不保留 stack / header / 响应体。
 *
 * status / code 是排障的关键判别位（区分鉴权失败、限流、参数错），保留它们不增加泄露面。
 */
export function sanitizeError(error: TaskErrorSummary): TaskErrorSummary {
  const status =
    typeof error.status === "number" && Number.isFinite(error.status) ? Math.trunc(error.status) : undefined;
  const code = typeof error.code === "string" && error.code !== "" ? error.code.slice(0, 120) : undefined;
  return {
    ...(error.name !== undefined ? { name: error.name } : {}),
    message: error.message.slice(0, 500),
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {})
  };
}

/** prompt 服务端上限（spec：最多 8000 字符并带截断标记）。 */
export const TASK_REQUEST_PROMPT_LIMIT = 8000;
/** parameters 投影预算（数量/深度/字节）。 */
export const TASK_REQUEST_PARAMETER_BUDGET = {
  maxKeys: 64,
  maxDepth: 6,
  maxBytes: 16_000
} as const;

/**
 * 请求摘要裁剪：保留 prompt 与 parameters，但递归剔除敏感键（签名 URL、凭据、bytes 等）。
 */
export function sanitizeRequest(request: TaskRequestSummary): TaskRequestSummary {
  const promptRaw = request.prompt ?? "";
  const prompt = promptRaw.slice(0, TASK_REQUEST_PROMPT_LIMIT);
  const pruned = prune(request.parameters) as Record<string, unknown> | undefined;
  const parameters = pruned ?? {};
  const serializedBytes = Buffer.byteLength(JSON.stringify(parameters), "utf8");
  const overBudget =
    Object.keys(request.parameters ?? {}).length !== Object.keys(parameters).length ||
    (request.parametersTruncated === true) ||
    serializedBytes > TASK_REQUEST_PARAMETER_BUDGET.maxBytes;
  const inputs = sanitizeRequestInputs(request.inputs);
  return {
    prompt,
    ...(promptRaw.length > TASK_REQUEST_PROMPT_LIMIT ? { promptTruncated: true } : {}),
    parameters,
    ...(overBudget ? { parametersTruncated: true } : {}),
    ...(inputs.length > 0 ? { inputs } : {})
  };
}

/** 参考输入上限：与提交侧 `CANVAS_TASK_LIMITS.maxReferences` 对齐，超出即丢弃尾部。 */
const MAX_PERSISTED_INPUTS = 16;

/**
 * 参考输入裁剪：只留稳定引用身份（role/mediaKind/mediaType/assetId/storageKey）。
 *
 * 执行期签出的 URL 会过期，绝不入库；它是「这张产物用了哪张素材」的唯一长期线索。
 */
function sanitizeRequestInputs(inputs: TaskRequestSummary["inputs"]): NonNullable<TaskRequestSummary["inputs"]> {
  if (!Array.isArray(inputs)) return [];
  return inputs.slice(0, MAX_PERSISTED_INPUTS).flatMap((input) => {
    if (!input || typeof input !== "object") return [];
    const role = typeof input.role === "string" ? input.role.slice(0, 64) : "";
    const mediaType = typeof input.mediaType === "string" ? input.mediaType.slice(0, 120) : "";
    if (role === "" || mediaType === "") return [];
    return [
      {
        role,
        mediaType,
        ...(typeof input.mediaKind === "string" ? { mediaKind: input.mediaKind.slice(0, 32) } : {}),
        ...(typeof input.assetId === "string" ? { assetId: input.assetId.slice(0, 200) } : {}),
        ...(typeof input.storageKey === "string" ? { storageKey: input.storageKey.slice(0, 400) } : {})
      }
    ];
  });
}

/** 事件 detail 裁剪：递归剔除敏感键。 */
export function sanitizeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  // 递归剔除敏感键，而不是整体丢弃：保留可诊断的非敏感字段。
  return prune(detail) as Record<string, unknown>;
}

const SENSITIVE_KEYS = new Set([
  "prompt",
  "input",
  "providerInput",
  "providerOutput",
  "rawInput",
  "rawOutput",
  "bytes",
  "base64",
  "blob",
  "url",
  "signedUrl",
  "authorization",
  "apiKey",
  "stack",
  "headers"
]);

function prune(value: unknown, depth = 0): unknown {
  if (depth > TASK_REQUEST_PARAMETER_BUDGET.maxDepth) return undefined;
  if (Array.isArray(value)) return value.map((entry) => prune(entry, depth + 1)).filter((entry) => entry !== undefined);
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (keys >= TASK_REQUEST_PARAMETER_BUDGET.maxKeys) break;
    const pruned = prune(nested, depth + 1);
    if (pruned !== undefined) {
      output[key] = pruned;
      keys += 1;
    }
  }
  return output;
}
