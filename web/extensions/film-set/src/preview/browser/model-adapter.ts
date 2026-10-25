import { filmSetMediaSources } from "./media-sources.js";
import { createFilmSetObjectResolver, decodeFilmSetNodeData, resolveFilmSetObject, filmSetObjectOwnershipOf, shotPreviewOwnershipOf, isFilmSetNode, DEFAULT_FILM_SET_LOCAL_TRANSFORM, type ServerCanvas, type CanvasNodeData } from "@woohaa3/contracts";
import type { CompositeAssetAdapter, CompositeChildPresentation } from "@woohaa3/frontend/extension-api";
import { buildFilmSetComposition } from "../shared/composition.js";
import { HistoryFilmSetSnapshots } from "./history-preview.js";
import { FILM_SET_EXTENSION_ID } from "../../state/shared/identity.js";

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
export function createFilmSetModelAdapter(history = new HistoryFilmSetSnapshots(), canvas: () => ServerCanvas | null = () => null, feedback: (nodeId: string) => string | undefined = () => undefined): CompositeAssetAdapter {
  const object = (id: string) => { const current = canvas(); return current ? resolveFilmSetObject(current, id) : null; };
  return {
    extensionId: FILM_SET_EXTENSION_ID, owner: FILM_SET_EXTENSION_ID,
    children(current, ownerNodeId) {
      const owner = current.document.nodes.find(node => node.id === ownerNodeId);
      if (!isFilmSetNode(owner?.type, current.nodeData[ownerNodeId])) return [];
      const children: CompositeChildPresentation[] = [];
      const resolve = createFilmSetObjectResolver(current);
      for (const node of current.document.nodes) {
        const target = resolve(node.id);
        if (target?.owner.filmSetNodeId === ownerNodeId) children.push({ nodeId: node.id, ownerNodeId, kind: "container", focusOwner: true,
          panel: { title: target.item.name, message: target.item.kind === "model" ? "3D 模型" : target.item.kind === "image" ? "图片对象" : target.item.kind === "video" ? "视频对象" : "",
            hint: feedback(node.id) ?? "拖入一个 3D 模型以替换 · 复制快照" } });
        else if (shotPreviewOwnershipOf(current.nodeData[node.id])?.filmSetNodeId === ownerNodeId) children.push({ nodeId: node.id, ownerNodeId, kind: "entity" });
      }
      return children;
    },
    // 总览 primitive LOD：片场按世界投影尺寸选择整场图元细分。声明只承载呈现策略，不进入
    // executionKey/内容 hash 或持久 DTO；普通卡片、炉体、第三方缺省不声明即保持 High
    // （change: 2026-10-15-add-film-set-overview-lod，design D1）。
    geometryQuality: "overview-primitives-v1",
    scopeShapeForNode: (_id, data) => filmSetObjectOwnershipOf(data) ? "rect" : undefined,
    executionKey: (data, id) => {
      if (!filmSetObjectOwnershipOf(data)) return filmSetExecutionKey(data);
      const target = id ? object(id) : null;
      return JSON.stringify([data.filmSetObject, target?.item]);
    },
    mediaSources: (id, data, playback) => filmSetObjectOwnershipOf(data) ? [] : filmSetMediaSources(id, data, playback),
    projectCanvas: canvas => history.project(canvas)!,
    history: (nodeId, detail) => { if (!detail) { history.clear(nodeId); return true; } return history.set(nodeId, detail); },
    historyProjection: nodeId => { const record = history.get(nodeId); return record ? { resource: record.composition.resource, composition: record.composition } : null; },
    prepare(nodeId, data) {
      if (filmSetObjectOwnershipOf(data)) {
        const target = object(nodeId);
        if (!target) return null;
        const animation = { ...target.animation, scenePlacement: DEFAULT_FILM_SET_LOCAL_TRANSFORM,
          filmSetContent: { ...target.animation.filmSetContent, items: [{ ...target.item, localTransform: DEFAULT_FILM_SET_LOCAL_TRANSFORM }] } };
        const result = buildFilmSetComposition({ nodeId, animation });
        return { resource: result.resource, composition: { itemRoots: result.itemRoots, failures: result.failures } };
      }
      const decoded = decodeFilmSetNodeData(data);
      if (!decoded.ok) return null;
      const result = buildFilmSetComposition({ nodeId, animation: decoded.value });
      return { resource: result.resource, composition: { itemRoots: result.itemRoots, failures: result.failures },
        ...(result.failures.length ? { diagnostic: result.failures.map(entry => `${entry.itemId}=${entry.diagnostic}`).join(",") } : {}) };
    }
  };
}
