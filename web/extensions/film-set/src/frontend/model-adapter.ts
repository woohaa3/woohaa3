import { filmSetMediaSources } from "./media-sources.js";
import { decodeFilmSetNodeData, type CanvasNodeData } from "@woohaa3/contracts";
import type { CompositeAssetAdapter } from "@woohaa3/frontend/extension-api";
import { buildFilmSetComposition } from "../shared/composition.js";
import { HistoryFilmSetSnapshots } from "./history-preview.js";
import { FILM_SET_EXTENSION_ID } from "../shared.js";

/** Geometry identity excludes local transforms and animation clocks, which use frame projections. */
export function filmSetExecutionKey(data: CanvasNodeData): string {
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok) return "film-set:invalid";
  return JSON.stringify([decoded.value.scenePlacement, decoded.value.filmSetContent.items.map(item => {
    switch (item.kind) {
      case "model": return [item.id, item.kind, item.model.contentVersion.contentHash, item.model.placement];
      case "ground": return [item.id, item.kind, item.size, item.color];
      default: return [item.id, item.kind, item.assetId, item.aspectRatio];
    }
  })]);
}
export function createFilmSetModelAdapter(history = new HistoryFilmSetSnapshots()): CompositeAssetAdapter {
  return {
    extensionId: FILM_SET_EXTENSION_ID, owner: FILM_SET_EXTENSION_ID,
    // 总览 primitive LOD：片场按世界投影尺寸选择整场图元细分。声明只承载呈现策略，不进入
    // executionKey/内容 hash 或持久 DTO；普通卡片、炉体、第三方缺省不声明即保持 High
    // （change: 2026-10-15-add-film-set-overview-lod，design D1）。
    geometryQuality: "overview-primitives-v1",
    executionKey: filmSetExecutionKey, mediaSources: filmSetMediaSources,
    projectCanvas: canvas => history.project(canvas)!,
    history: (nodeId, detail) => { if (!detail) { history.clear(nodeId); return true; } return history.set(nodeId, detail); },
    historyProjection: nodeId => { const record = history.get(nodeId); return record ? { resource: record.composition.resource, composition: record.composition } : null; },
    prepare(nodeId, data) {
      const decoded = decodeFilmSetNodeData(data);
      if (!decoded.ok) return null;
      const result = buildFilmSetComposition({ nodeId, animation: decoded.value });
      return { resource: result.resource, composition: { itemRoots: result.itemRoots, failures: result.failures },
        ...(result.failures.length ? { diagnostic: result.failures.map(entry => `${entry.itemId}=${entry.diagnostic}`).join(",") } : {}) };
    }
  };
}
