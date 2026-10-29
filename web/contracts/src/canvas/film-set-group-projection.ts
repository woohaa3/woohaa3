import { decodeModelDefinition } from "./model-definition.js";
import { readFilmSetGroupMarker } from "./film-set-group.js";
import { decodeFilmSetContent, emptyFilmSetContent, type FilmSetContent, type FilmSetItem } from "./film-set-content.js";
import type { StoredAsset, CanvasNodeData } from "./domain/index.js";
export type FilmSetProjectionCanvas = { document: { nodes: readonly { id: string; type: string }[] }; nodeData: Record<string, unknown>; assets?: readonly StoredAsset[] };

export function readFilmSetContentForSession(canvas: FilmSetProjectionCanvas | null, nodeId: string): FilmSetContent {
  if (!canvas) return emptyFilmSetContent();
  const marker = readFilmSetGroupMarker(canvas.nodeData[nodeId]);
  if (marker && canvas.document.nodes.some(node => node.id === nodeId && node.type === "group")) {
    // Read-only session projection. The source card remains the content owner;
    // edits are translated back to sceneBindings by the feature submitter.
    const items: FilmSetItem[] = [];
    for (const binding of marker.sceneBindings) {
      const source = canvas.document.nodes.find(node => node.id === binding.sourceNodeId);
      const raw = canvas.nodeData[binding.sourceNodeId];
      const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as CanvasNodeData : undefined;
      if (!source || source.type !== binding.kind || !data) continue;
      const t = binding.transform;
      const base = { id: binding.bindingId, name: binding.name ?? (typeof data.title === "string" ? data.title : binding.bindingId), localTransform: { offset: { x: t.x, y: t.y, z: t.z }, yaw: t.yaw, scale: t.scale }, ...(binding.animation ? binding.animation : {}) };
      if (binding.kind === "model3d") {
        const model = decodeModelDefinition(data);
        if (model.ok) items.push({ ...base, kind: "model", model: model.value });
      } else {
        const assetId = typeof data.outputAssetId === "string" ? data.outputAssetId : data.mediaContent?.payload?.assetId;
        const asset = canvas.assets?.find(asset => asset.id === assetId);
        const width = asset?.metadata?.width, height = asset?.metadata?.height;
        const aspectRatio = typeof width === "number" && Number.isFinite(width) && width > 0 && typeof height === "number" && Number.isFinite(height) && height > 0 ? width / height : 1;
        if (typeof assetId === "string") items.push({ ...base, kind: binding.kind, assetId, aspectRatio });
      }
    }
    if (marker.ground) items.push({ id: "film-set-ground", kind: "ground", name: "地面", size: { width: marker.ground.width, depth: marker.ground.depth }, color: marker.ground.color ?? "#808080", localTransform: marker.ground.transform ? { offset: { x: marker.ground.transform.x, y: marker.ground.transform.y, z: marker.ground.transform.z }, scale: marker.ground.transform.scale, yaw: marker.ground.transform.yaw } : { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } });
    return { ...emptyFilmSetContent(), items };
  }
  const decoded = decodeFilmSetContent((canvas.nodeData[nodeId] as CanvasNodeData | undefined)?.["filmSetContent"]);
  return decoded.ok ? decoded.value : emptyFilmSetContent();
}

