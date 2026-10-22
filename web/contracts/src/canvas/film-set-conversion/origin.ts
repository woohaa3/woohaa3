/**
 * 转换来源 metadata 的严格解码
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.3/1.4 / design D5）。
 *
 * 纯函数、JSON-only 叶子模块：只依赖 validation 原语与同目录类型，避免与
 * `canvas-node-model` 形成环。非法字段整体丢弃（origin 仅说明，不影响加载），但保留可解析部分。
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "../../validation.js";
import { readFilmSetConversionAssistant } from "./assistant.js";
import {
  FILM_SET_CONVERSION_INSTRUCTION_VERSION,
  FILM_SET_CONVERSION_SOURCE_KINDS,
  type FilmSetConversionOriginRecord,
  type FilmSetConversionRange,
  type FilmSetConversionSourceKind
} from "./types.js";

/** 严格读取转换范围。 */
function decodeRange(input: unknown): FilmSetConversionRange | undefined {
  if (!isJsonObject(input)) return undefined;
  const { startSeconds, endSeconds } = input;
  if (!isFiniteNumber(startSeconds) || startSeconds < 0) return undefined;
  if (!isFiniteNumber(endSeconds) || endSeconds <= startSeconds) return undefined;
  return { startSeconds, endSeconds };
}

/**
 * 读取转换来源 metadata；缺失/非法返回 `undefined`。
 *
 * 必填：requestId、sourceKind、sourceHash；可选：modelKey、instructionVersion、range、
 * unmappedCameras。任一必填缺失即整体丢弃（不写入半截来源）。
 */
export function decodeFilmSetConversionOriginRecord(input: unknown): FilmSetConversionOriginRecord | undefined {
  if (!isJsonObject(input)) return undefined;
  const requestId = input.requestId;
  const sourceKind = input.sourceKind;
  const sourceHash = input.sourceHash;
  if (!isBoundedId(requestId)) return undefined;
  if (typeof sourceKind !== "string"
    || !(FILM_SET_CONVERSION_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    return undefined;
  }
  if (typeof sourceHash !== "string" || sourceHash.length === 0 || sourceHash.length > 200) return undefined;
  const record: FilmSetConversionOriginRecord = {
    requestId,
    sourceKind: sourceKind as FilmSetConversionSourceKind,
    sourceHash
  };
  if (typeof input.modelKey === "string" && (isBoundedId(input.modelKey) || readFilmSetConversionAssistant(input.modelKey))) record.modelKey = input.modelKey;
  if (
    typeof input.instructionVersion === "number"
    && Number.isInteger(input.instructionVersion)
    && input.instructionVersion >= 1
    && input.instructionVersion <= FILM_SET_CONVERSION_INSTRUCTION_VERSION
  ) {
    record.instructionVersion = input.instructionVersion;
  }
  const range = decodeRange(input.range);
  if (range) record.range = range;
  if (Array.isArray(input.unmappedCameras)) {
    const names = input.unmappedCameras.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 80
    );
    if (names.length > 0) record.unmappedCameras = names;
  }
  return record;
}
