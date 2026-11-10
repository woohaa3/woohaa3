import { canvasPointToGround, decodeSceneAreaData, decodeWorldCamera, decodeWorldInstanceData, v2SceneAabb, worldToCanvasPoint, worldToRendererPosition, type GroundAabb, type GroundPoint, type ServerCanvas } from "@woohaa3/contracts";
import { executeSceneIr } from "../model-mcp/script-executor.js";
import { instanceFootprint } from "./authority.js";

export type ImageDirectorPlacement = { delta: GroundPoint; bounds: GroundAabb };
export type PreparedImageDirectorCandidate = { footprints: GroundAabb[]; camera: { position: { u: number; v: number } } };

function projectedBounds(bounds: GroundAabb) {
  const points = [bounds.min.u, bounds.max.u].flatMap(u => [bounds.min.v, bounds.max.v].map(v => worldToCanvasPoint([...worldToRendererPosition({ u, v, h: 0 })])));
  return { x: (Math.min(...points.map(point => point.x)) + Math.max(...points.map(point => point.x))) / 2, top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y)) };
}

/** Preserve the visible top-center anchor as the generating area expands. */
export function imageDirectorPlacementAnchor(bounds: GroundAabb): GroundPoint {
  const projected = projectedBounds(bounds);
  return canvasPointToGround({ x: projected.x, y: projected.top });
}

export async function imageDirectorOccupancy(canvas: ServerCanvas, signal?: AbortSignal, excludeNodeId?: string): Promise<(GroundAabb | null)[]> {
  const occupied: (GroundAabb | null)[] = [];
  for (const node of canvas.document.nodes) {
    if (node.id === excludeNodeId) continue;
    const data = canvas.nodeData[node.id];
    if (!data) { if (node.type === "scene-area" || node.type === "world-camera") occupied.push(null); continue; }
    if (node.type === "scene-area" && data.sceneArea === undefined) occupied.push(null);
    if (node.type === "world-camera" && data.worldCamera === undefined) occupied.push(null);
    if (data.sceneArea !== undefined) {
      const area = decodeSceneAreaData(data.sceneArea);
      occupied.push(area.ok ? area.value.bounds : null);
    }
    if (data.worldCamera !== undefined) {
      const camera = decodeWorldCamera(data.worldCamera);
      occupied.push(camera.ok ? { min: { u: camera.value.position.u, v: camera.value.position.v }, max: { u: camera.value.position.u, v: camera.value.position.v } } : null);
    }
    if (data.sharedWorldInstance !== undefined) {
      const instance = decodeWorldInstanceData(data.sharedWorldInstance);
      if (!instance.ok || data.modelSourceKind === "glb" || typeof data.modelScript !== "string") { occupied.push(null); continue; }
      try {
        const execution = await executeSceneIr(data.modelScript, data.modelScriptVersion, { signal });
        const bounds = execution.ok ? v2SceneAabb(execution.ops) : null;
        occupied.push(bounds ? instanceFootprint(bounds, instance.value.transform) : null);
      } catch { occupied.push(null); }
    }
  }
  return occupied;
}

/** Unknown existing footprints fail closed. All supplied bounds are in world meters. */
export function planImageDirectorPlacement(prepared: PreparedImageDirectorCandidate, occupied: readonly (GroundAabb | null)[], origin: GroundPoint, alignment: "min" | "below-image" = "min"): ImageDirectorPlacement | null {
  const valid = (b: GroundAabb) => [b.min.u, b.min.v, b.max.u, b.max.v].every(Number.isFinite) && b.min.u <= b.max.u && b.min.v <= b.max.v;
  if (!Number.isFinite(origin.u) || !Number.isFinite(origin.v) || !prepared.footprints.length || prepared.footprints.some(b => !valid(b)) || occupied.some(b => !b || !valid(b))) return null;
  const camera = prepared.camera.position;
  const all = [...prepared.footprints, { min: { u: camera.u, v: camera.v }, max: { u: camera.u, v: camera.v } }];
  const padding = 0.5;
  const base = {
    min: { u: Math.min(...all.map(b => b.min.u)) - padding, v: Math.min(...all.map(b => b.min.v)) - padding },
    max: { u: Math.max(...all.map(b => b.max.u)) + padding, v: Math.max(...all.map(b => b.max.v)) + padding }
  };
  const step = Math.max(base.max.u - base.min.u, base.max.v - base.min.v, 1) + 1;
  const overlaps = (a: GroundAabb, b: GroundAabb) => a.min.u <= b.max.u && a.max.u >= b.min.u && a.min.v <= b.max.v && a.max.v >= b.min.v;
  if (alignment === "below-image") {
    const anchor = imageDirectorPlacementAnchor(base);
    const target = worldToCanvasPoint([...worldToRendererPosition({ ...origin, h: 0 })]);
    let top = target.y;
    for (let i = 0; i <= occupied.length; i++) {
      const ground = canvasPointToGround({ x: target.x, y: top });
      const delta = { u: ground.u - anchor.u, v: ground.v - anchor.v };
      const bounds = { min: { u: base.min.u + delta.u, v: base.min.v + delta.v }, max: { u: base.max.u + delta.u, v: base.max.v + delta.v } };
      const conflicts = occupied.filter((box): box is GroundAabb => !!box && overlaps(bounds, box));
      if (!conflicts.length) return { delta, bounds };
      top = Math.max(top, ...conflicts.map(box => projectedBounds(box).bottom)) + 32;
    }
    return null;
  }
  // The finite set of known obstacles permits a bounded deterministic search to the right.
  for (let i = 0; i <= occupied.length; i++) {
    const delta = { u: origin.u - base.min.u + i * step, v: origin.v - base.min.v };
    const bounds = { min: { u: base.min.u + delta.u, v: base.min.v + delta.v }, max: { u: base.max.u + delta.u, v: base.max.v + delta.v } };
    if (!occupied.some(b => b && overlaps(bounds, b))) return { delta, bounds };
  }
  return null;
}
