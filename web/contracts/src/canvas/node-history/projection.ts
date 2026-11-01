/**
 * 节点生成历史：条目 → 安全列表项 / 完整详情投影
 * （自 `node-history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R06）。
 *
 * 列表只返回卡片所需的安全 metadata 与受控预览引用，**不**泄露完整正文、`storageKey`、
 * `poster.storageKey` 或完整模型脚本；详情按 `entryId` 按需读取。
 */
import type {
  CanvasGenerationHistoryListItem,
  NodeGenerationHistoryDetail,
  NodeGenerationHistoryEntry,
  NodeGenerationHistoryListItem,
  NodeHistoryMediaPayload,
  NodeHistoryModelPayload,
  NodeHistoryPreview,
  NodeHistoryTextPayload
} from "./types.js";

const MAX_TEXT_EXCERPT = 160;

/** 条目 outcome；旧条目缺省视为成功（兼容）。 */
function outcomeOf(entry: NodeGenerationHistoryEntry): NodeGenerationHistoryListItem["outcome"] {
  // 失败归档的权威 outcome 同时存在于 failure payload；即使存储/传输层没有回填顶层
  // outcome，也不能把失败记录降级成成功。
  if (entry.payload.kind === "failure") return entry.payload.outcome;
  return entry.outcome ?? "succeeded";
}

/** 从完整条目派生安全列表项。`current` 由调用方按权威输出判定后传入。 */
export function toNodeHistoryListItem(
  entry: NodeGenerationHistoryEntry,
  input: { current: boolean; previewHref: (suffix: string) => string }
): NodeGenerationHistoryListItem {
  const outcome = outcomeOf(entry);
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    createdAt: entry.createdAt,
    outcome,
    // 失败/取消/中断记录不是当前生效内容，即使 caller 误传也强制 false。
    current: outcome === "succeeded" ? input.current : false,
    recoverable: entry.recoverable,
    previewable: entry.previewable,
    source: { ...entry.source },
    preview: buildPreview(entry, input.previewHref)
  };
}

/**
 * 从完整条目派生画布级安全列表项
 * （change: add-canvas-generation-history-dialog）。
 */
export function toCanvasHistoryListItem(
  entry: NodeGenerationHistoryEntry,
  input: { current: boolean; previewHref: (suffix: string) => string; nodeTitle: string }
): CanvasGenerationHistoryListItem {
  return {
    ...toNodeHistoryListItem(entry, input),
    nodeId: entry.nodeId,
    nodeTitle: input.nodeTitle
  };
}

function buildPreview(
  entry: NodeGenerationHistoryEntry,
  href: (suffix: string) => string
): NodeHistoryPreview {
  if (entry.payload.kind === "failure") {
    return { kind: "failure", outcome: entry.payload.outcome, message: entry.payload.message };
  }
  switch (entry.kind) {
    case "text": {
      const text = (entry.payload as NodeHistoryTextPayload).text;
      return { kind: "text", excerpt: truncate(text, MAX_TEXT_EXCERPT) };
    }
    case "image":
      return { kind: "image", href: href("preview") };
    case "video": {
      const payload = entry.payload as NodeHistoryMediaPayload;
      return {
        kind: "video",
        href: href("preview"),
        // 只有携带稳定海报的版本才暴露 poster 引用：缺失海报时该路由必然 404，
        // 暴露它会把「该版本没有海报」误报成「预览加载失败」并要求无意义的重试。
        posterHref: entry.previewable && payload.poster ? href("poster") : null,
        durationSeconds: payload.durationSeconds ?? null
      };
    }
    case "audio":
      return {
        kind: "audio",
        href: href("preview"),
        durationSeconds: (entry.payload as NodeHistoryMediaPayload).durationSeconds ?? null
      };
    case "model":
      return {
        kind: "model",
        thumbnailHref: entry.previewable ? href("thumbnail") : null,
        entry: { canvasId: entry.canvasId, nodeId: entry.nodeId, entryId: entry.entryId }
      };
  }
}

/** 派生完整详情（供受保护详情接口使用）。 */
export function toNodeHistoryDetail(entry: NodeGenerationHistoryEntry): NodeGenerationHistoryDetail {
  if (entry.payload.kind === "failure") {
    const payload = entry.payload;
    return {
      entryId: entry.entryId,
      kind: "failure",
      outcome: payload.outcome,
      failureKind: payload.failureKind,
      message: payload.message,
      ...(payload.code ? { code: payload.code } : {}),
      inputSummary: payload.inputSummary,
      baseline: payload.baseline
    };
  }
  switch (entry.kind) {
    case "text":
      return { entryId: entry.entryId, kind: "text", text: (entry.payload as NodeHistoryTextPayload).text };
    case "model": {
      const payload = entry.payload as NodeHistoryModelPayload;
      return {
        entryId: entry.entryId,
        kind: "model",
        modelScript: payload.modelScript,
        language: payload.language,
        version: payload.version,
        sourceHash: payload.sourceHash,
        ...(payload.placement ? { placement: payload.placement } : {}),
        ...(payload.modelCameras ? { modelCameras: payload.modelCameras } : {}),
      };
    }
    default: {
      const payload = entry.payload as NodeHistoryMediaPayload;
      return {
        entryId: entry.entryId,
        kind: payload.kind,
        storageKey: payload.storageKey,
        checksum: payload.checksum,
        contentType: payload.contentType,
        size: payload.size,
        ...(payload.durationSeconds !== undefined ? { durationSeconds: payload.durationSeconds } : {}),
        ...(payload.poster ? { poster: payload.poster } : {}),
        ...(payload.base ? { base: payload.base } : {}),
        ...(payload.imageEdit ? { imageEdit: payload.imageEdit } : {}),
        ...(payload.project ? { project: payload.project } : {})
      };
    }
  }
}

function truncate(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
