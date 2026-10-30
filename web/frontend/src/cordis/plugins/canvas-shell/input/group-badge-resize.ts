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
  const data = canvas.nodeData[nodeId] ?? null;
  // 手势只关心它要写的那个字段：group 矩形会随成员变化（片段预览换尺寸等）而重算，
  // 把它算进签名会让一次正常的徽标拖动被成员更新打断，松手后倍率悄悄退回原值。
  return {data, signature: JSON.stringify([data?.groupCollapsed ?? false, data?.groupBadgeScale ?? null])};
}

/** 以中点为中心、沿对角方向的向量投影，仅有一个倍率；拖动不提交规范状态。 */
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
    // 水平中心固定，右下角手柄到中心的半对角线随倍率伸缩；指针沿对角线移动 d 时
    // 倍率变化 d/|半对角线|，手柄始终贴着指针。
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
      // 前置条件只锁定本次要写的倍率：手势期间若只改了其它 nodeData 字段（片段/媒体同步），
      // 用当前快照提交即可，不能因为无关字段变了就丢掉用户这一次拖动。
      const latest = currentSource(gesture.nodeId)?.data ?? gesture.sourceNodeData;
      void Promise.resolve(core.submit([{type:"nodeData.patch",nodeId:gesture.nodeId,
        value:{groupBadgeScale:gesture.scale},expectedNodeData:{[gesture.nodeId]:latest}}]))
        .then(result => { if (result === "rejected") core.options.onInteractionError?.(new Error("徽标尺寸未能保存，请重试")); })
        .catch(error => core.options.onInteractionError?.(error));
    } finally { cancel(); }
    return true;
  };
  return {down, move, up, cancel};
}
