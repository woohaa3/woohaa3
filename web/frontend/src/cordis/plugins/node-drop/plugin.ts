import type { Context, Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { nodeDrop } from "../../services/node-drop/index.js";
import { createNodeDropOverlay } from "./drop-overlay.js";
import { dropNodeDrop, type DropTargetResolution, type NodeDropTarget } from "../canvas-shell/node-drop-dispatch.js";
export const NODE_DROP_PLUGIN_ID = "node-drop";
export function nodeDropExtension(): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    const targets = () => ctx.slots.list("canvas.node-drop") as unknown as NodeDropTarget[];
    const overlay = createNodeDropOverlay(ctx.canvasRuntime);
    let currentDrag: Parameters<typeof overlay.update>[2] = null;
    let frame: number | null = null;
    let disposed = false;
    // 目标 identity 由 accepted Rust 查询固定（change: 2026-10-12 片场菱形范围，design D5）；
    // 未挂载控制器或有缺失能力时稳定 unavailable，调用方不提交移动。
    const resolveTarget = (sourceNodeIds: readonly string[], point: { x: number; y: number }): DropTargetResolution => {
      const result = ctx.canvasRuntime.queryDropTarget(point, sourceNodeIds);
      if (!result.ok) return { status: "unavailable", reason: result.reason };
      return result.value ? { status: "target", nodeId: result.value } : { status: "none" };
    };
    // 同帧合并：一帧内多次 preview 只刷新一次，并读取最新的 working/owner/viewport 状态（任务 A2.4）。
    const clear = () => {
      currentDrag = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      overlay.clear();
    };
    const refresh = () => {
      if (disposed || !currentDrag || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!disposed && currentDrag) overlay.update(ctx.canvasState.getWorkingCanvas(), targets(), currentDrag);
      });
    };
    const unsubscribeViewport = ctx.canvasRuntime.subscribeViewport(refresh);
    const unsubscribeCanvas = ctx.canvasState.subscribe(refresh);
    const unsubscribeTargets = ctx.slots.subscribe("canvas.node-drop", refresh);
    const unbind = nodeDrop.bind({
      preview: drag => { if (!drag) { clear(); return; } currentDrag = drag; refresh(); },
      drop: drag => {
        const canvas = ctx.canvasState.getWorkingCanvas();
        return canvas ? dropNodeDrop(targets(), canvas, drag.sourceNodeIds, drag.point, resolveTarget(drag.sourceNodeIds, drag.point)) : false;
      }
    });
    ctx.effect(() => () => {
      disposed = true;
      unbind(); unsubscribeViewport(); unsubscribeCanvas(); unsubscribeTargets(); clear();
    }, "node-drop-dispatch");
  }, { name: NODE_DROP_PLUGIN_ID, inject: ["canvasState", "slots", "canvasRuntime"] });
}
