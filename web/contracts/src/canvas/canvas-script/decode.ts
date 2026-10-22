/**
 * Canvas Script 严格 codec
 * （change: 2026-10-13-add-canvas-script-authoring，任务 1.1 / design D3、D4）。
 *
 * 在执行/授权/持久化**之前**拒绝：未知版本、未知字段、空身份、非法 expectedRevision、
 * 超源码字节预算。与 `agent-canvas-protocol` 共享同一套原语，不引入 schema 库。
 *
 * 浏览器安全：只用 `TextEncoder` 计算 UTF-8 字节数，不依赖 Node Buffer。
 */
import { isBoundedId, isJsonObject, isNonNegativeInteger } from "../../validation.js";
import { CANVAS_SCRIPT_LIMITS, isCanvasScriptVersion, type CanvasScriptVersion } from "./limits.js";
import { canvasScriptError, type CanvasScriptError } from "./types.js";

export type CanvasScriptDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CanvasScriptError };

export type DecodedCanvasScriptRequest = {
  canvasId: string;
  requestId: string;
  version: CanvasScriptVersion;
  source: string;
  expectedRevision?: number;
};

const REQUEST_KEYS = ["canvasId", "requestId", "version", "source", "expectedRevision"] as const;

function fail(
  code: string,
  message: string,
  field?: string,
  stage: CanvasScriptError["stage"] = "decode"
): CanvasScriptDecodeResult<never> {
  return { ok: false, error: canvasScriptError(code, stage, message, field !== undefined ? { field } : {}) };
}

/** 源码 UTF-8 字节数（大对象分配前判定）。 */
export function canvasScriptSourceBytes(source: string): number {
  return new TextEncoder().encode(source).length;
}

/**
 * 严格解码预检/提交请求。
 *
 * 预检与提交接受同一请求形状：两者都不接受任何「提交凭证」——身份与写权限由 MCP 连接期的
 * 受认证 principal + 资源策略负责，提交幂等由 requestId + submissionHash 负责。
 */
export function decodeCanvasScriptRequest(raw: unknown): CanvasScriptDecodeResult<DecodedCanvasScriptRequest> {
  if (!isJsonObject(raw)) return fail("malformed-request", "请求体必须是对象");
  const unknownKey = Object.keys(raw).find((key) => !(REQUEST_KEYS as readonly string[]).includes(key));
  if (unknownKey) {
    return fail("malformed-request", `未知字段 ${unknownKey}`, unknownKey);
  }
  if (!isBoundedId(raw.canvasId)) return fail("malformed-request", "canvasId 必须是非空字符串", "canvasId");
  if (!isBoundedId(raw.requestId)) return fail("malformed-request", "requestId 必须是非空字符串", "requestId");
  if (typeof raw.version !== "string" || raw.version.trim() === "") {
    return fail("malformed-request", "version 必须是非空字符串", "version");
  }
  if (!isCanvasScriptVersion(raw.version)) {
    return fail("unsupported-version", `不支持的脚本版本 ${raw.version}`, "version", "decode");
  }
  if (typeof raw.source !== "string") return fail("malformed-request", "source 必须是字符串", "source");
  if (raw.source.trim() === "") return fail("malformed-request", "source 不能为空", "source");
  const bytes = canvasScriptSourceBytes(raw.source);
  if (bytes > CANVAS_SCRIPT_LIMITS.sourceMaxBytes) {
    return fail(
      "script-limit-exceeded",
      `源码 ${bytes} 字节超过 ${CANVAS_SCRIPT_LIMITS.sourceMaxBytes} 字节上限`,
      "source"
    );
  }
  const decoded: DecodedCanvasScriptRequest = {
    canvasId: raw.canvasId,
    requestId: raw.requestId,
    version: raw.version,
    source: raw.source
  };
  if (raw.expectedRevision !== undefined) {
    if (!isNonNegativeInteger(raw.expectedRevision)) {
      return fail("malformed-request", "expectedRevision 必须是非负整数", "expectedRevision");
    }
    decoded.expectedRevision = raw.expectedRevision;
  }
  return { ok: true, value: decoded };
}
