/**
 * 画布存储核心的稳定错误类型（任务 2.1）。
 *
 * 这些 `code` 是跨进程契约：HTTP 层映射状态码、客户端做类型分支、contract suite 做
 * 一致性断言都按**字符串**比较（跨 bundle 无法 `instanceof`），因此重命名等同于破坏契约。
 *
 * 刻意不依赖任何数据库、COS SDK 或 HTTP 框架：适配器把底层异常翻译成这里的 code，
 * 而不是让底层错误泄漏到应用服务或 HTTP 响应。
 */

export type CanvasStorageErrorCode =
  | "CANVAS_NOT_FOUND"
  | "CANVAS_ALREADY_EXISTS"
  | "REVISION_CONFLICT"
  | "COMMAND_REJECTED"
  | "INVALID_OPERATION_ID"
  | "INVALID_ACTOR_ID"
  | "INVALID_COMMAND_BATCH"
  | "LIMIT_EXCEEDED"
  | "ASSET_REFERENCE_INVALID"
  | "REPOSITORY_FAILURE"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "NOT_READY"
  // 提示词片段目录（change: add-prompt-snippet-library）：独立于画布聚合的错误码。
  | "SNIPPET_NOT_FOUND"
  | "SNIPPET_NAME_CONFLICT"
  | "SNIPPET_READ_ONLY"
  | "TAG_NOT_FOUND"
  | "TAG_NAME_CONFLICT"
  | "SNIPPET_INVALID"
  | "SNIPPET_OPERATION_CONFLICT"
  | "SNIPPET_REVISION_CONFLICT"
  // 节点生成历史（change: add-canvas-node-generation-history）：独立于画布聚合的错误码。
  | "NODE_HISTORY_NOT_FOUND"
  | "NODE_HISTORY_INVALID"
  | "NODE_HISTORY_UNRECOVERABLE"
  | "NODE_HISTORY_CONFLICT"
  | "NODE_HISTORY_LIMIT_EXCEEDED"
  // 在线画布迁移导入（change: 2026-10-12-add-extension-online-canvas-migration）。
  | "SOURCE_CHANGED"
  | "TARGET_CONFLICT";

/**
 * 核心存储错误。`details` 只允许放**安全**的结构化信息（例如字段名、限制值）。
 * 绝不放数据库连接串、绝对路径、堆栈、COS 凭据或签名 URL。
 */
export class CanvasStorageError extends Error {
  readonly code: CanvasStorageErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CanvasStorageErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CanvasStorageError";
    this.code = code;
    if (details) this.details = details;
  }
}

export function isCanvasStorageError(error: unknown): error is CanvasStorageError {
  if (error instanceof CanvasStorageError) return true;
  const value = error as { name?: unknown; code?: unknown } | null | undefined;
  return value?.name === "CanvasStorageError" && typeof value.code === "string";
}

/** 不依赖 `instanceof` 的 code 判定，供跨 bundle 场景使用。 */
export function canvasStorageErrorCode(error: unknown): CanvasStorageErrorCode | undefined {
  const value = error as { code?: unknown } | null | undefined;
  if (!value || typeof value.code !== "string") return undefined;
  return CANVAS_STORAGE_ERROR_CODES.includes(value.code as CanvasStorageErrorCode)
    ? value.code as CanvasStorageErrorCode
    : undefined;
}

export const CANVAS_STORAGE_ERROR_CODES: readonly CanvasStorageErrorCode[] = [
  "CANVAS_NOT_FOUND",
  "CANVAS_ALREADY_EXISTS",
  "REVISION_CONFLICT",
  "COMMAND_REJECTED",
  "INVALID_OPERATION_ID",
  "INVALID_ACTOR_ID",
  "INVALID_COMMAND_BATCH",
  "LIMIT_EXCEEDED",
  "ASSET_REFERENCE_INVALID",
  "REPOSITORY_FAILURE",
  "SCHEMA_VERSION_UNSUPPORTED",
  "NOT_READY",
  "SNIPPET_NOT_FOUND",
  "SNIPPET_NAME_CONFLICT",
  "SNIPPET_READ_ONLY",
  "TAG_NOT_FOUND",
  "TAG_NAME_CONFLICT",
  "SNIPPET_INVALID",
  "SNIPPET_OPERATION_CONFLICT",
  "SNIPPET_REVISION_CONFLICT",
  "NODE_HISTORY_NOT_FOUND",
  "NODE_HISTORY_INVALID",
  "NODE_HISTORY_UNRECOVERABLE",
  "NODE_HISTORY_CONFLICT",
  "NODE_HISTORY_LIMIT_EXCEEDED",
  "SOURCE_CHANGED",
  "TARGET_CONFLICT"
];
