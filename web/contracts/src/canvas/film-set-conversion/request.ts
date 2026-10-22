/**
 * 转换请求规范化、规范输入 hash 与 HTTP 请求解码
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.1/1.2 / design D5）。
 *
 * 同一 `requestId` 用**规范输入 hash** 绑定；相同请求（双击、重连、查询、重试）返回原任务，
 * 同 ID 不同输入被拒绝。hash **不含** `canvasId` / `requestId` / `targetNodeId` 等身份字段，
 * 只覆盖来源与设置。
 */
import { fnv1a64Hex } from "../content-hash.js";
import { readFilmSetConversionAssistant } from "./assistant.js";
import { isBoundedId, isJsonObject } from "../../validation.js";
import { isAgentReasoningEffort } from "../../extension/conversation.js";
import {
  FILM_SET_CONVERSION_SOURCE_KINDS,
  type FilmSetConversionRange,
  type FilmSetConversionRequest,
  type FilmSetConversionSettings,
  type FilmSetConversionSourceKind
} from "./types.js";

const MAX_INSTRUCTION_LENGTH = 2000;

/** 解码视频时间范围；缺失返回 `null`，非法返回 `"invalid"`。 */
export function decodeFilmSetConversionRange(
  input: unknown
): FilmSetConversionRange | null | "invalid" {
  if (input === undefined || input === null) return null;
  if (!isJsonObject(input)) return "invalid";
  const { startSeconds, endSeconds } = input;
  if (typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || startSeconds < 0) return "invalid";
  if (typeof endSeconds !== "number" || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return "invalid";
  return { startSeconds, endSeconds };
}

/** 规范化转换设置；非法字段整体拒绝（不静默丢弃）。 */
export function normalizeFilmSetConversionSettings(
  input: unknown
): { ok: true; value: FilmSetConversionSettings } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isJsonObject(input)) return { ok: false, message: "转换设置必须是对象" };
  const settings: FilmSetConversionSettings = {};
  if (input.connection !== undefined) {
    const connection = input.connection;
    if (!isJsonObject(connection) || !isBoundedId(connection.connectionId) || !isBoundedId(connection.adapterId) ||
        typeof connection.configRevision !== "number" || !Number.isSafeInteger(connection.configRevision) || connection.configRevision < 0 ||
        typeof connection.credentialEpoch !== "number" || !Number.isSafeInteger(connection.credentialEpoch) || connection.credentialEpoch < 0) return { ok: false, message: "助手连接身份非法" };
    settings.connection = { connectionId: connection.connectionId, adapterId: connection.adapterId, configRevision: connection.configRevision, credentialEpoch: connection.credentialEpoch };
  }
  if (input.reasoningEffort !== undefined) {
    if (!isAgentReasoningEffort(input.reasoningEffort)) return { ok: false, message: "Variant 非法" };
    settings.reasoningEffort = input.reasoningEffort;
  }
  if (input.modelKey !== undefined) {
    if (!isBoundedId(input.modelKey) && !(typeof input.modelKey === "string" && readFilmSetConversionAssistant(input.modelKey))) return { ok: false, message: "转换模型 key 非法" };
    settings.modelKey = input.modelKey;
  }
  if (input.instruction !== undefined) {
    if (typeof input.instruction !== "string" || input.instruction.length > MAX_INSTRUCTION_LENGTH) {
      return { ok: false, message: "补充要求必须是长度受限的字符串" };
    }
    settings.instruction = input.instruction;
  }
  const range = decodeFilmSetConversionRange(input.range);
  if (range === "invalid") return { ok: false, message: "视频时间范围非法" };
  if (range !== null) settings.range = range;
  return { ok: true, value: settings };
}

/**
 * 规范输入（用于 hash 与幂等比较）：只包含来源与设置，不含身份字段。
 * 键顺序与缺省值处理固定，保证同一输入派生出同一 hash。
 */
export function canonicalFilmSetConversionInput(request: FilmSetConversionRequest): Record<string, unknown> {
  const settings = request.settings ?? {};
  const range = settings.range;
  return {
    sourceNodeId: request.sourceNodeId,
    sourceKind: request.sourceKind,
    modelKey: settings.modelKey ?? null,
    ...(settings.connection ? { connection: settings.connection } : {}),
    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    instruction: settings.instruction ?? null,
    range: range ? [range.startSeconds, range.endSeconds] : null
  };
}

/** 规范输入 hash（FNV-1a 64-bit hex）；同一输入稳定，不同输入不同。 */
export function filmSetConversionInputHash(request: FilmSetConversionRequest): string {
  return fnv1a64Hex(JSON.stringify(canonicalFilmSetConversionInput(request)));
}

/**
 * 解码 HTTP 请求体为转换请求；`canvasId` 由路由路径提供，其余字段在此校验。
 *
 * 空/非法 ID、未知来源种类、非法设置一律拒绝（返回稳定错误码给路由）。
 */
export function decodeFilmSetConversionRequest(
  input: unknown
): { ok: true; value: FilmSetConversionRequest } | { ok: false; code: "malformed-request"; message: string } {
  if (!isJsonObject(input)) return { ok: false, code: "malformed-request", message: "请求体必须是对象" };
  const canvasId = input.canvasId;
  const requestId = input.requestId;
  const sourceNodeId = input.sourceNodeId;
  const targetNodeId = input.targetNodeId;
  if (!isBoundedId(canvasId)) return { ok: false, code: "malformed-request", message: "canvasId 非法" };
  if (!isBoundedId(requestId)) return { ok: false, code: "malformed-request", message: "requestId 非法" };
  if (!isBoundedId(sourceNodeId)) return { ok: false, code: "malformed-request", message: "sourceNodeId 非法" };
  if (!isBoundedId(targetNodeId)) return { ok: false, code: "malformed-request", message: "targetNodeId 非法" };
  const sourceKind = input.sourceKind;
  if (typeof sourceKind !== "string"
    || !(FILM_SET_CONVERSION_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    return { ok: false, code: "malformed-request", message: "sourceKind 非法" };
  }
  const settings = normalizeFilmSetConversionSettings(input.settings);
  if (!settings.ok) return { ok: false, code: "malformed-request", message: settings.message };
  return {
    ok: true,
    value: {
      canvasId,
      requestId,
      sourceNodeId,
      targetNodeId,
      sourceKind: sourceKind as FilmSetConversionSourceKind,
      ...(Object.keys(settings.value).length > 0 ? { settings: settings.value } : {})
    }
  };
}
