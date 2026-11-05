/**
 * 视口手势（滚轮 / 触控板平移 / 缩放按钮）
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 interaction-controller 拆出）。
 *
 * 视口是本地状态：预览写入 `state.viewportPreview`，提交写 localStorage，不发服务端命令。
 */
import { clampWoohaa3CanvasZoom, worldToCanvasPoint, worldToRendererPosition } from "@woohaa3/contracts";
import { nodeSize } from "./hit-test.js";
import { applyWheelToViewport, classifyWheelEvent, type NormalizedWheel } from "./input/wheel-gesture.js";
import { createPerfInputRecorder } from "./input/perf-interaction.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { InteractionCore, Viewport } from "./interaction-core.js";

/** 触控板平移在停止滚动多久后把视口写入本地存储。 */
const VIEWPORT_COMMIT_IDLE_MS = 120;

export function createWheelViewport(core: InteractionCore) {
  const { canvas, state, target, schedule, activeViewport } = core;
  /**
   * 缩放控件（右下角按钮 / 取景）的输入埋点
   * （change: 2026-10-25-enhance-telemetry-performance-collection，task 3.3）。
   *
   * 滚轮由 `input/wheel-entry.ts` 合并成段；这里是**一次点击触发的一次视口变更**，本身
   * 就是一次被消费的输入，因此一次点击一条 `perf.interaction`。
   */
  const perf = createPerfInputRecorder();
  const measuredZoom = (run: () => void): void => {
    const started = perf.enter();
    perf.start("zoom", started);
    try {
      run();
    } finally {
      perf.accumulateSince("viewport-apply", started);
      perf.finish();
    }
  };

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
   * `rect` 由共享入口读取后传入；缺省时自读。
   */
  const onWheel = (
    event: WheelEvent,
    rect?: { left: number; top: number }
  ): { kind: "pan" | "zoom"; source: string } | null => {
    event.preventDefault();
    const target = core.options.getImageViewportTarget?.();
    const imageFocused = core.options.isImageFocused?.() ?? !!core.options.getImageFocus?.();
    // 编辑器尚未接管画面时按普通画布取景，避免把滚轮写到不存在的聚焦取景状态里。
    const focus = imageFocused && !(core.options.isImageFocusPending?.() ?? false) ? target?.read() : null;
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
    measuredZoom(() => {
      const base = activeViewport();
      applyZoom(base.zoom * factor);
    });
  };

  const zoomTo = (zoom: number) => measuredZoom(() => applyZoom(zoom));

  const zoomToFit = () => measuredZoom(() => {
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
    const include = (left: number, top: number, right: number, bottom: number) => {
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, right);
      maxY = Math.max(maxY, bottom);
    };
    const project = (u: number, v: number) => {
      const renderer = worldToRendererPosition({ u, v, h: 0 });
      return worldToCanvasPoint([renderer[0], renderer[1], renderer[2]]);
    };
    for (const node of scene.nodes) {
      // 共享世界模型没有卡片：用真实世界原点参与取景，不能再按 (0,0) 的卡片矩形。
      if (node.sharedWorldInstance) {
        const position = node.sharedWorldInstance.transform.position;
        const point = project(position.u, position.v);
        const pad = 48;
        include(point.x - pad, point.y - pad, point.x + pad, point.y + pad);
        continue;
      }
      const { width, height } = nodeSize(node);
      const left = node.x;
      const top = node.y;
      include(left, top, node.x + width, node.y + height);
    }
    // 导演区只投影地面范围，不进入 nodes；取景必须把四角算进来。
    for (const area of scene.sceneAreas ?? []) {
      for (const corner of [
        { u: area.bounds.min.u, v: area.bounds.min.v },
        { u: area.bounds.min.u, v: area.bounds.max.v },
        { u: area.bounds.max.u, v: area.bounds.min.v },
        { u: area.bounds.max.u, v: area.bounds.max.v }
      ]) {
        const point = project(corner.u, corner.v);
        include(point.x, point.y, point.x, point.y);
      }
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
      applyZoom(1);
      return;
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
  });

  return { onWheel, zoomBy, zoomTo, zoomToFit, applyZoom, scheduleViewportCommit };
}
