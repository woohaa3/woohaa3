/**
 * 首次打开准备契约（change: 2026-10-12-add-extension-online-canvas-migration，任务 1.1 / design D5、D6）。
 *
 * 受认证 prepare / 无创建副作用 status 的 DTO 与有界 decoder，以及平台消费的当前格式候选。
 * `CanvasImportCandidate.canvas` 是**已转换的当前格式** `ServerCanvas`，绝不是旧 unknown JSON。
 * 公共候选不携带旧 JSON/Y.Doc/Binary；旧格式只在来源扩展内部存在。
 */
import { isJsonObject, isNonNegativeInteger, isBoolean } from "../validation.js";
import type { ServerCanvas } from "./domain/types.js";
import type { NodeGenerationHistoryEntry } from "./node-history.js";
import type {
  CanvasImportDiagnostics,
  CanvasSourceBinding,
  ImportedCanvasAccess
} from "./source.js";

/** 准备阶段（design D6 状态机）。 */
export const PREPARATION_PHASES = [
  "admitted",
  "reading",
  "converting",
  "materializing",
  "validating",
  "committing"
] as const;

export type PreparationPhase = (typeof PREPARATION_PHASES)[number];

export function isPreparationPhase(value: unknown): value is PreparationPhase {
  return typeof value === "string" && (PREPARATION_PHASES as readonly string[]).includes(value);
}

/** 稳定的准备状态；失败携带稳定 code 与 retryable。 */
export type PreparationState =
  | { state: "ready"; canvasId: string; revision: number }
  | {
      state: "preparing";
      jobId: string;
      phase: PreparationPhase;
      completedMedia: number;
      totalMedia: number;
      pollAfterMs: number;
    }
  | { state: "failed"; code: string; retryable: boolean; message: string }
  | { state: "deleted"; code: "DELETED" };

export function isPreparationState(value: unknown): value is PreparationState {
  if (!isJsonObject(value)) return false;
  switch (value.state) {
    case "ready":
      return typeof value.canvasId === "string" && isNonNegativeInteger(value.revision);
    case "preparing":
      return (
        typeof value.jobId === "string" &&
        value.jobId.length > 0 &&
        isPreparationPhase(value.phase) &&
        isNonNegativeInteger(value.completedMedia) &&
        isNonNegativeInteger(value.totalMedia) &&
        isNonNegativeInteger(value.pollAfterMs)
      );
    case "failed":
      return typeof value.code === "string" && isBoolean(value.retryable) && typeof value.message === "string";
    case "deleted":
      return value.code === "DELETED";
    default:
      return false;
  }
}

/** 默认/边界轮询提示。 */
export const PREPARATION_DEFAULT_POLL_AFTER_MS = 1_500;

/**
 * 当前格式导入候选（平台在目标事务前构建并校验）。
 *
 * `checkpoint` 由 Canvas 用当前 Yjs codec 从 `canvas` 构建并 round-trip 校验，不在扩展内构造。
 */
export type CanvasImportCandidate = {
  binding: CanvasSourceBinding;
  canvas: ServerCanvas;
  access: ImportedCanvasAccess;
  history: readonly NodeGenerationHistoryEntry[];
  diagnostics: CanvasImportDiagnostics;
};

/** prepare 请求体：只含可选 sourceId；主体来自宿主认证，绝不来自 body。 */
export type CanvasPrepareRequest = { sourceId?: string };

export function decodeCanvasPrepareRequest(
  value: unknown
): { ok: true; request: CanvasPrepareRequest } | { ok: false; code: string; message: string } {
  if (value === undefined || value === null) return { ok: true, request: {} };
  if (!isJsonObject(value)) return { ok: false, code: "malformed-request", message: "prepare 请求体必须是对象" };
  if (value.sourceId === undefined) return { ok: true, request: {} };
  if (typeof value.sourceId !== "string" || value.sourceId.length === 0 || value.sourceId.length > 120) {
    return { ok: false, code: "malformed-request", message: "sourceId 非法" };
  }
  return { ok: true, request: { sourceId: value.sourceId } };
}

/** 来源扩展输出的绑定候选：读取快照并校验冻结代次/水位后返回。 */
export type CanvasSourceReadiness =
  | { ok: true }
  | { ok: false; code: string; retryable: boolean; message: string };

export function isCanvasSourceReadiness(value: unknown): value is CanvasSourceReadiness {
  if (!isJsonObject(value)) return false;
  if (value.ok === true) return true;
  if (value.ok !== false) return false;
  return typeof value.code === "string" && isBoolean(value.retryable) && typeof value.message === "string";
}
