/**
 * 共享世界镜头的视锥拖动手势（与 `world-ground-gesture` 同构，规则在 `world-camera-drag`）。
 *
 * 指针路径只负责「开始 / 移动 / 释放 / 取消」的编排：移动期间只改瞬时
 * `worldCameraPreviews`，释放时经权威 `world-camera-save` 提交，成功后把可逆回调记进
 * 页面撤销历史（`canvasEdit.recordExternal`）。
 */
import { createHighEntropyId, type WorldCameraData } from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import {
  beginWorldCameraDrag,
  cardFollowPosition,
  planWorldCameraMove,
  poseFor,
  worldCameraDelta,
  worldCameraSettingsOfPose,
  type WorldCameraDragMode,
  type WorldCameraDragStart,
  type WorldCameraPose
} from "./world-camera-drag.js";
import type { InteractionCore } from "./interaction-core.js";

export type WorldCameraGestureFamily = {
  /** 尝试开始镜头拖动；聚焦/过渡/模态、无人可写或镜头不合法时返回 `null`。 */
  begin: (event: PointerEvent, nodeId: string, mode: WorldCameraDragMode) => WorldCameraDragStart | null;
  /** 指针移动：更新视锥瞬时位姿；镜头被改写或指针离开地面时取消并返回 `false`。 */
  move: (event: PointerEvent) => boolean;
  /** 正常释放：经权威 save 提交一次位姿；返回 `true` 表示已发起提交。 */
  commit: (event: PointerEvent) => boolean;
  /** 取消：清预览、复位手势，不提交。 */
  cancel: () => void;
};

/** 提交结果的可用形状；不在本模块决定权威服务实现。 */
type SaveOutcome =
  | { ok: true; camera: WorldCameraData; settingsVersion: string }
  | { ok: false; message?: string; code?: string };

export type WorldCameraSavePort = {
  save(
    input: {
      canvasId: string;
      cameraId: string;
      expectedSettingsVersion: string;
      settings: ReturnType<typeof worldCameraSettingsOfPose>;
      operationId: string;
    },
    signal?: AbortSignal
  ): Promise<SaveOutcome>;
};

export type WorldCameraGestureDeps = {
  /** 页面的权威镜头保存端口（缺省取 `ctx.canvasRemote` 的 `saveWorldCamera`）。 */
  save?: WorldCameraSavePort["save"];
  /** 页面撤销历史；缺省时只提交，不进入撤销时间线。 */
  recordExternal?: (entry: {
    id: string;
    label: string;
    undo: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    redo: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  }) => { ok: boolean; reason?: string };
  /**
   * 同步移动镜头卡片（不新增撤销条目；由本手势的外部历史统一管理）。
   * 缺省时只移动镜头、不动卡片（测试/最小宿主）。
   */
  moveCard?: (
    nodeId: string,
    position: { x: number; y: number },
    operationId: string
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  operationId: () => string;
  onError?: (message: string) => void;
};

export function createWorldCameraGestureFamilyFromOptions(
  core: InteractionCore,
  options: {
    saveWorldCamera?: WorldCameraSavePort["save"];
    moveWorldCameraCard?: WorldCameraGestureDeps["moveCard"];
    recordExternal?: WorldCameraGestureDeps["recordExternal"];
    onInteractionError?: (error: unknown) => void;
  }
): WorldCameraGestureFamily {
  return createWorldCameraGestureFamily(core, {
    ...(options.saveWorldCamera ? { save: options.saveWorldCamera } : {}),
    ...(options.moveWorldCameraCard ? { moveCard: options.moveWorldCameraCard } : {}),
    ...(options.recordExternal ? { recordExternal: options.recordExternal } : {}),
    operationId: () => createHighEntropyId("world-camera-drag"),
    onError: (message) => options.onInteractionError?.(new Error(message))
  });
}

export function createWorldCameraGestureFamily(
  core: InteractionCore,
  deps: WorldCameraGestureDeps
): WorldCameraGestureFamily {
  const { state, schedule, writable } = core;

  const clearPreview = (nodeId: string) => {
    // Only clear this camera's preview. A late completion for camera A must not wipe
    // the preview of a newer drag on camera B.
    core.setWorldCameraPreview(nodeId, null);
    if (state.localPositions.has(nodeId)) {
      const next = new Map(state.localPositions);
      next.delete(nodeId);
      state.localPositions = next;
    }
  };

  const begin = (event: PointerEvent, nodeId: string, mode: WorldCameraDragMode) => {
    if (!writable()) return null;
    const start = beginWorldCameraDrag(
      workingCanvasOf(woohaa3CanvasStore.getState()),
      nodeId,
      core.queryWorldGround({ x: event.clientX, y: event.clientY }),
      mode
    );
    if (!start) return null;
    clearPreview(nodeId);
    state.gesture = {
      kind: "world-camera",
      pointerId: event.pointerId,
      start,
      delta: { u: 0, v: 0 }
    };
    core.canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    return start;
  };

  const move = (event: PointerEvent) => {
    const gesture = state.gesture;
    if (gesture.kind !== "world-camera" || gesture.pointerId !== event.pointerId) return false;
    const delta = worldCameraDelta(
      gesture.start,
      workingCanvasOf(woohaa3CanvasStore.getState()),
      core.queryWorldGround({ x: event.clientX, y: event.clientY })
    );
    if (!delta) {
      cancel();
      return false;
    }
    gesture.delta = delta;
    core.setWorldCameraPreview(gesture.start.nodeId, delta);
    const pose = poseFor(gesture.start.camera, gesture.start.mode, delta);
    if (pose) {
      state.localPositions = new Map([[gesture.start.nodeId, cardFollowPosition(gesture.start, pose)]]);
    }
    schedule("world-camera-preview");
    return true;
  };

  /** 一次提交：同一位姿既用于 redo，也用于 undo 的目标位姿。 */
  const submitPose = async (
    canvasId: string,
    start: WorldCameraDragStart,
    pose: WorldCameraPose,
    card: { x: number; y: number } | null,
    expectedSettingsVersion: string,
    operationId: string
  ): Promise<{ ok: true; settingsVersion: string } | { ok: false; reason: string }> => {
    if (!deps.save) return { ok: false, reason: "镜头保存端口未就绪" };
    const result = await deps.save({
      canvasId,
      cameraId: start.camera.cameraId,
      expectedSettingsVersion,
      settings: worldCameraSettingsOfPose(start.camera, pose),
      operationId
    });
    if (!result.ok) return { ok: false, reason: result.message ?? "镜头保存失败" };
    if (card && deps.moveCard) {
      const moved = await deps.moveCard(start.nodeId, card, `${operationId}:card`);
      if (!moved.ok) return { ok: false, reason: moved.reason };
    }
    return { ok: true, settingsVersion: result.settingsVersion };
  };

  const commit = (event: PointerEvent) => {
    const gesture = state.gesture;
    if (gesture.kind !== "world-camera") return false;
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const latest = gesture.pointerId === event.pointerId
      ? worldCameraDelta(gesture.start, canvas, core.queryWorldGround({ x: event.clientX, y: event.clientY }))
      : null;
    const delta = latest ?? gesture.delta;
    const pose = planWorldCameraMove(gesture.start, delta);
    if (!pose || !canvas) {
      clearPreview(gesture.start.nodeId);
      schedule("world-camera-preview");
      return false;
    }
    const canvasId = canvas.id;
    const before: WorldCameraPose = {
      position: { ...gesture.start.camera.position },
      rotation: [...gesture.start.camera.rotation] as WorldCameraPose["rotation"]
    };
    const afterCard = cardFollowPosition(gesture.start, pose);
    const beforeCard = gesture.start.card;
    const operationId = deps.operationId();
    const expectedSettingsVersion = gesture.start.camera.settingsVersion;
    void (async () => {
      // 版本链只在确认保存成功后才推进；外部改写会让下一动作失败关闭。
      let version = expectedSettingsVersion;
      const apply = async (target: WorldCameraPose, card: { x: number; y: number } | null, id: string) => {
        const result = await submitPose(canvasId, gesture.start, target, card, version, id);
        if (!result.ok) return result;
        version = result.settingsVersion;
        return { ok: true as const };
      };
      try {
        const first = await apply(pose, afterCard, operationId);
        if (!first.ok) {
          deps.onError?.(first.reason ?? "镜头保存失败");
          clearPreview(gesture.start.nodeId);
          schedule("world-camera-preview");
          return;
        }
        deps.recordExternal?.({
          id: `world-camera:${operationId}`,
          label: gesture.start.mode === "rotate" ? "调整镜头朝向" : "移动镜头",
          undo: () => apply(before, beforeCard, `${operationId}:undo`),
          redo: () => apply(pose, afterCard, `${operationId}:redo`)
        });
        // 保存成功且回执版本已推进；规范位姿和卡片位置已在 working projection 中接替预览。
        clearPreview(gesture.start.nodeId);
        schedule("world-camera-preview");
      } catch (error) {
        deps.onError?.(error instanceof Error ? error.message : "镜头保存失败");
        clearPreview(gesture.start.nodeId);
        schedule("world-camera-preview");
      }
    })();
    return true;
  };

  const cancel = () => {
    if (state.gesture.kind === "world-camera") {
      clearPreview(state.gesture.start.nodeId);
      state.gesture = { kind: "none" };
    }
    schedule("world-camera-preview");
  };

  return { begin, move, commit, cancel };
}
