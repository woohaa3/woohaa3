/**
 * 片场对象模式手势适配
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 4.2/4.3 / design D5）。
 *
 * 把 `FilmSetObjectSession` 接到共享聚焦输入：
 * - 单击：经 Rust `query_composite_asset_item_pick`（同帧组合几何 + **聚焦透视相机** + 可见深度）
 *   命中稳定 itemId；
 * - 命中选中对象处的**三轴位移 gizmo**：沿屏幕轴约束平移该对象（与主画面 focus 轴向拖动同源）；
 * - 命中 gizmo 中心：在相机朝向平面上自由平移；
 * - Shift 拖动对象本体：绕对象局部 Y 旋转；
 * - 结束时提交**一次** itemId 定位的 `filmSet.itemPatch`；取消恢复确认值。
 *
 * 只持浏览器本地 preview；canonical 写入由注入的 `submitItemOp` 完成。
 */
import { focusPointerRay, rayPlanePoint, worldDeltaToFilmSetItemOffset, type ModelFocusCamera, type Vec3 } from "@woohaa3/contracts";
import type { InteractionController, InteractionControllerOptions } from "@woohaa3/frontend/extension-api";
import { FilmSetObjectSession } from "./object-session.js";

export type FilmSetObjectGestureDeps = {
  session: FilmSetObjectSession;
  /** 读取当前聚焦投影（相机 pose + 目标点）。 */
  projection: () => ModelFocusCamera | null;
  surface: () => { width: number; height: number };
  /** 从 Rust 同帧世界几何读取根缩放、旋转和对象中心。 */
  compositionBasis: () => { unit: number; yaw: number; worldToLocal?: number[]; center: Vec3 } | null;
  /** 命中查询：返回 `nodeId` 下最近 itemId；无命中为 null。 */
  pick: (point: { x: number; y: number }) => string | null;
  /** gizmo 三轴/中心命中（与主画面同一投影）；无则 null。 */
  hitObjectGizmo: (
    point: { x: number; y: number }
  ) => { handle: "x" | "y" | "z" | "center"; direction?: [number, number]; worldPerPixel?: number } | null;
  /** 聚焦的片场 nodeId。 */
  nodeId: () => string | null;
  /** 是否有活动 modal/只读，阻断编辑。 */
  blocked: () => boolean;
};

export type FilmSetObjectGesture = NonNullable<InteractionControllerOptions["filmSetObjectGesture"]> & {
  /** 本实现始终提供：Escape 分层手势取消（不提交半成品）。 */
  cancelIfDragging(): boolean;
  dispose(): void;
};

/** 一次对象拖动的起始冻结态。 */
type ObjectDrag = {
  kind: "axis" | "plane" | "yaw";
  axis: "x" | "y" | "z" | null;
  itemId: string;
  startX: number;
  startY: number;
  originOffset: { x: number; y: number; z: number };
  originScale: number;
  originYaw: number;
  direction?: [number, number];
  worldPerPixel?: number;
  planeOrigin: Vec3;
  planeNormal: Vec3;
  initialHit?: Vec3;
  camera?: ModelFocusCamera;
  surface?: { width: number; height: number };
  basis?: { unit: number; yaw: number; worldToLocal?: number[] };
  nodeId?: string | null;
};

/**
 * 创建对象模式手势。调用方须在进入对象模式时 `install` 到 controller。
 */
export function createFilmSetObjectGesture(deps: FilmSetObjectGestureDeps): {
  handler: FilmSetObjectGesture;
  install(controller: InteractionController | null): void;
} {
  let drag: ObjectDrag | null = null;

  const begin = (point: { x: number; y: number }, isShift: boolean): boolean => {
    if (deps.blocked()) return false;
    const item = deps.session.selectedItem();
    const projection = deps.projection();
    if (!item || !projection) return false;
    const planeNormal = focusForward(projection);
    const basis = deps.compositionBasis();
    if (!basis) return false;
    const planeOrigin: Vec3 = [...basis.center];
    const camera = { ...projection, target: [...projection.target] as Vec3 };
    const surface = { ...deps.surface() };
    const initialHit = rayPlanePoint(focusPointerRay({ point, size: surface, camera }), planeOrigin, planeNormal);

    // Shift 拖动选中对象本体：绕局部 Y 旋转。
    if (isShift && deps.pick(point) === item.id) {
      if (!deps.session.beginEdit()) return false;
      drag = { ...baseDrag("yaw", null, item.id, item, point, planeOrigin, planeNormal), nodeId: deps.nodeId() };
      return true;
    }

    // 命中 gizmo：轴约束或中心自由平移。
    const hit = deps.hitObjectGizmo(point);
    if (!hit) return false;
    if (!deps.session.beginEdit()) return false;
    drag = {
      ...baseDrag(hit.handle === "center" ? "plane" : "axis", hit.handle === "center" ? null : hit.handle, item.id, item, point, planeOrigin, planeNormal),
      camera, surface, basis: { unit: basis.unit, yaw: basis.yaw, worldToLocal: basis.worldToLocal }, nodeId: deps.nodeId(),
      ...(initialHit ? { initialHit } : {}),
      ...(hit.direction ? { direction: hit.direction } : {}),
      ...(hit.worldPerPixel !== undefined ? { worldPerPixel: hit.worldPerPixel } : {})
    };
    return true;
  };

  const move = (point: { x: number; y: number }): void => {
    if (!drag) return;
    const state = deps.session.getState();
    if (deps.blocked() || state.selectedItemId !== drag.itemId || !state.preview || (drag.nodeId !== undefined && state.nodeId !== drag.nodeId)) { cancel(); return; }
    const scale = drag.originScale;

    if (drag.kind === "yaw") {
      const yaw = drag.originYaw + ((point.x - drag.startX) * Math.PI) / 180 * 1.15;
      deps.session.updatePreview({ offset: { ...drag.originOffset }, scale, yaw });
      return;
    }

    if (drag.kind === "axis" && drag.axis) {
      const direction = drag.direction;
      const worldPerPixel = drag.worldPerPixel;
      if (!direction || worldPerPixel === undefined) return;
      const projected = (point.x - drag.startX) * direction[0] + (point.y - drag.startY) * direction[1];
      const worldDelta = projected * worldPerPixel;
      if (!Number.isFinite(worldDelta)) return;
      // 世界轴位移 → 对象基础 offset 增量（整体摆放旋转逆 + 根 unit）。
      const axisVec: Vec3 = drag.axis === "x" ? [worldDelta, 0, 0] : drag.axis === "z" ? [0, 0, worldDelta] : [0, worldDelta, 0];
      const offsetDelta = localDelta(axisVec, drag.basis!);
      const offset = {
        x: drag.originOffset.x + offsetDelta.x,
        y: drag.originOffset.y + offsetDelta.y,
        z: drag.originOffset.z + offsetDelta.z
      };
      deps.session.updatePreview({ offset, scale, yaw: drag.originYaw });
      return;
    }

    // 中心自由平移：穿过对象中心的固定相机平面，减去按下时交点。
    const ray = focusPointerRay({ point, size: drag.surface!, camera: drag.camera! });
    const world = rayPlanePoint(ray, drag.planeOrigin, drag.planeNormal);
    if (!world || !drag.initialHit) return;
    const delta: Vec3 = [world[0] - drag.initialHit[0], world[1] - drag.initialHit[1], world[2] - drag.initialHit[2]];
    const offsetDelta = localDelta(delta, drag.basis!);
    deps.session.updatePreview({
      offset: {
        x: drag.originOffset.x + offsetDelta.x,
        y: drag.originOffset.y + offsetDelta.y,
        z: drag.originOffset.z + offsetDelta.z
      },
      scale,
      yaw: drag.originYaw
    });
  };

  const end = (): void => {
    if (!drag) return;
    const valid = deps.session.getState().selectedItemId === drag.itemId && deps.session.getState().nodeId === drag.nodeId;
    drag = null;
    if (valid) deps.session.endEdit(); else deps.session.cancelEdit();
  };

  const cancel = (): void => {
    drag = null;
    deps.session.cancelEdit();
  };

  /** 只有正在拖动时才取消（Escape 分层手势取消）；返回是否有活动手势被取消。 */
  const cancelIfDragging = (): boolean => {
    if (!drag) return false;
    cancel();
    return true;
  };

  const select = (point: { x: number; y: number }): boolean => {
    const itemId = deps.pick(point);
    deps.session.select(itemId);
    return itemId !== null;
  };

  const handler: FilmSetObjectGesture = {
    active: () => deps.session.getState().nodeId !== null,
    select,
    begin,
    move,
    end,
    cancel,
    cancelIfDragging,
    dispose: () => {
      drag = null;
    }
  };

  return {
    handler,
    install: (controller) => controller?.setFilmSetObjectGesture(handler)
  };
}

function baseDrag(
  kind: ObjectDrag["kind"],
  axis: ObjectDrag["axis"],
  itemId: string,
  item: { localTransform: { offset: { x: number; y: number; z: number }; scale: number; yaw: number } },
  point: { x: number; y: number },
  planeOrigin: Vec3,
  planeNormal: Vec3
): ObjectDrag {
  return {
    kind,
    axis,
    itemId,
    startX: point.x,
    startY: point.y,
    originOffset: { ...item.localTransform.offset },
    originScale: item.localTransform.scale,
    originYaw: item.localTransform.yaw,
    planeOrigin,
    planeNormal
  };
}

/** 相机 forward（world），与主画面平移平面法线同源。 */
function focusForward(camera: ModelFocusCamera): Vec3 {
  const cp = Math.cos(camera.pitch);
  return [-Math.sin(camera.yaw) * cp, Math.sin(camera.pitch), -Math.cos(camera.yaw) * cp];
}

function localDelta(delta: Vec3, basis: { unit: number; yaw: number; worldToLocal?: number[] }): { x: number; y: number; z: number } {
  const m = basis.worldToLocal;
  if (m) return { x: m[0]*delta[0]+m[3]*delta[1]+m[6]*delta[2], y: m[1]*delta[0]+m[4]*delta[1]+m[7]*delta[2], z: m[2]*delta[0]+m[5]*delta[1]+m[8]*delta[2] };
  return worldDeltaToFilmSetItemOffset(delta, {
    unit: basis.unit, extraRotationInverse: [0, -Math.sin(basis.yaw / 2), 0, Math.cos(basis.yaw / 2)]
  });
}
