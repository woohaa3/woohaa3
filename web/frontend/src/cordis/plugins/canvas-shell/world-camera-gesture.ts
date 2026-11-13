/**
 * 共享世界镜头的视锥拖动手势（与 `world-ground-gesture` 同构，规则在 `world-camera-drag`）。
 *
 * 指针路径只负责「开始 / 移动 / 释放 / 取消」的编排：移动期间只改瞬时
 * `worldCameraPreviews`，释放时经权威 `world-camera-save` 提交，成功后把可逆回调记进
 * 页面撤销历史（`canvasEdit.recordExternal`）。
 */
import { createHighEntropyId, type CanvasCommand, type WorldCameraData } from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import {
  animatedCameraAt,
  beginWorldCameraDrag,
  cardFollowPosition,
  planWorldCameraMoveWithAnimationParts,
  poseFor,
  worldCameraDelta,
  worldCameraSettingsOfPose,
  type WorldCameraDragMode,
  type WorldCameraDragStart,
  type WorldCameraPose
} from "./world-camera-drag.js";
import type { InteractionCore } from "./interaction-core.js";
import { confirmWorldUnbind } from "./world-unbind-confirm.js";

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
  | { ok: true; camera: WorldCameraData; settingsVersion: string; revision?: number }
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
    revision?: number;
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
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const ground = core.queryWorldGround({ x: event.clientX, y: event.clientY });
    const baseStart = beginWorldCameraDrag(canvas, nodeId, ground, mode);
    if (!baseStart) return null;
    // 动画镜头可见位姿来自脚本采样；拖拽必须从可见位姿开始，不能从远处的规范基点跳变。
    const sampled = animatedCameraAt(
      canvas,
      baseStart.canonical.cameraId,
      core.options.getWorldAnimationTimes?.()
    );
    const start = sampled && sampled.areas.length > 0
      ? beginWorldCameraDrag(canvas, nodeId, ground, mode, sampled.camera) ?? baseStart
      : baseStart;
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

  /** 动画脚本与镜头保存分两步提交；同一外部撤销条目回放两条命令。 */
  const submitAreaCommands = async (
    commands: CanvasCommand[],
    commandId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (commands.length === 0) return { ok: true };
    const session = core.options.getSession?.();
    if (!session) return { ok: false, reason: "动画脚本保存端口未就绪" };
    const result = session.submitCommands(commands, commandId);
    if (!result.ok) return { ok: false, reason: result.reason ?? "动画脚本未提交" };
    const settled = await result.handle.settled;
    return settled.state === "committed"
      ? { ok: true }
      : { ok: false, reason: settled.error ?? "动画脚本未提交" };
  };

  /** 一次提交：同一位姿既用于 redo，也用于 undo 的目标位姿。 */
  const submitPose = async (
    canvasId: string,
    start: WorldCameraDragStart,
    pose: WorldCameraPose,
    card: { x: number; y: number } | null,
    expectedSettingsVersion: string,
    operationId: string,
    areaCommands: CanvasCommand[]
  ): Promise<
    | { ok: true; settingsVersion: string; revision?: number }
    | { ok: false; reason: string; settingsVersion?: string }
  > => {
    if (!deps.save) return { ok: false, reason: "镜头保存端口未就绪" };
    const result = await deps.save({
      canvasId,
      cameraId: start.canonical.cameraId,
      expectedSettingsVersion,
      settings: worldCameraSettingsOfPose(start.camera, pose),
      operationId
    });
    if (!result.ok) return { ok: false, reason: result.message ?? "镜头保存失败" };
    const areas = await submitAreaCommands(areaCommands, `${operationId}:area`);
    if (!areas.ok) return { ok: false, reason: areas.reason, settingsVersion: result.settingsVersion };
    if (card && deps.moveCard) {
      const moved = await deps.moveCard(start.nodeId, card, `${operationId}:card`);
      if (!moved.ok) return { ok: false, reason: moved.reason, settingsVersion: result.settingsVersion };
    }
    // The camera revision precedes any area or card writes in this gesture.
    // It is a valid ordering boundary only when the camera was the sole write.
    const revision = areaCommands.length === 0 && !(card && deps.moveCard) ? result.revision : undefined;
    return { ok: true, settingsVersion: result.settingsVersion, ...(revision !== undefined ? { revision } : {}) };
  };

  const commit = (event: PointerEvent) => {
    const gesture = state.gesture;
    if (gesture.kind !== "world-camera") return false;
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const latest = gesture.pointerId === event.pointerId
      ? worldCameraDelta(gesture.start, canvas, core.queryWorldGround({ x: event.clientX, y: event.clientY }))
      : null;
    const delta = latest ?? gesture.delta;
    const plan = planWorldCameraMoveWithAnimationParts(
      canvas,
      gesture.start,
      delta,
      core.options.getWorldAnimationTimes?.()
    );
    if (!plan || !canvas) {
      clearPreview(gesture.start.nodeId);
      schedule("world-camera-preview");
      return false;
    }
    const canvasId = canvas.id;
    // 撤销目标是规范位姿，不是动画采样位姿；外部改写与版本校验也只看规范值。
    const before: WorldCameraPose = {
      position: { ...gesture.start.canonical.position },
      rotation: [...gesture.start.canonical.rotation] as WorldCameraPose["rotation"]
    };
    const beforeCard = gesture.start.card;
    const operationId = deps.operationId();
    const expectedSettingsVersion = gesture.start.canonical.settingsVersion;

    const execute = async (applied: NonNullable<typeof plan>) => {
      const afterCard = cardFollowPosition(gesture.start, applied.pose);
      // 版本链只在确认保存成功后才推进；外部改写会让下一动作失败关闭。
      let version = expectedSettingsVersion;
      const apply = async (
        target: WorldCameraPose,
        card: { x: number; y: number } | null,
        id: string,
        areaCommands: CanvasCommand[]
      ) => {
        const result = await submitPose(canvasId, gesture.start, target, card, version, id, areaCommands);
        if (!result.ok) {
          // The camera save may already have advanced settingsVersion even when the
          // following animation patch failed; keep the chain usable for recovery.
          if (result.settingsVersion) version = result.settingsVersion;
          return { ok: false as const, reason: result.reason };
        }
        version = result.settingsVersion;
        return { ok: true as const, ...(result.revision !== undefined ? { revision: result.revision } : {}) };
      };
      try {
        const first = await apply(applied.pose, afterCard, operationId, applied.forwardAreas);
        if (!first.ok) {
          deps.onError?.(first.reason ?? "镜头保存失败");
          clearPreview(gesture.start.nodeId);
          schedule("world-camera-preview");
          return;
        }
        deps.recordExternal?.({
          id: `world-camera:${operationId}`,
          label: gesture.start.mode === "rotate" ? "调整镜头朝向" : "移动镜头",
          revision: first.revision,
          undo: () => apply(before, beforeCard, `${operationId}:undo`, applied.inverseAreas),
          redo: () => apply(applied.pose, afterCard, `${operationId}:redo`, applied.forwardAreas)
        });
        clearPreview(gesture.start.nodeId);
        schedule("world-camera-preview");
      } catch (error) {
        deps.onError?.(error instanceof Error ? error.message : "镜头保存失败");
        clearPreview(gesture.start.nodeId);
        schedule("world-camera-preview");
      }
    };

    if (plan.unbindCandidates.length === 0) {
      void execute(plan);
      return true;
    }
    const candidates = plan.unbindCandidates;
    void (async () => {
      const confirmed = await confirmWorldUnbind({
        title: "镜头移出导演区",
        description: `移出后${candidates.map(candidate => `「${candidate.title}」`).join("、")}的动画脚本将与镜头解绑。是否继续？`,
        confirmLabel: "移出并解绑"
      });
      if (!confirmed) {
        clearPreview(gesture.start.nodeId);
        schedule("world-camera-preview");
        return;
      }
      const latestCanvas = workingCanvasOf(woohaa3CanvasStore.getState());
      const latestPlan = latestCanvas
        ? planWorldCameraMoveWithAnimationParts(
            latestCanvas,
            gesture.start,
            delta,
            core.options.getWorldAnimationTimes?.(),
            new Set(candidates.map(candidate => candidate.areaNodeId))
          )
        : null;
      if (!latestPlan) {
        clearPreview(gesture.start.nodeId);
        schedule("world-camera-preview");
        return;
      }
      await execute(latestPlan);
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
