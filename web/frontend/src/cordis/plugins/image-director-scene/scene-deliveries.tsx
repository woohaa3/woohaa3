import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { createImageDirectorRemote, type ImageDirectorStatus } from "../../services/image-director-remote.js";
import { readWorldCamera } from "../../services/world-camera-ui.js";

/** Background delivery belongs to the created scene, independent of its source form. */
export function DirectorSceneDelivery({ ctx, canvasId, nodeId, requestId }: { ctx: Context; canvasId: string; nodeId: string; requestId: string }) {
  useEffect(() => {
    const remote = createImageDirectorRemote(ctx.applicationRemote.transport);
    let live = true, inFlight = false, complete = false, adopted = false, captured = false;
    const poll = async () => {
      if (!live || inFlight || complete) return;
      inFlight = true;
      try {
        const result = await remote.status(canvasId, requestId);
        if (!live || !result.ok || !result.data) return;
        const status = result.data as ImageDirectorStatus;
        if (status.reservation?.nodeId !== nodeId) return;
        if (status.stage === "failed" || status.stage === "cancelled") { complete = true; return; }
        if (!status.receipt || status.revision === undefined) return;
        if (!adopted) {
          const result = await ctx.canvasEdit.adoptImageDirector({ canvasId, receipt: status.receipt, revision: status.revision, allowNew: true });
          if (!live) return;
          if (result.ok) adopted = true;
          else if (result.reason !== "画布尚未同步交付结果") { complete = true; return; }
        }
        const current = workingCanvasOf(woohaa3CanvasStore.getState());
        if (current?.id !== canvasId) return;
        const camera = readWorldCamera(current, status.receipt.cameraNodeId);
        if (camera && !captured) {
          const result = await remote.refreshCapture(canvasId, camera.cameraId);
          if (!live) return;
          if (result.ok) {
            const outcome = result.data as import("@woohaa3/contracts").WorldCaptureRefreshOutcome;
            captured = !outcome.ok || outcome.status.phase !== "waiting";
          } else captured = true;
        }
        complete = adopted && captured;
      } finally { inFlight = false; }
    };
    void poll().catch(() => {});
    const timer = setInterval(() => { void poll().catch(() => {}); }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [ctx, canvasId, nodeId, requestId]);
  return null;
}

export function DirectorSceneDeliveries({ ctx, canvasId }: { ctx: Context; canvasId?: string }) {
  const state = useSyncExternalStore(woohaa3CanvasStore.subscribe, woohaa3CanvasStore.getState, woohaa3CanvasStore.getState);
  const canvas = workingCanvasOf(state);
  const targets = useMemo(() => {
    if (!canvas || (canvasId && canvas.id !== canvasId)) return [];
    return canvas.document.nodes.flatMap(node => {
      if (node.type !== "scene-area") return [];
      const generation = canvas.nodeData[node.id]?.imageDirectorGeneration;
      if (!generation || typeof generation !== "object" || Array.isArray(generation) || typeof generation.requestId !== "string") return [];
      return [{ canvasId: canvas.id, nodeId: node.id, requestId: generation.requestId }];
    });
  }, [canvas, canvasId]);
  return <>{targets.map(target => <DirectorSceneDelivery key={`${target.canvasId}:${target.nodeId}:${target.requestId}`} ctx={ctx} {...target} />)}</>;
}
