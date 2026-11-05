import type { Context } from "@deepseek-ai/cordis";
import { decodeSceneAreaData, type ScreenRect } from "@woohaa3/contracts";
import { PauseIcon, PlayIcon, RefreshIcon } from "@woohaa3/ui/icons";
import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type PointerEvent } from "react";
import type { CanvasRuntimeService } from "../../contract/canvas-runtime.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import "./scene-area-timeline.css";

/** One horizontal player, outside the title or directly above the open execution panel. */
export function timelinePlacement(canvas: ScreenRect, title: ScreenRect, panel: ScreenRect | null,
  width: number, height: number): { left: number; top: number } | null {
  const right = canvas.left + canvas.width, bottom = canvas.top + canvas.height;
  if (!panel && (title.left + title.width < canvas.left || title.left > right || title.top + title.height < canvas.top || title.top > bottom)) return null;
  const anchor = panel ?? title;
  const left = Math.max(canvas.left + 12, Math.min(anchor.left + anchor.width / 2 - width / 2, right - width - 12));
  const abovePanel = panel ? panel.top - height - 8 : 0;
  const preferred = panel ? abovePanel >= canvas.top + 12 ? abovePanel : panel.top + panel.height + 8
    : title.top + title.height + 10;
  return { left, top: Math.max(canvas.top + 12, Math.min(preferred, bottom - height - 12)) };
}

export function SceneAreaTimeline({ ctx, canvasId }: { ctx: Context; canvasId: string | undefined }) {
  const canvas = useSyncExternalStore(woohaa3CanvasStore.subscribe,
    () => workingCanvasOf(woohaa3CanvasStore.getState()), () => null);
  const selection = useSyncExternalStore(nodeSelectionStore.subscribe, nodeSelectionStore.getSnapshot, nodeSelectionStore.getSnapshot);
  const nodeId = canvas?.id === canvasId && selection.nodeIds.length === 1 ? selection.primaryNodeId : null;
  const area = decodeSceneAreaData(nodeId ? canvas?.nodeData[nodeId]?.sceneArea : undefined);
  if (!nodeId || !area.ok || !area.value.animationScript) return null;
  return <Timeline key={nodeId} runtime={ctx.canvasRuntime} nodeId={nodeId} />;
}

function Timeline({ runtime, nodeId }: { runtime: CanvasRuntimeService; nodeId: string }) {
  const state = useSyncExternalStore(runtime.subscribeWorldAnimation, runtime.worldAnimationState, runtime.worldAnimationState);
  const ref = useRef<HTMLDivElement>(null);
  const scrub = useRef<{ pointerId: number; resume: boolean; time: number } | null>(null);
  const valid = state.nodeId === nodeId && state.duration > 0;
  const progress = valid ? state.time / state.duration : 0;

  useEffect(() => {
    const element = ref.current;
    const canvas = document.getElementById("bevy-canvas");
    if (!element || !canvas) return;
    let panel: HTMLElement | undefined;
    const resize = new ResizeObserver(() => layout());
    const panelChanges = new MutationObserver(() => layout());
    const layout = () => {
      const title = runtime.nodeScreenRect(nodeId, "scope-title");
      const panelRect = panel?.isConnected && getComputedStyle(panel).visibility !== "hidden" && getComputedStyle(panel).display !== "none"
        ? panel.getBoundingClientRect() : null;
      const placement = title ? timelinePlacement(canvas.getBoundingClientRect(), title, panelRect,
        element.offsetWidth, element.offsetHeight) : null;
      const visibility = placement ? "visible" : "hidden";
      if (element.style.visibility !== visibility) element.style.visibility = visibility;
      if (placement) {
        const left = `${placement.left}px`, top = `${placement.top}px`;
        if (element.style.left !== left) element.style.left = left;
        if (element.style.top !== top) element.style.top = top;
      }
    };
    const findPanel = () => {
      const next = [...document.querySelectorAll<HTMLElement>(".node-execution-dock")].find(item => item.dataset.nodeId === nodeId);
      if (next !== panel) {
        if (panel) resize.unobserve(panel);
        panelChanges.disconnect();
        panel = next;
        if (panel) {
          resize.observe(panel);
          panelChanges.observe(panel, { attributes: true, attributeFilter: ["class", "style"] });
        }
      }
      layout();
    };
    resize.observe(canvas);
    resize.observe(element);
    const mutations = new MutationObserver(findPanel);
    mutations.observe(canvas.closest(".app") ?? document.body, { childList: true, subtree: true });
    const disposeViewport = runtime.subscribeViewport(layout);
    const disposeScene = runtime.subscribeScene?.(layout);
    const disposeFrame = runtime.subscribeFrame?.(layout);
    window.addEventListener("resize", layout);
    findPanel();
    return () => {
      resize.disconnect(); mutations.disconnect(); panelChanges.disconnect(); disposeViewport(); disposeScene?.(); disposeFrame?.();
      window.removeEventListener("resize", layout);
    };
  }, [runtime, nodeId]);

  const seek = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width > 0) runtime.seekWorldAnimation(Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * state.duration);
  };
  const finishScrub = (event: PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const session = scrub.current;
    if (!session || session.pointerId !== event.pointerId) return;
    scrub.current = null;
    if (cancel) runtime.seekWorldAnimation(session.time);
    else seek(event);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const current = runtime.worldAnimationState();
    if (session.resume && current.nodeId === nodeId && (current.loop || current.time < current.duration)) runtime.playWorldAnimation();
  };
  return (
    <div ref={ref} className="scene-area-timeline" data-node-id={nodeId}
      style={{ visibility: "hidden", "--timeline-progress": progress } as CSSProperties}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <button type="button" className="scene-area-timeline__button" disabled={!valid}
        title={state.playing ? "暂停动画" : state.time >= state.duration ? "从头播放" : "播放动画"}
        onClick={() => state.playing ? runtime.pauseWorldAnimation() : runtime.playWorldAnimation()}>
        {state.playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
      </button>
      <div className="scene-area-timeline__track" data-timeline-track="" title="点击或拖动定位"
        onPointerDown={event => {
          if (!valid || event.button !== 0 || scrub.current) return;
          event.preventDefault(); event.stopPropagation();
          const current = runtime.worldAnimationState();
          if (current.nodeId !== nodeId) return;
          scrub.current = { pointerId: event.pointerId, resume: current.playing, time: current.time };
          event.currentTarget.setPointerCapture(event.pointerId);
          seek(event);
        }}
        onPointerMove={event => { if (scrub.current?.pointerId === event.pointerId) seek(event); }}
        onPointerUp={event => finishScrub(event, false)} onPointerCancel={event => finishScrub(event, true)}
        onLostPointerCapture={() => {
          // Interrupted scrubbing stays paused; never resume a newly selected director.
          scrub.current = null;
        }}>
        <span className="scene-area-timeline__fill" />
        <span className="scene-area-timeline__head" />
      </div>
      <span className="scene-area-timeline__time">{state.time.toFixed(1)} / {state.duration.toFixed(1)}s</span>
      <button type="button" disabled={!valid} className={`scene-area-timeline__button${state.loop ? " is-active" : ""}`}
        title={state.loop ? "关闭循环" : "循环播放"} onClick={() => runtime.setWorldAnimationLoop(!state.loop)}>
        <RefreshIcon size={16} />
      </button>
    </div>
  );
}
