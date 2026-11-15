import type { CanvasNodeData, ServerCanvas } from "./domain/index.js";
import { decodeSceneAreaData, decodeWorkflowGroupData } from "./creation-scope-codec.js";
import { decodeWorldCamera } from "./world-camera-codec.js";
import { decodeWorldInstanceData } from "./shared-world-codec.js";

export type CanvasScopeMode = "edit" | "locked" | "hidden";
export type CanvasEditScope = { "2d": CanvasScopeMode; "3d": CanvasScopeMode };
export type CanvasEditScopeCategory = "2d" | "3d";

export const DEFAULT_CANVAS_EDIT_SCOPE: CanvasEditScope = Object.freeze({ "2d": "edit", "3d": "edit" });

export function canvasEditScopeCategoryOf(
  node: Pick<ServerCanvas["document"]["nodes"][number], "type">,
  data: CanvasNodeData | undefined
): CanvasEditScopeCategory {
  // A camera has two presentations: its 3D world gizmo and its ordinary 2D
  // camera card. Keep the card in the 2D scope so hiding 3D does not remove
  // the camera node from the canvas.
  if (decodeWorldCamera(data?.worldCamera).ok) return "2d";
  if (decodeWorldInstanceData(data?.sharedWorldInstance).ok
    || decodeSceneAreaData(data?.sceneArea).ok) return "3d";
  if (node.type === "workflow-group-2d" && decodeWorkflowGroupData(data?.workflowGroup2d).ok) return "2d";
  return "2d";
}

export function canvasEditScopeModeOf(scope: CanvasEditScope | undefined, category: CanvasEditScopeCategory): CanvasScopeMode {
  return scope?.[category] ?? "edit";
}

export function canvasEditScopeHidden(scope: CanvasEditScope | undefined, category: CanvasEditScopeCategory): boolean {
  return canvasEditScopeModeOf(scope, category) === "hidden";
}

export function canvasEditScopeLocked(scope: CanvasEditScope | undefined, category: CanvasEditScopeCategory): boolean {
  return canvasEditScopeModeOf(scope, category) === "locked";
}

export function normalizeCanvasEditScope(value: unknown): CanvasEditScope {
  if (!value || typeof value !== "object") return { ...DEFAULT_CANVAS_EDIT_SCOPE };
  const candidate = value as Record<string, unknown>;
  const mode = (key: "2d" | "3d"): CanvasScopeMode => candidate[key] === "locked" || candidate[key] === "hidden" ? candidate[key] as CanvasScopeMode : "edit";
  return { "2d": mode("2d"), "3d": mode("3d") };
}
