import { clampGroupBadgeScale, groupBadgeRect, type CanvasNodeData } from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../../services/canvas-state/index.js";
import { sharedCanvasNodeIndex } from "../canvas-node-index.js";
import type { HitTarget, Point } from "../hit-test.js";
import type { InteractionCore } from "../interaction-core.js";

export type GroupBadgeResizeGesture = {
  kind: "group-badge-resize";
  pointerId: number;
  nodeId: string;
  start: Point;
  startScreen: Point;
  center: Point;
  vector: Point;
  originScale: number;
  maxScale: number;
  scale: number;
  sourceSignature: string;
  sourceNodeData: CanvasNodeData | null;
  moved: boolean;
};

function currentSource(nodeId: string) {
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
  const index = sharedCanvasNodeIndex(canvas);
  if (!canvas || !index || index.byId.get(nodeId)?.type !== "group" || index.hiddenNodeIds.has(nodeId)) return null;
  const rect = index.groupBounds.find(group => group.id === nodeId);
  const data = canvas.nodeData[nodeId] ?? null;
  return {data, signature: JSON.stringify([rect, data?.groupCollapsed ?? false, data?.groupBadgeScale ?? null])};
}

/** 同一中点的对角向量投影，仅有一个倍率；拖动不提交规范状态。 */
export function createGroupBadgeResize(core: InteractionCore) {
  const cancel = () => {
    const gesture = core.state.gesture;
    if (gesture.kind !== "group-badge-resize") return;
    core.state.gesture = {kind: "none"};
    try { core.canvas.releasePointerCapture?.(gesture.pointerId); } catch { /* 已释放。 */ }
    core.schedule();
  };
  const valid = (gesture: GroupBadgeResizeGesture) => core.writable() && !core.modalActive()
    && currentSource(gesture.nodeId)?.signature === gesture.sourceSignature;
  const down = (event: PointerEvent, hit: HitTarget | null) => {
    if (event.button !== 0 || hit?.kind !== "node-action" || hit.actionId !== "group-resize-badge") return false;
    event.preventDefault();
    if (!core.writable() || core.modalActive()) return true;
    const source = currentSource(hit.nodeId);
    const node = core.renderedNode?.(hit.nodeId) ?? core.buildScene()?.nodes.find(node => node.id === hit.nodeId);
    if (!source || !node?.group?.badgeResizable) return true;
    const badge = groupBadgeRect(node, node.group.badgeScale);
    core.setSelection([hit.nodeId]);
    core.state.gesture = {kind:"group-badge-resize",pointerId:event.pointerId,nodeId:hit.nodeId,
      start:core.pointerWorld(event), startScreen:{x:event.clientX,y:event.clientY}, center:badge.center,
      vector:{x:badge.width/2,y:badge.height/2}, originScale:badge.scale,maxScale:badge.maxScale,
      scale:badge.scale,sourceSignature:source.signature,sourceNodeData:structuredClone(source.data),moved:false};
    core.canvas.setPointerCapture?.(event.pointerId);
    core.schedule();
    return true;
  };
  const update = (event: PointerEvent, gesture: GroupBadgeResizeGesture) => {
    const world = core.pointerWorld(event);
    const {vector, start} = gesture;
    // Pointer delta starts at the pressed point, so the fixed handle inset cannot cause a jump.
    const ratio = 1 + ((world.x-start.x)*vector.x + (world.y-start.y)*vector.y)
      / (vector.x*vector.x + vector.y*vector.y);
    gesture.scale = Math.min(gesture.maxScale, clampGroupBadgeScale(gesture.originScale * ratio));
    if (Math.hypot(event.clientX-gesture.startScreen.x,event.clientY-gesture.startScreen.y)>3) gesture.moved=true;
  };
  const move = (event: PointerEvent) => {
    const gesture = core.state.gesture;
    if (gesture.kind !== "group-badge-resize") return false;
    event.preventDefault();
    if (gesture.pointerId !== event.pointerId) return true;
    if (!valid(gesture)) { cancel(); return true; }
    update(event, gesture);
    core.schedule();
    return true;
  };
  const up = (event: PointerEvent) => {
    const gesture = core.state.gesture;
    if (gesture.kind !== "group-badge-resize") return false;
    if (gesture.pointerId !== event.pointerId) return true;
    event.preventDefault();
    try {
      if (!valid(gesture)) return true;
      update(event, gesture);
      if (!gesture.moved || Math.abs(gesture.scale-gesture.originScale)<0.0001) return true;
      void Promise.resolve(core.submit([{type:"nodeData.patch",nodeId:gesture.nodeId,
        value:{groupBadgeScale:gesture.scale},expectedNodeData:{[gesture.nodeId]:gesture.sourceNodeData}}]))
        .then(result => { if (result === "rejected") core.options.onInteractionError?.(new Error("徽标尺寸未能保存，请重试")); })
        .catch(error => core.options.onInteractionError?.(error));
    } finally { cancel(); }
    return true;
  };
  return {down, move, up, cancel};
}
