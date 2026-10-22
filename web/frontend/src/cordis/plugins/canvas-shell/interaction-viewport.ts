/**
 * 视口手势（滚轮 / 触控板平移 / 缩放按钮）
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 interaction-controller 拆出）。
 *
 * 视口是本地状态：预览写入 `state.viewportPreview`，提交写 localStorage，不发服务端命令。
 */
import { clampWoohaa3CanvasZoom, compositeAssetScopeGeometry } from "@woohaa3/contracts";
import { nodeSize } from "./hit-test.js";
import { applyWheelToViewport, classifyWheelEvent, type NormalizedWheel } from "./input/wheel-gesture.js";
import type { InteractionRecorder } from "./interaction-performance.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { InteractionCore, Viewport } from "./interaction-core.js";

/** 触控板平移在停止滚动多久后把视口写入本地存储。 */
const VIEWPORT_COMMIT_IDLE_MS = 120;

export function createWheelViewport(core: InteractionCore, recorder?: InteractionRecorder) {
  const { canvas, state, target, schedule, activeViewport } = core;

  const canvasCenter = (): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: (rect.width || 1) / 2, y: (rect.height || 1) / 2 };
  };

  const applyZoom = (nextZoom: number, anchor?: { x: number; y: number }) => {
    const base = state.viewportPreview ?? core.localViewport.get();
    const zoom = clampWoohaa3CanvasZoom(nextZoom);
    const scale = zoom / base.zoom;
    const a = anchor ?? canvasCenter();
    const next = {
      x: a.x - (a.x - base.x) * scale,
      y: a.y - (a.y - base.y) * scale,
      zoom
    };
    state.viewportPreview = next;
    core.commitViewport(next);
    state.viewportPreview = null;
    schedule("viewport");
  };

  const scheduleViewportCommit = () => {
    if (state.viewportCommitTimer !== null) {
      target.clearTimeout?.(state.viewportCommitTimer);
    }
    state.viewportCommitTimer = target.setTimeout?.(() => {
      state.viewportCommitTimer = null;
      if (state.viewportPreview) core.commitViewport(state.viewportPreview);
      state.viewportPreview = null;
      schedule("viewport");
    }, VIEWPORT_COMMIT_IDLE_MS) ?? null;
  };

  /**
   * 归一化并消费一次 wheel 视口手势；返回实际消费的 kind/source（未消费返回 null）。
   *
   * 计时不在此处：共享入口 `interaction-2d-input.onWheel` 在**前置 modelPreviewWheel 命中/
   * 坐标换算之前**开始计时并负责记录。这里只做纯消费，保证计时范围完整且不重复记录
   * （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D1）。
   *
   * `rect` 由共享入口读取（作为独立 DOM rect 分段）后传入；缺省时自读。
   */
  const onWheel = (
    event: WheelEvent,
    rect?: { left: number; top: number }
  ): { kind: "pan" | "zoom"; source: string } | null => {
    event.preventDefault();
    const target = core.options.getImageViewportTarget?.();
    const focus = (core.options.isImageFocused?.() ?? !!core.options.getImageFocus?.()) ? target?.read() : null;
    const base = focus?.viewport ?? state.viewportPreview ?? core.localViewport.get();
    const bounds = rect ?? canvas.getBoundingClientRect();
    const classification = classifyWheelEvent(
      {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        // 聚焦取景的偏移以内容区中心为原点；普通画布以左上角为原点。
        clientX: event.clientX - bounds.left - (focus ? focus.rect.x + focus.rect.width / 2 : 0),
        clientY: event.clientY - bounds.top - (focus ? focus.rect.y + focus.rect.height / 2 : 0),
        timeStamp: event.timeStamp
      },
      state.wheelSource
    );
    state.wheelSource = classification.control;
    if (!classification.wheel) return null;
    const wheel: NormalizedWheel = classification.wheel;
    // 触控板双指平移视口；鼠标滚轮/pinch 以指针为中心缩放。
    const next = applyWheelToViewport(base, wheel);
    if (focus) target?.write(next);
    else {
      state.viewportPreview = next;
      scheduleViewportCommit();
    }
    schedule("viewport");
    return { kind: wheel.kind, source: wheel.source };
  };

  const zoomBy = (factor: number) => {
    const base = activeViewport();
    applyZoom(base.zoom * factor);
  };

  const zoomTo = (zoom: number) => applyZoom(zoom);

  const zoomToFit = () => {
    const canvasState = woohaa3CanvasStore.getState().canvas;
    if (!canvasState || canvasState.document.nodes.length === 0) {
      applyZoom(1);
      return;
    }
    const scene = core.buildScene();
    if (!scene) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of scene.nodes) {
      // 复合资产地面范围只在其基准矩形之外扩张；取景必须完整包住可见范围（scope AABB），
      // 否则新的范围边缘会被裁掉（change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D4）。
      const ground = node.compositeAsset?.scopeGround;
      const scope = node.compositeAsset && node.compositeAsset.scopeShape === "isometric-diamond" && ground
        ? compositeAssetScopeGeometry(
            { x: node.x, y: node.y, width: node.compositeAsset.width, height: node.compositeAsset.height },
            "isometric-diamond",
            32,
            ground
          ).aabb
        : null;
      const { width, height } = nodeSize(node);
      const left = scope ? scope.x : node.x;
      const top = scope ? scope.y : node.y;
      const right = scope ? scope.x + scope.width : node.x + width;
      const bottom = scope ? scope.y + scope.height : node.y + height;
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, right);
      maxY = Math.max(maxY, bottom);
    }
    const surface = core.surfaceSize();
    const padding = 0.18;
    const boundsWidth = Math.max(1, maxX - minX);
    const boundsHeight = Math.max(1, maxY - minY);
    const zoom = clampWoohaa3CanvasZoom(
      Math.min((surface.width * (1 - padding)) / boundsWidth, (surface.height * (1 - padding)) / boundsHeight)
    );
    const center = canvasCenter();
    const next: Viewport = {
      x: center.x - ((minX + maxX) / 2) * zoom,
      y: center.y - ((minY + maxY) / 2) * zoom,
      zoom
    };
    state.viewportPreview = next;
    core.commitViewport(next);
    state.viewportPreview = null;
    schedule("viewport");
  };

  const measureZoom = (action: () => void, source: string) => {
    if (!recorder) return action();
    const start = recorder.now();
    try { action(); } finally { recorder.record("zoom", source, "control", start); }
  };
  return { onWheel,
    zoomBy: (factor: number) => measureZoom(() => zoomBy(factor), "zoom-by"),
    zoomTo: (zoom: number) => measureZoom(() => zoomTo(zoom), "zoom-to"),
    zoomToFit: () => measureZoom(zoomToFit, "zoom-to-fit"),
    applyZoom, scheduleViewportCommit
  };
}
