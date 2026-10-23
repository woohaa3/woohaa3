/**
 * Canvas Service 对外（浏览器/运行时）v1 协议（change: split-web-runtime-services，任务 1.3）。
 *
 * 浏览器与运行时继续使用**同源路径**；split 之后它们的 run/cancel 只进入 Canvas Service，
 * 由 Canvas 从 published Y.Doc 解析权威输入后异步提交 Task（proposal BREAKING）。
 * 浏览器不再直接提交派生输入，也不等待 `/api/pptask/tasks` 终态。
 */
import { isBoundedId, isJsonObject } from "../validation.js";
import { isModelKey } from "../task/model-identity.js";
import type { FrozenShotImageReference } from "./film-set-shot-image-reference.js";

export const CANVAS_API_BASE_PATH = "/api/canvases" as const;
export const CANVAS_HEALTH_BASE_PATH = "/api/canvas-storage/health" as const;
export const CANVAS_RUN_SUFFIX = "runs" as const;

/** 浏览器 run 请求：只给节点与模型/输入意图，权威输入由 Canvas 从 Y.Doc 解析。 */
export type CanvasRunRequest = {
  canvasId: string;
  nodeId: string;
  runId: string;
  jobId: string;
  /** 稳定 catalog 身份；Frontend 与 Canvas 都不得解析它推导 Provider。 */
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  shotImageReferences?: FrozenShotImageReference[];
};

export type CanvasRunResponse =
  | { ok: true; runId: string; jobId: string; state: "accepted" }
  | { ok: false; code: string; message: string };

export type CanvasCancelRequest = {
  canvasId: string;
  nodeId: string;
  runId: string;
};

export type CanvasCancelResponse =
  | { ok: true; state: "cancel-requested" }
  | { ok: false; code: string; message: string };

export function decodeCanvasRunRequest(
  body: unknown
): { ok: true; value: CanvasRunRequest } | { ok: false; code: string; message: string } {
  if (!isJsonObject(body)) return { ok: false, code: "malformed-request", message: "请求体必须是对象" };
  const canvasId = body.canvasId;
  const nodeId = body.nodeId;
  const runId = body.runId;
  const jobId = body.jobId;
  const modelKey = body.modelKey;
  for (const [key, value] of Object.entries({ canvasId, nodeId, runId, jobId, modelKey })) {
    if (!isBoundedId(value)) {
      return { ok: false, code: "malformed-request", message: `${key} 必须是非空字符串` };
    }
  }
  if (!isModelKey(modelKey)) {
    return { ok: false, code: "malformed-request", message: "modelKey 不是合法 catalog 身份" };
  }
  if (typeof body.prompt !== "string") {
    return { ok: false, code: "malformed-request", message: "prompt 必须是字符串" };
  }
  if (body.parameters !== undefined && !isJsonObject(body.parameters)) {
    return { ok: false, code: "malformed-request", message: "parameters 必须是对象" };
  }
  if (body.shotImageReferences !== undefined && (!Array.isArray(body.shotImageReferences) || body.shotImageReferences.length > 128 || !body.shotImageReferences.every(ref => isJsonObject(ref)
    && ["slotId", "sourceNodeId", "filmSetNodeId", "clipId", "contentIdentity", "profileKey"].every(key => isBoundedId(ref[key]))
    && typeof ref.background === "string" && /^#[0-9a-f]{6}$/i.test(ref.background)))) {
    return { ok: false, code: "malformed-request", message: "shotImageReferences 格式无效" };
  }
  return {
    ok: true,
    value: {
      canvasId: canvasId as string,
      nodeId: nodeId as string,
      runId: runId as string,
      jobId: jobId as string,
      modelKey: modelKey as string,
      prompt: body.prompt,
      ...(body.shotImageReferences === undefined ? {} : { shotImageReferences: body.shotImageReferences as FrozenShotImageReference[] }),
      parameters: (body.parameters as Record<string, unknown> | undefined) ?? {}
    }
  };
}

export function decodeCanvasCancelRequest(
  body: unknown
): { ok: true; value: CanvasCancelRequest } | { ok: false; code: string; message: string } {
  if (!isJsonObject(body)) return { ok: false, code: "malformed-request", message: "请求体必须是对象" };
  if (!isBoundedId(body.canvasId) || !isBoundedId(body.nodeId) || !isBoundedId(body.runId)) {
    return { ok: false, code: "malformed-request", message: "canvasId/nodeId/runId 必须是非空字符串" };
  }
  return {
    ok: true,
    value: { canvasId: body.canvasId, nodeId: body.nodeId, runId: body.runId }
  };
}

export function isCanvasRunResponse(value: unknown): value is CanvasRunResponse {
  if (!isJsonObject(value)) return false;
  if (value.ok === false) return typeof value.code === "string" && typeof value.message === "string";
  return value.ok === true && typeof value.runId === "string" && typeof value.jobId === "string" && value.state === "accepted";
}
