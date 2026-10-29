import { activeFilmSetSceneBindings, readFilmSetGroupMarker, shotPreviewOwnershipOf, type ServerCanvas } from "@woohaa3/contracts";
import type { FilmSetHostContext } from "./host-ports.js";

type Snapshot = { canvas: ServerCanvas; ids: Set<string> };
const captures = new WeakMap<object, Snapshot>();

/** Presentation-only overlay. Canonical updates continue while a capture reads its fixed resources. */
export function projectFilmSetCapture(owner: object, canvas: ServerCanvas): ServerCanvas {
  const capture = captures.get(owner);
  if (!capture || capture.canvas.id !== canvas.id) return canvas;
  const nodeData = { ...canvas.nodeData };
  for (const id of capture.ids) { const data = capture.canvas.nodeData[id]; if (data) nodeData[id] = data; else delete nodeData[id]; }
  const frozenAssets = new Map(capture.canvas.assets.map(asset => [asset.id, asset]));
  return { ...canvas, nodeData,
    document: { ...canvas.document, nodes: [
      ...canvas.document.nodes.filter(node => !capture.ids.has(node.id)),
      ...capture.canvas.document.nodes.filter(node => capture.ids.has(node.id))
    ] },
    assets: [...canvas.assets.filter(asset => !frozenAssets.has(asset.id)), ...frozenAssets.values()]
  };
}

/** Call only after acquiring the shared capture lock; release on every exit path. */
export function pinFilmSetCapture(ctx: FilmSetHostContext, nodeId: string, source?: ServerCanvas | null): () => void {
  const owner = ctx.compositeAssets;
  const current = source ?? ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  if (!current) throw new Error("片场画布已关闭");
  const projected = owner.projectCanvas(current)!;
  const marker = readFilmSetGroupMarker(projected.nodeData[nodeId]);
  if (!marker) throw new Error("片场分组不存在");
  if (captures.has(owner)) throw new Error("已有片场捕捉正在进行");
  const ids = new Set([nodeId, ...activeFilmSetSceneBindings(marker).map(binding => binding.sourceNodeId)]);
  for (const node of projected.document.nodes) {
    if (shotPreviewOwnershipOf(projected.nodeData[node.id])?.filmSetNodeId === nodeId) ids.add(node.id);
  }
  const snapshot = { canvas: structuredClone(projected), ids };
  captures.set(owner, snapshot);
  owner.invalidate();
  return () => {
    if (captures.get(owner) !== snapshot) return;
    captures.delete(owner);
    owner.invalidate();
  };
}
