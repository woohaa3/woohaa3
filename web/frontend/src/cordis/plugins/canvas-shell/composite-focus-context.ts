/** Lightweight workspace references; canonical canvas cards are never changed. */
import type { CanvasRenderScene, ServerCanvas } from "@woohaa3/contracts";
import type { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";

export const CLOSE_FOCUS_REFERENCE_ACTION = "composite.close-reference";

export function compositeFocusContextIds(canvas: ServerCanvas | null, registry: CompositeAssetRegistry | undefined, ownerId: string | null): Set<string> {
  if (!canvas || !registry || !ownerId) return new Set();
  return new Set([...registry.children(canvas).values()].filter(child => child.ownerNodeId === ownerId).map(child => child.nodeId));
}

export function projectCompositeFocusContext(scene: CanvasRenderScene, canvas: ServerCanvas, registry?: CompositeAssetRegistry, writable = false): void {
  delete scene.modelFocusContext;
  if (!scene.modelFocus || !scene.surface) return;
  const ids = compositeFocusContextIds(canvas, registry, scene.modelFocus.nodeId);
  if (!ids.size) return;
  const children = registry!.children(canvas);
  const rect = scene.surface.contentRect ?? { x: 0, y: 0, width: scene.surface.width - (scene.surface.contentRight ?? 0), height: scene.surface.height };
  const inset = 20, gap = 8, height = 36;
  const available = Math.max(1, rect.width - inset * 2);
  // Keep labels legible: wrap whole tags rather than scaling down card previews.
  const columns = Math.max(1, Math.floor((available + gap) / (168 + gap)));
  const width = Math.min(184, (available - gap * (columns - 1)) / columns);
  const ordered = [...children.values()].filter(child => ids.has(child.nodeId)).sort((a, b) => Number(a.kind === "entity") - Number(b.kind === "entity"));
  const nodeIds = new Set(scene.nodes.map(node => node.id));
  scene.modelFocusContext = ordered.filter(child => nodeIds.has(child.nodeId)).map((child, index) => {
    if (child.closable === true && registry!.resolve(canvas, child.ownerNodeId)?.closeChild) {
      scene.nodeActions ??= {};
      scene.nodeActions[child.nodeId] = { actions: [{ id: CLOSE_FOCUS_REFERENCE_ACTION, label: "关闭容器", enabled: writable }] };
    }
    return { nodeId: child.nodeId, x: rect.x + inset + (index % columns) * (width + gap), y: rect.y + inset + Math.floor(index / columns) * (height + gap), width, height };
  });
}
