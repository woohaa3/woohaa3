import type { Context } from "@deepseek-ai/cordis";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";

export type DirectorSceneSelectionIntent = { accept: (nodeId: string) => void; cancel: () => void };

/** One local creation intent; never restored from a source image or a scene's execution state. */
export function beginDirectorSceneSelection(ctx: Context, canvasId: string): DirectorSceneSelectionIntent {
  const selectionKey = () => {
    const { nodeIds, primaryNodeId } = nodeSelectionStore.getSnapshot();
    return JSON.stringify([nodeIds, primaryNodeId]);
  };
  const initialSelection = selectionKey();
  let modeKey = JSON.stringify(ctx.canvasNavigation.getSnapshot().mode);
  let nodeId: string | null = null;
  let active = true;
  let frame: number | null = null;
  const disposers: (() => void)[] = [];
  const cancel = () => {
    active = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    disposers.splice(0).forEach(dispose => dispose());
  };
  const reconcile = () => {
    if (!active) return;
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    if (canvas?.id !== canvasId || selectionKey() !== initialSelection
      || JSON.stringify(ctx.canvasNavigation.getSnapshot().mode) !== modeKey) { cancel(); return; }
    if (!nodeId || !canvas.document.nodes.some(node => node.id === nodeId && node.type === "scene-area")) return;
    if (frame !== null) return;
    // Let the canvas projection reach the interaction controller before selecting.
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!active) return;
      const mode = ctx.canvasNavigation.getSnapshot().mode;
      if (mode.type === "node-focus") {
        // Update the expected mode before the synchronous navigation notification.
        modeKey = JSON.stringify({ type: "overview" });
        if (!ctx.canvasNavigation.exitNodeFocus().ok) { cancel(); return; }
      }
      if (ctx.canvasRuntime.controller()?.selectNode(nodeId!)) cancel();
      else reconcile();
    });
  };
  disposers.push(woohaa3CanvasStore.subscribe(reconcile), nodeSelectionStore.subscribe(reconcile), ctx.canvasNavigation.subscribe(reconcile));
  return { accept: id => { nodeId = id; reconcile(); }, cancel };
}
