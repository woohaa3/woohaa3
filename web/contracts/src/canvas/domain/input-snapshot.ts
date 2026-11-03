/**
 * 生成运行输入快照的有界解码（独立小模块：画布聚合校验与历史条目 codec 共用，
 * 不能把整个 node-history codec 拖进 canvas-yjs 的构建产物）。
 */
import type { RunInputSnapshot } from "./types.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INPUT_SNAPSHOT_LIMITS = { prompt: 8000, parametersBytes: 8192, references: 32, short: 300 } as const;

/** 输入快照：有界、只认已知字段；非法返回 null（整条历史条目因此被拒，不静默丢字段）。 */
export function decodeInputSnapshot(input: unknown): RunInputSnapshot | null {
  if (!isJsonObject(input)) return null;
  if (typeof input.prompt !== "string" || input.prompt.length > INPUT_SNAPSHOT_LIMITS.prompt) return null;
  if (!Array.isArray(input.references) || input.references.length > INPUT_SNAPSHOT_LIMITS.references) return null;
  const short = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= INPUT_SNAPSHOT_LIMITS.short;
  const references: RunInputSnapshot["references"] = [];
  for (const item of input.references) {
    if (!isJsonObject(item) || !short(item.assetId) || !short(item.role)) return null;
    if (item.mediaKind !== undefined && !short(item.mediaKind)) return null;
    if (item.field !== undefined && !short(item.field)) return null;
    references.push({
      assetId: item.assetId,
      role: item.role,
      ...(item.mediaKind !== undefined ? { mediaKind: item.mediaKind as string } : {}),
      ...(item.field !== undefined ? { field: item.field as string } : {})
    });
  }
  const value: RunInputSnapshot = { prompt: input.prompt, references };
  if (input.modelKey !== undefined) {
    if (!short(input.modelKey)) return null;
    value.modelKey = input.modelKey;
  }
  if (input.selfReferenceAssetId !== undefined) {
    if (!short(input.selfReferenceAssetId)) return null;
    value.selfReferenceAssetId = input.selfReferenceAssetId;
  }
  if (input.parameters !== undefined) {
    if (!isJsonObject(input.parameters) || JSON.stringify(input.parameters).length > INPUT_SNAPSHOT_LIMITS.parametersBytes) return null;
    value.parameters = input.parameters as Record<string, unknown>;
  }
  return value;
}
