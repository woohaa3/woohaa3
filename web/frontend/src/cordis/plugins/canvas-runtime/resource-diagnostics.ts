/** Cached, content-free gauges. Reading this snapshot never calls WASM. */
export const MODEL_RESOURCE_FIELDS = [
  "qualityVersion", "roots", "parts", "low", "medium", "high", "modelEntities",
  "staticBatches", "batchedParts", "instanceVertices", "instanceTriangles",
  "uniqueMeshes", "uniqueVertices", "uniqueTriangles", "retainedMeshes",
  "retainedMaterials", "retainedMeshBytes", "retainedBatchBytes",
  "captureSnapshots", "captureSnapshotBytes",
  ...(import.meta.env.DEV ? ["peakRetainedBatchBytes", "batchCreatedBufferBytes",
    "activeUniqueBatchBufferBytes", "activeBatchSourceBufferBytes"] as const : [])
] as const;
export const PREVIEW_RESOURCE_FIELDS = ["active", "pending", "textureBytes", "visible", "retained", "live", "deferred", "ready"] as const;
/**
 * 拍摄镜头卡片预览诊断字段
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7/任务 4.5）。
 *
 * 与实际工作计数同名同序；由 Bevy 独立通道上报，**不**与模型内嵌预览（`previews`）混用。
 * 只承载计数与缓存状态，不代表 GPU 帧率。
 */
export const SHOT_PREVIEW_RESOURCE_FIELDS = ["active", "pending", "textureBytes", "visible", "retained", "live", "deferred", "ready"] as const;
export const SIMPLIFICATION_RESOURCE_FIELDS = ["active", "pending", "sourceBytes", "cppWorkspaceActiveBytes", "cppWorkspacePeakBytes", "generated", "cancelled"] as const;
export type ResourceDiagnostics = {
  scope: "last-reported";
  observedAt: number;
  staticBatchStrategy?: "bevy-automatic" | "spatial-merge" | "explicit-instancing";
  models?: Readonly<Partial<Record<typeof MODEL_RESOURCE_FIELDS[number], number>>>;
  simplification?: Readonly<Partial<Record<typeof SIMPLIFICATION_RESOURCE_FIELDS[number], number>>>;
  previews?: Readonly<Partial<Record<typeof PREVIEW_RESOURCE_FIELDS[number], number>>>;
  /** 拍摄镜头卡片预览诊断（独立于模型内嵌预览）。 */
  shotPreviews?: Readonly<Partial<Record<typeof SHOT_PREVIEW_RESOURCE_FIELDS[number], number>>>;
};

export function readResourceDiagnostics(input: unknown, observedAt: number): ResourceDiagnostics | undefined {
  if (!input || typeof input !== "object" || !Number.isFinite(observedAt) || observedAt < 0) return undefined;
  const pick = <K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const fields: Partial<Record<K, number>> = {};
    for (const key of keys) {
      const count = (value as Record<string, unknown>)[key];
      if (typeof count === "number" && Number.isFinite(count) && count >= 0 && count <= 1e12) fields[key] = count;
    }
    return Object.keys(fields).length ? Object.freeze(fields) : undefined;
  };
  const raw = input as Record<string, unknown>;
  const models = pick(raw.models, MODEL_RESOURCE_FIELDS);
  const previews = pick(raw.previews, PREVIEW_RESOURCE_FIELDS);
  const shotPreviews = pick(raw.shotPreviews, SHOT_PREVIEW_RESOURCE_FIELDS);
  const simplification = pick((raw.models as Record<string, unknown> | undefined)?.simplification, SIMPLIFICATION_RESOURCE_FIELDS);
  if (!models && !previews && !shotPreviews && !simplification) return undefined;
  const strategy = import.meta.env.DEV ? (raw.models as Record<string, unknown> | undefined)?.staticBatchStrategy : undefined;
  return Object.freeze({ scope: "last-reported", observedAt,
    ...(strategy === "bevy-automatic" || strategy === "spatial-merge" || strategy === "explicit-instancing" ? { staticBatchStrategy: strategy } : {}),
    ...(models ? { models } : {}), ...(previews ? { previews } : {}), ...(shotPreviews ? { shotPreviews } : {}), ...(simplification ? { simplification } : {}) });
}
