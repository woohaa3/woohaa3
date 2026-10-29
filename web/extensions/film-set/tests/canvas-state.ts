import type { ServerCanvas } from "@woohaa3/contracts";
import type { HoverPlaybackSnapshot, HoverPlaybackTarget } from "@woohaa3/frontend/extension-api";
/** Scope-local IO fixture; no production store or page singleton participates. */
export function createTestCanvasState() {
  const listeners = new Set<() => void>();
  let canvas: ServerCanvas | null = null;
  const publish = (next: ServerCanvas | null) => { canvas = next; for (const listener of listeners) listener(); };
  const facade = {
    getCanvas: () => canvas, getWorkingCanvas: () => canvas,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  return {
    facade,
    getState: () => ({ canvas, workingCanvas: canvas, applyRemoteCanvas: publish }),
    setState: (state: { canvas: ServerCanvas | null }) => publish(state.canvas)
  };
}

/**
 * hover 存储 fixture（change: 2026-10-15-add-film-set-shooting-shot-previews，任务 6.1/6.2）。
 *
 * 与生产同类：只承载 typed 拍摄播放目标（`{ kind:"shot-preview", previewNodeId, ownerNodeId,
 * entityId }`）；同目标重复发布不通知（不重置 hover 截止点），`blocked` 变化照常发布。
 */
export function createTestHoverState() {
  let nodeId: string | null = null;
  let playback: HoverPlaybackSnapshot = { target: null, blocked: false, epoch: 0 };
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const sameTarget = (a: HoverPlaybackTarget, b: HoverPlaybackTarget) =>
    a === b || (a !== null && b !== null
      && a.previewNodeId === b.previewNodeId
      && a.ownerNodeId === b.ownerNodeId
      && a.entityId === b.entityId);
  const setNodeId = (next: string | null) => { nodeId = next; playback = { ...playback, target: null }; notify(); };
  const setPlaybackTarget = (target: HoverPlaybackTarget, blocked = false) => {
    const next = blocked ? null : target;
    if (sameTarget(playback.target, next) && playback.blocked === blocked) return;
    playback = { target: next, blocked, epoch: playback.epoch + 1 };
    notify();
  };
  return {
    getPlaybackSnapshot: () => playback,
    getNodeId: () => nodeId,
    setNodeId,
    setPlaybackTarget,
    reset: () => { nodeId = null; playback = { target: null, blocked: false, epoch: 0 }; notify(); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}
