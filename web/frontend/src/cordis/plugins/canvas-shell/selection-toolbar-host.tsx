import type { Context } from "@deepseek-ai/cordis";
import { nodeActionToolbarLayout, type ScreenRect } from "@woohaa3/contracts";
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { planSelectionTidy, tidyableNodeIds } from "./selection-tidy.js";
import "./node-action-toolbar.css";

const TIDY_ACTION = { id: "selection-tidy", label: "整理卡片", enabled: true, icon: "arrange-grid" as const };

/** 选区的屏幕包围盒；任何一张读不到矩形就返回 null（还没渲染出来时不显示）。 */
function unionRect(ctx: Context, nodeIds: readonly string[]): ScreenRect | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const id of nodeIds) {
    const rect = ctx.canvasRuntime.nodeScreenRect(id);
    if (!rect) return null;
    left = Math.min(left, rect.left); top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width); bottom = Math.max(bottom, rect.top + rect.height);
  }
  return Number.isFinite(left) ? { left, top, width: right - left, height: bottom - top } : null;
}

/** 框选 / 多选 ≥2 张卡片时，浮在选区上方的横条。目前只有「整理卡片」。 */
export function SelectionToolbarHost({ ctx }: { ctx: Context }) {
  const ref = useRef<HTMLDivElement>(null);
  const subscribe = useCallback((notify: () => void) => {
    const off = [woohaa3CanvasStore.subscribe(notify), nodeSelectionStore.subscribe(notify),
      ctx.canvasNavigation.subscribe(notify), ctx.canvasSession.subscribe(notify)];
    return () => off.forEach(dispose => dispose?.());
  }, [ctx]);
  // 值快照：只在「该不该显示 / 哪些卡片」变化时重渲染，位置另由 layout 副作用跟随画布。
  const snapshot = useSyncExternalStore(subscribe, () => {
    const { nodeIds } = nodeSelectionStore.getSnapshot();
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const overview = ctx.canvasNavigation.getSnapshot().mode.type === "overview";
    const ids = overview && ctx.canvasSession.isWritable() ? tidyableNodeIds(canvas, nodeIds) : [];
    return JSON.stringify(ids.length >= 2 ? ids : []);
  }, () => "[]");
  const ids = JSON.parse(snapshot) as string[];
  const bar = nodeActionToolbarLayout({ node: { x: 0, y: 0, width: 0, height: 0 }, actions: [TIDY_ACTION] });

  useLayoutEffect(() => {
    const element = ref.current;
    const canvas = document.getElementById("bevy-canvas");
    if (!element || !canvas || ids.length === 0) return;
    const runtime = ctx.canvasRuntime;
    const layout = () => {
      const box = unionRect(ctx, ids);
      const surface = canvas.getBoundingClientRect();
      const next = box ? nodeActionToolbarLayout({
        node: { x: box.left, y: box.top, width: box.width, height: box.height }, actions: [TIDY_ACTION],
        viewport: { x: -surface.left, y: -surface.top, zoom: 1 }, surface
      }) : null;
      element.style.visibility = next ? "visible" : "hidden";
      if (!next) return;
      element.style.left = `${next.bar.x}px`;
      element.style.top = `${next.bar.y}px`;
    };
    const resize = new ResizeObserver(layout);
    resize.observe(canvas);
    const off = [runtime.subscribeViewport(layout), runtime.subscribeScene?.(layout), runtime.subscribeFrame?.(layout)];
    window.addEventListener("resize", layout);
    layout();
    return () => { resize.disconnect(); off.forEach(dispose => dispose?.()); window.removeEventListener("resize", layout); };
  }, [ctx, snapshot]);

  if (ids.length === 0 || !bar) return null;
  const tidy = () => {
    const plan = planSelectionTidy(workingCanvasOf(woohaa3CanvasStore.getState()), ids);
    const fail = (description: string) => ctx.dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "整理失败", description } });
    if (!plan.ok) return void fail(plan.reason);
    void ctx.canvasEdit.record(plan.commands, plan.label)
      .then(result => { if (!result.ok) fail(result.reason); })
      .catch(error => fail(error instanceof Error ? error.message : "提交失败"));
  };
  return <div ref={ref} className="node-action-toolbar" data-selection-toolbar
    style={{ visibility: "hidden", width: bar.bar.width, height: bar.bar.height }}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onWheel={event => event.stopPropagation()}>
    <button type="button" className="node-action-toolbar__button" title="把选中的卡片排整齐，并统一成最大卡片的尺寸"
      style={{ width: bar.actions[0]!.width }} onClick={tidy}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h18v18H3zM3 12h18M12 3v18" /></svg>
      {TIDY_ACTION.label}
    </button>
  </div>;
}
