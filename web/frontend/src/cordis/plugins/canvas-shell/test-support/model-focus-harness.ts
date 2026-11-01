/**
 * 模型聚焦测试共享 harness
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 interaction-controller.test.ts 拆出）。
 *
 * 由 `interaction-model-focus-edit.test.ts` 与 `interaction-model-focus-camera.test.ts` 共用，
 * 断言与原文件一致。
 */
import {
  createEmptyWoohaa3ServerCanvas,
  canvasCameraRotation,
  focusGizmoGeometry,
  hitFocusGizmo,
  hitModelGizmo,
  hitShotGizmo,
  makeFocusProjector,
  makeShotProjector,
  modelGizmoGeometry,
  quatRotate,
  screenPointFromWorld,
  screenPointToWorld,
  MODEL_CAMERA_Z,
  MODEL_CAMERA_FAR,
  MODEL_FOCUS_FOV,
  type ModelFocusProjection,
  type SceneV2Op,
  type ServerCanvas
} from "@woohaa3/contracts";
import { installInteractionController } from "../interaction-controller.js";
import { modelBounds, type FocusTargetInput } from "../model-focus-session.js";
import { woohaa3CanvasStore } from "../../../services/canvas-state/index.js";
import { getSession, harness, runtimeCapturing } from "./controller-harness.js";

/** 聚焦相机参数（由投影重建；测试 oracle 用）。 */
function focusCamera(projection: { target: [number, number, number]; yaw: number; pitch: number; distance: number }) {
  return { target: projection.target, yaw: projection.yaw, pitch: projection.pitch, distance: projection.distance, flySpeed: 6 };
}

export const V2 = "woohaa-model-scene-ir-v2";

export function unitBox(): SceneV2Op {
  return {
    t: "box",
    id: "b",
    parent: null,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: null,
    color: "#ffffff",
    size: [1, 1, 1]
  } as SceneV2Op;
}

/** 单个 3D 模型节点位于 (200,100)。 */
export function modelCanvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: "m1", type: "model3d", position: { x: 200, y: 100 }, width: 196, height: 64 }]
    },
    nodeData: { m1: { modelScript: "", modelScriptVersion: "woohaa-model-js-v2" } } as never
  } as ServerCanvas;
}

export function targetFor(canvas: ServerCanvas): FocusTargetInput {
  return {
    canvas,
    nodeId: "m1",
    viewport: { x: 0, y: 0, zoom: 1 },
    surface: { width: 1000, height: 800 },
    sceneVersion: V2,
    ops: [unitBox()],
    extent: 2,
    placement: null
  };
}

/** 模型 AABB 中心的 canvas CSS 坐标（与命中测试同空间）。 */
export function modelCenter(target: FocusTargetInput): { x: number; y: number } {
  const center = modelBounds(target)!.center;
  return screenPointFromWorld(center, target.viewport);
}

/** 测试用模型 picking oracle：用固定相机快照的 ray/AABB 命中（与 Rust picking 同语义）。 */
export function modelPickForTargets(
  targets: readonly FocusTargetInput[],
  canvas: ServerCanvas
) {
  return (input: { x: number; y: number; width: number; height: number }) => {
    let best: { nodeId: string; target: [number, number, number]; radius: number; t: number } | null = null;
    for (const candidate of targets) {
      if (candidate.canvas !== canvas) continue;
      const bounds = modelBounds(candidate);
      if (!bounds) continue;
      // 等距倾斜正交相机：指针点从实际 near 平面反投影，方向 = 相机朝向，far 范围裁剪
      // （change: make-shot-framing-zoom-invariant，design D5）。
      const viewport = candidate.viewport;
      const near = -MODEL_CAMERA_FAR;
      const origin = screenPointToWorld(
        { x: input.x, y: input.y },
        MODEL_CAMERA_Z - near,
        viewport
      );
      const direction = quatRotate(canvasCameraRotation(), [0, 0, -1]);
      const t = rayHitsAabb(origin, direction, bounds.aabb.min, bounds.aabb.max, MODEL_CAMERA_FAR - near);
      if (t === null) continue;
      if (best && t >= best.t) continue;
      best = { nodeId: candidate.nodeId, target: bounds.center as [number, number, number], radius: bounds.radius, t };
    }
    if (!best) return null;
    return { nodeId: best.nodeId, target: best.target, radius: best.radius };
  };
}

function rayHitsAabb(
  origin: [number, number, number],
  direction: [number, number, number],
  min: [number, number, number],
  max: [number, number, number],
  maxT = Number.POSITIVE_INFINITY
): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const o = origin[axis];
    const d = direction[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min[axis] - o) * inv;
    let t2 = (max[axis] - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = Math.max(0, tmin);
  return t <= maxT ? t : null;
}

/** 测试用 gizmo 命中 oracle：用 contracts 投影/几何复现（生产由 Rust 计算）。 */
export function gizmoHitOracle(input: {
  kind: "model" | "object" | "shot" | "focus";
  editor: import("@woohaa3/contracts").BevyModelEditor | null;
  projection: { target: [number, number, number]; yaw: number; pitch: number; distance: number } | null;
  surface: { width: number; height: number };
  point: { x: number; y: number };
}): import("../../canvas-runtime/bevy-runtime.js").GizmoHitResult {
  const editor = input.editor;
  const unavailable: import("../../canvas-runtime/bevy-runtime.js").GizmoHitResult = {
    available: false,
    reason: "unavailable",
    handle: null
  };
  if (!editor) return unavailable;
  if (input.kind === "model") {
    if (!input.projection) return unavailable;
    const camera = focusCamera(input.projection);
    const project = makeFocusProjector({ camera, surface: input.surface, fov: MODEL_FOCUS_FOV });
    const geometry = modelGizmoGeometry({ focus: editor.focus, radius: editor.radius });
    const hit = hitModelGizmo({ pointer: input.point, geometry, project });
    return { available: true, handle: hit?.handle ?? null };
  }
  if (!editor.shot) return unavailable;
  if (input.kind === "focus") {
    if (!input.projection) return unavailable;
    const camera = focusCamera(input.projection);
    const project = makeFocusProjector({ camera, surface: input.surface, fov: MODEL_FOCUS_FOV });
    const geometry = focusGizmoGeometry({ focus: editor.shot.focus, radius: editor.radius });
    // 注视点中心优先：与 Rust/主画面一致（10px 抓取半径，无轴约束）。
    const center = project(geometry.origin);
    if (center && Math.hypot(input.point.x - center.x, input.point.y - center.y) <= 10) {
      return { available: true, handle: "center", constraint: null };
    }
    const hit = hitFocusGizmo({ pointer: input.point, geometry, project });
    let constraint: import("../../canvas-runtime/bevy-runtime.js").AxisDragConstraint | null = null;
    if (hit) {
      const origin = project(geometry.origin);
      const endpoint = hit.axis === "x" ? geometry.x : hit.axis === "y" ? geometry.y : geometry.z;
      const tip = project(endpoint);
      if (origin && tip) {
        const sx = tip.x - origin.x;
        const sy = tip.y - origin.y;
        const screenLength = Math.hypot(sx, sy) || 1;
        constraint = { axis: hit.axis, direction: [sx / screenLength, sy / screenLength], worldPerPixel: geometry.axisLength / screenLength };
      }
    }
    return { available: true, handle: hit?.axis ?? null, constraint };
  }
  const geometry = {
    focus: editor.shot.focus,
    cameraPosition: editor.shot.position,
    ringRadius: editor.radius > 1e-3 ? editor.radius * 1.15 : 1
  };
  // 主观察相机透视投影（与 Rust 一致）；无投影时回退镜头正交投影。
  const project = input.projection
    ? makeFocusProjector({ camera: focusCamera(input.projection), surface: input.surface, fov: MODEL_FOCUS_FOV })
    : makeShotProjector({
        focus: editor.shot.focus,
        cameraPosition: editor.shot.position,
        fov: editor.shot.fov,
        surface: input.surface
      });
  const hit = hitShotGizmo({ pointer: input.point, geometry, project });
  return {
    available: true,
    handle: hit
      ? hit.handle === "orbit-ring" || hit.handle === "elevation-ring"
        ? hit.handle
        : "distance"
      : null
  };
}

export function focusHarness(options: {
  targets?: () => FocusTargetInput[];
  canvas?: ServerCanvas;
  onContextMenu?: () => void;
  getModelEditor?: () => import("@woohaa3/contracts").BevyModelEditor | null;
  shotGesture?: import("../interaction-controller.js").InteractionControllerOptions["shotGesture"];
  shotWheel?: import("../interaction-controller.js").InteractionControllerOptions["shotWheel"];
  focusGesture?: import("../interaction-controller.js").InteractionControllerOptions["focusGesture"];
  onModelFocusInvalid?: (reason: string) => void;
  onModelFocusIntent?: import("../interaction-controller.js").InteractionControllerOptions["onModelFocusIntent"];
  isModalActive?: () => boolean;
  isFocusInputBlocked?: () => boolean;
  getModelFocusMode?: () => "edit" | "history";
} = {}) {
  const canvas = options.canvas ?? modelCanvas();
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas as never);
  const dom = harness();
  const targets = options.targets?.() ?? [targetFor(canvas)];
  const { runtime } = runtimeCapturing({
    modelPick: modelPickForTargets(targets, canvas),
    gizmoHit: gizmoHitOracle
  });
  const projections: Array<ModelFocusProjection | null> = [];
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never,
    getModelFocusTargets: options.targets ?? (() => [targetFor(canvas)]),
    getModelFocus: () => controller.focusProjection(),
    onModelFocusChange: (projection) => projections.push(projection),
    onContextMenu: () => options.onContextMenu?.(),
    ...(options.getModelEditor ? { getModelEditor: options.getModelEditor } : {}),
    ...(options.shotGesture ? { shotGesture: options.shotGesture } : {}),
    ...(options.shotWheel ? { shotWheel: options.shotWheel } : {}),
    ...(options.focusGesture ? { focusGesture: options.focusGesture } : {}),
    ...(options.onModelFocusInvalid ? { onModelFocusInvalid: options.onModelFocusInvalid } : {}),
    ...(options.onModelFocusIntent ? { onModelFocusIntent: options.onModelFocusIntent } : {}),
    ...(options.isModalActive ? { isModalActive: options.isModalActive } : {}),
    ...(options.isFocusInputBlocked ? { isFocusInputBlocked: options.isFocusInputBlocked } : {}),
    ...(options.getModelFocusMode ? { getModelFocusMode: options.getModelFocusMode } : {})
  });
  return { dom, controller, projections, canvas, target: targetFor(canvas) };
}
