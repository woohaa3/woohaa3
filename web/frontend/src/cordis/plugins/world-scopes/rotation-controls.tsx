import type { Context } from "@deepseek-ai/cordis";
import { useSyncExternalStore } from "react";
import { decodeSceneAreaData, decodeWorldInstanceData, modelGroundAnchorLocal, storedHumanoidRig, worldModelGroundAnchor } from "@woohaa3/contracts";
import { createWorldRotationActions, type WorldRotationActions } from "./rotation-actions.js";
import { MODEL_SCENES_SERVICE, type ModelScenesProvider } from "../service-keys.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import "./rotation-controls.css";

function RotationError({ actions }: { actions: WorldRotationActions }) {
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
  return state.error ? <div className="world-rotation-error">{state.error}</div> : null;
}

/** One rotation contribution in the existing Web toolbar; downloads keep their existing owner. */
export function installWorldRotationControls(ctx: Context, canvasId: string | undefined): () => void {
  const actions = createWorldRotationActions(ctx, canvasId);
  const provider = ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined;
  let disposed = false, generation = 0, key = "";
  let availability = { nodeId: "", enabled: false };
  const invalidate = () => ctx.canvasRuntime.controller()?.invalidate("world-rotation-availability");
  const refresh = () => {
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const ids = nodeSelectionStore.getSnapshot().nodeIds;
    const nodeId = ids.length === 1 ? ids[0]! : "";
    const resource = provider?.getResources().get(nodeId);
    const nextKey = `${canvas?.id}:${canvas?.revision}:${nodeId}:${resource?.resourceKey}:${ctx.canvasSession.isWritable()}`;
    if (nextKey === key) return;
    key = nextKey;
    const current = ++generation;
    availability = { nodeId, enabled: availability.nodeId === nodeId && availability.enabled && ctx.canvasSession.isWritable() };
    invalidate();
    if (!canvas || canvas.id !== canvasId || !nodeId || !ctx.canvasSession.isWritable()) return;
    const area = decodeSceneAreaData(canvas.nodeData[nodeId]?.sceneArea);
    const instance = decodeWorldInstanceData(canvas.nodeData[nodeId]?.sharedWorldInstance);
    if (!area.ok && !instance.ok) return;
    let scopes: string[] = [];
    if (area.ok) scopes = [area.value.areaId];
    else if (instance.ok) {
      if (!resource) { availability = { nodeId, enabled: false }; invalidate(); return; }
      const rig = storedHumanoidRig(canvas.nodeData[nodeId]?.modelRig);
      const local = modelGroundAnchorLocal(resource.ops, rig.ok ? rig.value : null);
      if (!local) { availability = { nodeId, enabled: false }; invalidate(); return; }
      const anchor = worldModelGroundAnchor(local, instance.value.transform);
      scopes = canvas.document.nodes.flatMap(node => {
        const candidate = decodeSceneAreaData(canvas.nodeData[node.id]?.sceneArea);
        if (!candidate.ok) return [];
        const { min, max } = candidate.value.bounds;
        return anchor.u >= min.u - 0.05 && anchor.u <= max.u + 0.05 && anchor.v >= min.v - 0.05 && anchor.v <= max.v + 0.05
          ? [candidate.value.areaId] : [];
      });
    }
    if (!scopes.length) { availability = { nodeId, enabled: true }; invalidate(); return; }
    void Promise.all(scopes.map(areaId => ctx.canvasRemote.prepareSceneArea({ canvasId: canvas.id, areaId })))
      .then(results => {
        if (disposed || generation !== current) return;
        const enabled = results.every(result => {
          if (!result.ok || result.snapshot.occupancy.state === "unknown") return false;
          if (area.ok) return result.snapshot.occupancy.state === "idle";
          return !result.snapshot.occupancy.locks.some(lock => lock.target.kind === "instance" && instance.ok && lock.target.instanceId === instance.value.instanceId);
        });
        availability = { nodeId, enabled }; invalidate();
      }).catch(() => { if (!disposed && generation === current) { availability = { nodeId, enabled: false }; invalidate(); } });
  };
  const offAction = ctx.slots.register("canvas.node-action", {
    id: "world-rotate-clockwise", owner: "world-scopes", order: 15,
    describe: ({ nodeId, writable }) => {
      const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
      if (!decodeSceneAreaData(canvas?.nodeData[nodeId]?.sceneArea).ok && !decodeWorldInstanceData(canvas?.nodeData[nodeId]?.sharedWorldInstance).ok) return null;
      return { label: "旋转 90°", icon: "rotate-clockwise", iconOnly: true,
        enabled: writable && availability.nodeId === nodeId && availability.enabled };
    },
    activate: ({ nodeId, writable }) => {
      if (writable && availability.nodeId === nodeId && availability.enabled) actions.rotate(nodeId);
    }
  });
  const offOverlay = ctx.slots.register("canvas.overlay", {
    id: "world-rotation-error", owner: "world-scopes", priority: 27,
    render: () => <RotationError actions={actions} />
  });
  const off = [nodeSelectionStore.subscribe(refresh), woohaa3CanvasStore.subscribe(refresh),
    ctx.canvasSession.subscribe(refresh), provider?.subscribe(refresh)];
  // Leases may change without a document revision (e.g. a run just finished).
  const timer = setInterval(() => { key = ""; refresh(); }, 3000);
  refresh();
  return () => { disposed = true; generation++; clearInterval(timer); off.forEach(stop => stop?.()); offAction(); offOverlay(); actions.dispose(); };
}
