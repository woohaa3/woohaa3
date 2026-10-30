/**
 * 模型聚焦/编辑 gesture family
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；design D2）。
 *
 * 从 `interaction-controller.ts` 拆出的模型 family：拥有聚焦 session、镜头/焦点 gizmo 手势、
 * 键盘飞行与聚焦缩放。它只通过注入的 `ModelGestureContext` 访问共享坐标系、调度与提交能力，
 * 不自行创建 pointer 监听或 viewport 副本。
 *
 * change: replace-model-node-focus-interactions —— 模型本体拖动已被移除：聚焦编辑只允许镜头
 * gizmo 与焦点三轴 gizmo 写入，`modelPlacement` 不再由直接拖动产生。
 */
import { CLOSE_FOCUS_REFERENCE_ACTION } from "./composite-focus-context.js";
import { workingCanvasOf } from "../../services/canvas-state/index.js";
import type { InteractionQueries } from "./interaction-queries.js";
import type { ModelFocusProjection } from "@woohaa3/contracts";
import { focusedTarget, ModelFocusSession } from "./model-focus-session.js";
import { hitFocusGizmoAxis, hitShotGizmoHandle, type GizmoQuery } from "./model-gizmo-hit.js";
import { createFocusNavigation } from "./model-focus-navigation.js";
import { createFocusLifecycle } from "./model-focus-lifecycle.js";
import { syncPreviewObserver } from "./model-preview-focus.js";
import { isDomConsumingInputTarget } from "./input/shortcuts.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { InteractionControllerOptions } from "./interaction-types.js";

/** 模型 family 依赖的共享能力（由 controller 注入；不含事件监听所有权）。 */
export type ModelGestureContext = {
  canvas: HTMLCanvasElement;
  focusContextContains?: (point: { x: number; y: number }) => boolean;
  options: InteractionControllerOptions;
  writable: () => boolean;
  localViewportSet: (viewport: { x: number; y: number; zoom: number }) => void;
  surfaceSize: () => { width: number; height: number; pixelRatio: number };
  activeViewport: () => { x: number; y: number; zoom: number };
  schedule: (reason?: string) => void;
  /** 命令批次序号（与 controller 共用，保证命令 id 唯一）。 */
  nextSeq: () => number;
  /**
   * gizmo 命中查询（Bevy WASM 相机/bounds 事实源）
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.4）。
   */
  queryGizmo: GizmoQuery;
  queryPoint?: InteractionQueries["queryPoint"];
};

export type ModelGestureFamily = ReturnType<typeof createModelGestureFamily>;

export function createModelGestureFamily(ctx: ModelGestureContext) {
  const { canvas, options, writable, surfaceSize, activeViewport, schedule } = ctx;

  /** 聚焦会话（纯状态机适配，不依赖 DOM）。 */
  const focus = new ModelFocusSession();
  /** history owner 之前保存的 direct 主观察相机（change: fix-model-focus-navigation-and-camera-parity D2）。 */
  let savedDirectCamera: import("@woohaa3/contracts").ModelFocusCamera | null = null;
  /** 活动镜头 pose 手势 handle（change: add-model-editor-gizmo-shot-capture，任务 3.2；
   *  change: add-shot-camera-elevation-control 增加 elevation-ring）。 */
  let activeShotHandle: "orbit-ring" | "elevation-ring" | "distance" | null = null;
  /** 镜头 pose 手势处理器（可运行时注入/替换）。 */
  let shotGesture = options.shotGesture ?? null;
  /** 活动焦点 gizmo 轴（change: 模型编辑 gizmo 焦点）。 */
  let activeFocusAxis: "x" | "y" | "z" | "center" | null = null;
  /** 焦点位移手势处理器（可运行时注入/替换）。 */
  let focusGesture = options.focusGesture ?? null;
  /** 片场对象模式手势（change: 2026-10-09-add-film-set-object-motion-and-editing）。 */
  let objectGesture = options.filmSetObjectGesture ?? null;
  /** 是否正在拖动片场对象。 */
  let activeObjectDrag = false;
  let focusCloseHovered = false;
  let previousCursor = "", previousTitle = "";
  const setCloseHover = (hovered: boolean) => {
    if (hovered === focusCloseHovered) return;
    focusCloseHovered = hovered;
    if (hovered) { previousCursor = canvas.style?.cursor ?? ""; previousTitle = canvas.title; }
    if (canvas.style) canvas.style.cursor = hovered ? "pointer" : previousCursor;
    canvas.title = hovered ? "关闭容器" : previousTitle;
  };
  let feedbackEpoch = 0;
  let cameraDragKey: string | null = null;
  const feedback = (handle: import("@woohaa3/contracts").GizmoHandleName | null, active = false) => {
    const previous = options.getModelEditor?.()?.feedback;
    if (!active && previous?.hover === (handle ?? undefined) && !previous?.active) return;
    options.onGizmoFeedback?.({ epoch: ++feedbackEpoch, ...(handle ? active ? { active: handle } : { hover: handle } : {}) });
  };
  const dragKey = () => {
    const editor = options.getModelEditor?.();
    const canonical = woohaa3CanvasStore.getState().canvas;
    return JSON.stringify([focus.projection(), surfaceSize(), options.getRuntime()?.generation(), options.getModelFocusMode?.(),
      editor?.nodeId, editor?.toolMode, editor?.cameraId, editor?.cameraTool, canonical?.nodeData?.[focus.nodeId ?? ""]]);
  };
  /** 片场对象局部键盘 action（change: 2026-10-10-improve-film-set-editing-and-inspector）。 */
  let objectAction = options.filmSetObjectAction ?? null;
  /** 上报聚焦投影变化；宿主据此把投影合并进下一份渲染快照并 flush。 */
  const emitModelFocus = () => {
    if (options.getModelFocusMode?.() !== "history") syncPreviewObserver(focus, options.getModelFocusTargets?.() ?? []);
    options.onModelFocusChange?.(focus.projection());
    schedule("model-preview");
  };

  /** 聚焦相机导航（键盘飞行 + 滚轮/捏合）委托到独立模块。 */
  const navigation = createFocusNavigation({
    isActive: () => focus.active,
    projection: () => focus.projection(),
    fly: (keys, modifiers, delta) => focus.fly(keys, modifiers, delta),
    zoomBy: (factor) => focus.zoomBy(factor),
    rotateBy: (dx, dy) => focus.rotateBy(dx, dy),
    emit: () => emitModelFocus(),
    targetOwnsInput: (target) => isDomConsumingInputTarget(target)
  });

  /** 聚焦会话生命周期（进入/退出/取景/有效期）委托到独立模块。 */
  const lifecycle = createFocusLifecycle({
    focus,
    getTargets: () => options.getModelFocusTargets?.() ?? [],
    hasTarget: options.hasModelFocusTarget,
    activeViewport,
    surfaceSize,
    localViewportSet: (viewport) => ctx.localViewportSet(viewport),
    emit: () => emitModelFocus(),
    clearHeld: () => clearHeldKeys(),
    onInvalidate: (reason) => options.onModelFocusInvalid?.(reason)
  });

  /**
   * placement 编辑门禁（任务 3.4 / spec「只有当前 canonical 模型可进行聚焦编辑」）：
   * 会话可写、聚焦目标为 canonical 节点（非 pending-only）、内容为 canonical（非临时快照）
   * 且渲染器可用。任一不满足时禁用镜头/焦点 gizmo 手势。
   */
  const placementEditable = (): boolean => {
    if (!focus.active) return false;
    if (!writable()) return false;
    const nodeId = focus.nodeId;
    if (nodeId === null) return false;
    // pending-only 节点（仅存在于 working projection）不可编辑。
    const canonical = woohaa3CanvasStore.getState().canvas;
    if (!canonical || !canonical.document.nodes.some((node) => node.id === nodeId)) return false;
    const target = focusedTarget(options.getModelFocusTargets?.() ?? [], nodeId);
    if (!target || target.nonCanonical) return false;
    // renderer not-ready：不建立手势（查看由 Bevy 投影，编辑门禁独立）。
    const runtime = options.getRuntime();
    if (runtime && !runtime.isReady()) return false;
    return true;
  };

  /** 退出聚焦：恢复进入前 2D 视口，清理 held input，并上报 null（任务 3.4）。 */
  const exitModelFocus = () => {
    savedDirectCamera = null;
    lifecycle.exit();
  };

  /**
   * 应用完整 focus target transition（change: fix-model-focus-navigation-and-camera-parity，design D2）。
   *
   * `null` 退出聚焦并恢复进入前 overview；`history` 保存 direct 主观察相机并切只读；
   * `direct` 在 owner 切换时恢复进入 history 前的 direct 相机。所有校验在 mutation 前完成。
   */
  const applyFocusTarget = (
    target: import("../../navigation/contracts.js").CanvasFocusTarget | null,
    transition: { preserveSession: boolean; restoreDirectCamera?: boolean }
  ): { ok: true } | { ok: false; reason: string } => {
    // owner/目标切换取消未提交 preview 与 held input（不提交半成品；design D7）。
    clearHeldKeys();
    // 独立文件文档不是模型/扩展节点：controller 只清掉当前模型聚焦。
    if (target && target.kind === "document") {
      exitModelFocus();
      return { ok: true };
    }
    if (!target) {
      exitModelFocus();
      return { ok: true };
    }
    const sameNode = focus.active && focus.nodeId === target.nodeId;
    if (target.owner === "history") {
      // 切换为 history：保存 direct 主观察相机（同 session，不重建；design D2/D4）。
      savedDirectCamera = focus.cameraSnapshot();
      if (!sameNode) {
        const entered = lifecycle.enterForNode(target.nodeId);
        if (!entered) {
          savedDirectCamera = null;
          return { ok: false, reason: "focus-target-unavailable" };
        }
        // 新建 session：重新保存进入后 direct 相机（enter 只创建一次）。
        savedDirectCamera = focus.cameraSnapshot();
      }
      emitModelFocus();
      return { ok: true };
    }
    // direct owner。
    if (!sameNode) {
      const entered = lifecycle.enterForNode(target.nodeId);
      if (!entered) return { ok: false, reason: "focus-target-unavailable" };
    } else if (transition.restoreDirectCamera && savedDirectCamera) {
      focus.restoreCamera(savedDirectCamera);
      emitModelFocus();
    }
    savedDirectCamera = null;
    return { ok: true };
  };

  /**
   * 以 canonical nodeId 请求进入聚焦
   * （change: add-canvas-node-generation-history，任务 4.1）。
   */
  const enterModelFocusForNode = (nodeId: string): boolean => lifecycle.enterForNode(nodeId);

  /** 从双击模型命中进入聚焦（canonical 校验由调用方完成）。 */
  const enterFromModelHit = (input: { nodeId: string; target: [number, number, number]; radius: number }): boolean =>
    lifecycle.enterFromHit(input);

  /** 按未遮挡左侧区域更新聚焦取景。 */
  const setContentRect = (rect: { right: number; left?: number; top?: number; bottom?: number }): void => lifecycle.setContentRect(rect);

  /** 按当前本地 Scene IR override 重新取景。 */
  const reframeModelFocus = (nodeId: string): void => lifecycle.reframe(nodeId);

  const clearHeldKeys = () => {
    setCloseHover(false);
    navigation.resetHeld();
    // 活动镜头 pose 手势被取消：只清理 preview，不提交（任务 3.2 / 4.4）。
    if (activeShotHandle && shotGesture) {
      shotGesture.cancel();
    }
    activeShotHandle = null;
    // 活动焦点手势被取消：只清理 preview，不提交（change: 模型编辑 gizmo 焦点）。
    if (activeFocusAxis && focusGesture) {
      focusGesture.cancel();
    }
    activeFocusAxis = null;
    // 活动对象拖动被取消：只清理 preview，不提交（change: 2026-10-09 片场对象编辑）。
    if (activeObjectDrag && objectGesture) {
      objectGesture.cancel();
    }
    activeObjectDrag = false;
    objectGesture?.hover?.(null);
    cameraDragKey = null;
    feedback(null);
    focus.clearHeld();
  };

  /** 聚焦目标失效（删除 / Scene IR 移除 / selection 清除）→ 退出并恢复（任务 3.4）。 */
  const syncModelFocusValid = () => {
    if (cameraDragKey && (!placementEditable() || cameraDragKey !== dragKey())) clearHeldKeys();
    lifecycle.syncValid();
  };

  /** 单次键盘飞行推进（每帧调用；聚焦且无 DOM editable/modal 时生效）。 */
  const advanceModelFly = () => {
    navigation.advanceFly();
  };

  /**
   * 聚焦状态下的 pointerdown：左键仅命中 shot/focus gizmo 才编辑 rig。
   * RMB 或 Alt/Option + 左键旋转观察相机，MMB 平移观察相机。
   * 不选中节点、不开始 drag/marquee/connect/right-press/resize，也不打开上下文菜单。
   */
  const isFocusReferenceEvent = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return ctx.focusContextContains?.({ x: event.clientX - rect.left, y: event.clientY - rect.top }) ?? false;
  };
  const beginFocusPointer = (event: PointerEvent) => {
    if (isFocusReferenceEvent(event)) {
      event.preventDefault();
      if (event.button === 0 && !event.altKey && writable() && options.getModelFocusMode?.() !== "history") {
        const rect = canvas.getBoundingClientRect();
        const hit = ctx.queryPoint?.({ x: event.clientX - rect.left, y: event.clientY - rect.top }, 1);
        if (hit?.ok && hit.value?.kind === "node-action" && hit.value.actionId === CLOSE_FOCUS_REFERENCE_ACTION) {
          const current = workingCanvasOf(woohaa3CanvasStore.getState());
          const child = options.compositeAssets?.children(current).get(hit.value.nodeId);
          if (current && child?.ownerNodeId === focus.nodeId) options.compositeAssets?.closeChild(current, hit.value.nodeId);
        }
      }
      return;
    }
    // Alt/Option 主按钮为触摸板提供无需按住右键的旋转入口，优先于 gizmo 编辑。
    const button = event.button === 0 && event.altKey ? 2 : event.button ?? 0;
    if (button === 0) {
      const rect = canvas.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      // 镜头 shot gizmo handle 优先于相机手势（design D6）。
      const focusAxis = resolveFocusGizmoAxis(point);
      // 中心点与镜头视线重叠时，中心拖动优先。
      const shotHandle = focusAxis === "center" ? null : resolveShotGizmoHandle(point);
      if (shotHandle && shotGesture && placementEditable()) {
        if (shotGesture.begin(shotHandle, point)) {
          activeShotHandle = shotHandle;
          cameraDragKey = dragKey();
          feedback(shotHandle, true);
          canvas.setPointerCapture?.(event.pointerId);
          event.preventDefault();
          return;
        }
      }
      // 焦点三轴 gizmo 是编辑模式唯一允许的通用位移入口
      // （change: replace-model-node-focus-interactions）。
      if (focusAxis && focusGesture && placementEditable()) {
        if (focusGesture.begin(focusAxis, point)) {
          activeFocusAxis = focusAxis;
          cameraDragKey = dragKey();
          feedback(focusAxis, true);
          canvas.setPointerCapture?.(event.pointerId);
          event.preventDefault();
          return;
        }
      }
      // 片场对象模式：单击选择命中对象；拖动移动/Shift 旋转（change: 2026-10-09 片场对象编辑）。
      // 在 gizmo 之后、整体拖动之前裁决，保持整体模式与镜头工具优先。
      if (objectGesture?.active() && placementEditable()) {
        const cameraMode = options.getModelEditor?.()?.toolMode === "camera";
        if (!cameraMode && objectGesture.begin(point, event.shiftKey)) {
          activeObjectDrag = true;
          canvas.setPointerCapture?.(event.pointerId);
          event.preventDefault();
          return;
        }
        // 未命中已选中对象：单击只更新选择，不开始拖动，也不落到相机手势。
        if (objectGesture.select(point, { preserveOnMiss: cameraMode }) || !cameraMode) {
          canvas.setPointerCapture?.(event.pointerId);
          event.preventDefault();
          return;
        }
      }
      // A selected constrained camera tool also works on the empty viewport. Geometry handles
      // and object picking above keep priority; focus remains handle-only.
      const editor = options.getModelEditor?.();
      const toolHandle = editor?.toolMode === "camera" && editor.shot
        ? editor.cameraTool === "orbit" ? "orbit-ring" : editor.cameraTool === "elevation" ? "elevation-ring" : editor.cameraTool === "distance" ? "distance" : null
        : null;
      if (toolHandle && shotGesture && placementEditable() && shotGesture.begin(toolHandle, point)) {
        activeShotHandle = toolHandle;
        cameraDragKey = dragKey();
        feedback(toolHandle, true);
        canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      // 拖动模型本体 MUST NOT 修改 modelPlacement：主按钮不再建立 placement 手势。
      // 主按钮不开始相机手势（保持既有「聚焦时短路 2D」语义）。
      return;
    }
    if (button !== 1 && button !== 2) return;
    if (!focus.beginPointer(button, event.pointerId, event.clientX, event.clientY)) return;
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  /**
   * 命中镜头 shot gizmo 时返回 handle（orbit-ring / distance）。
   * 见 `model-gizmo-hit.ts`。
   */
  const resolveShotGizmoHandle = (point: { x: number; y: number }): "orbit-ring" | "elevation-ring" | "distance" | null =>
    hitShotGizmoHandle({
      editor: options.getModelEditor?.() ?? null,
      projection: focus.projection(),
      point,
      surface: surfaceSize(),
      query: ctx.queryGizmo
    });

  /**
   * 命中焦点三轴 gizmo 时返回轴（x/y/z）。见 `model-gizmo-hit.ts`。
   */
  const resolveFocusGizmoAxis = (point: { x: number; y: number }): "x" | "y" | "z" | "center" | null =>
    hitFocusGizmoAxis({
      editor: options.getModelEditor?.() ?? null,
      projection: focus.projection(),
      surface: surfaceSize(),
      point,
      query: ctx.queryGizmo
    });

  /**
   * 聚焦状态下的 pointermove：命中 shot/focus gizmo handle 时推进对应用户手势，否则推进相机手势。
   *
   * 模型本体拖动已被移除（change: replace-model-node-focus-interactions）：聚焦编辑只允许
   * 镜头 gizmo 与焦点三轴 gizmo 写入，模型 placement 不再由直接拖动产生。
   */
  const moveFocusPointer = (event: PointerEvent): boolean => {
    const surface = surfaceSize();
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (cameraDragKey && (!placementEditable() || cameraDragKey !== dragKey())) { clearHeldKeys(); return true; }
    // 片场对象拖动优先（change: 2026-10-09 片场对象编辑）。
    if (activeObjectDrag && objectGesture) {
      objectGesture!.move(point);
      return true;
    }
    // 镜头 pose 手势优先（design D6）。
    if (activeShotHandle && shotGesture) {
      shotGesture.move(activeShotHandle, point);
      return true;
    }
    // 焦点三轴手势（change: 模型编辑 gizmo 焦点）。
    if (activeFocusAxis && focusGesture) {
      focusGesture.move(activeFocusAxis, point);
      return true;
    }
    if (ctx.focusContextContains?.(point) && !cameraDragKey) {
      const hit = writable() && options.getModelFocusMode?.() !== "history" ? ctx.queryPoint?.(point, 1) : null;
      setCloseHover(!!(hit?.ok && hit.value?.kind === "node-action" && hit.value.actionId === CLOSE_FOCUS_REFERENCE_ACTION));
      objectGesture?.hover?.(null); feedback(null); return true;
    }
    setCloseHover(false);
    objectGesture?.hover?.(placementEditable() ? point : null);
    if (options.getModelEditor?.()?.toolMode === "camera") {
      const handle = placementEditable() ? resolveFocusGizmoAxis(point) ?? resolveShotGizmoHandle(point) : null;
      feedback(handle);
    }
    const changed = focus.movePointer(event.pointerId, event.clientX, event.clientY, surface.height);
    if (changed) emitModelFocus();
    return changed;
  };

  /** 聚焦状态下 pointerup：结束镜头/焦点/相机手势。 */
  const endFocusPointer = (event: PointerEvent) => {
    if (cameraDragKey && (!placementEditable() || cameraDragKey !== dragKey())) { clearHeldKeys(); return; }
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (activeObjectDrag && objectGesture) {
      objectGesture.move(point);
      objectGesture.end();
      activeObjectDrag = false;
    } else if (activeShotHandle && shotGesture) {
      shotGesture.move(activeShotHandle, point);
      shotGesture.end();
      activeShotHandle = null;
    } else if (activeFocusAxis && focusGesture) {
      focusGesture.move(activeFocusAxis, point);
      focusGesture.end();
      activeFocusAxis = null;
    } else {
      focus.endPointer(event.pointerId);
    }
    cameraDragKey = null;
    feedback(null);
  };

  return {
    get active() { return focus.active; },
    get nodeId() { return focus.nodeId; },
    projection: (): ModelFocusProjection | null => focus.projection(),
    placementEditable,
    emitModelFocus,
    exitModelFocus,
    applyFocusTarget,
    enterModelFocusForNode,
    enterFromModelHit,
    setContentRect,
    reframeModelFocus,
    zoomFocusedModel: (factor: number) => { if (focus.zoomBy(factor)) emitModelFocus(); },
    clearHeldKeys,
    syncModelFocusValid,
    advanceModelFly,
    beginFocusPointer,
    isFocusReferenceEvent,
    moveFocusPointer,
    endFocusPointer,
    flyKeyName: navigation.flyKeyName,
    applyFlyKey: navigation.applyFlyKey,
    onDocumentWheel: (event: WheelEvent, modalActive: boolean) => {
      if (focus.active && isFocusReferenceEvent(event)) { event.preventDefault(); return true; }
      return navigation.onDocumentWheel(event, modalActive);
    },
    onGestureStart: (event: Event, modalActive: boolean) => {
      const pointer = event as Event & { clientX?: number; clientY?: number };
      if (focus.active && typeof pointer.clientX === "number" && typeof pointer.clientY === "number"
        && isFocusReferenceEvent({ clientX: pointer.clientX, clientY: pointer.clientY })) {
        navigation.onGestureEnd(event);
        return;
      }
      navigation.onGestureStart(event, modalActive);
    },
    onGestureChange: navigation.onGestureChange,
    onGestureEnd: navigation.onGestureEnd,
    setShotGesture: (handler: InteractionControllerOptions["shotGesture"] | null) => {
      shotGesture = handler ?? null;
    },
    setFocusGesture: (handler: InteractionControllerOptions["focusGesture"] | null) => {
      focusGesture = handler ?? null;
    },
    setFilmSetObjectGesture: (handler: InteractionControllerOptions["filmSetObjectGesture"] | null) => {
      objectGesture = handler ?? null;
    },
    filmSetObjectAction: () => objectAction,
    setFilmSetObjectAction: (handler: InteractionControllerOptions["filmSetObjectAction"] | null) => {
      objectAction = handler ?? null;
    },
    setShotWheel: (handler: InteractionControllerOptions["shotWheel"] | null) => {
      // 保留宿主注入接口兼容性；主画布滚轮始终由观察相机消费。
      void handler;
    }
  };
}
