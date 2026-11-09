import { useEffect } from "react";
import type { CanvasRuntimeService } from "../../contract/canvas-runtime.js";
import type { PointHit } from "../canvas-runtime/bevy-runtime-types.js";

type PlayerHit = Extract<PointHit, { kind: "scene-area-playback" }>;

export function trackFraction(point: { x: number; y: number }, track: PlayerHit["track"]): number {
  const dx = track[2] - track[0], dy = track[3] - track[1], length = dx * dx + dy * dy;
  return length > 0 ? Math.max(0, Math.min(1,
    ((point.x - track[0]) * dx + (point.y - track[1]) * dy) / length)) : 0;
}

/** Native meshes own all visuals and hit geometry; this adapter owns only local playback input. */
export function installSceneAreaPlayback(runtime: CanvasRuntimeService, canvas: HTMLCanvasElement) {
  let scrub: { pointerId: number; nodeId: string; track: PlayerHit["track"]; resume: boolean; time: number } | null = null;
  const consume = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const hit = (event: MouseEvent): PlayerHit | null => {
    const engine = runtime.runtime(), point = runtime.clientToWorld({ x: event.clientX, y: event.clientY });
    const origin = runtime.worldToClient({ x: 0, y: 0 }), unit = runtime.worldToClient({ x: 1, y: 0 });
    if (!engine?.queryPoint || !engine.interactionGeneration || !point || !origin || !unit) return null;
    const zoom = Math.hypot(unit.x - origin.x, unit.y - origin.y);
    if (!Number.isFinite(zoom) || zoom <= 0) return null;
    const result = engine.queryPoint({ generation: engine.interactionGeneration(), ...point, zoom });
    return result.ok && result.value?.kind === "scene-area-playback" ? result.value : null;
  };
  const seek = (event: PointerEvent) => {
    if (!scrub || runtime.worldAnimationState().nodeId !== scrub.nodeId) return;
    const point = runtime.clientToWorld({ x: event.clientX, y: event.clientY });
    if (point) runtime.seekWorldAnimation(trackFraction(point, scrub.track) * runtime.worldAnimationState().duration);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || scrub) return;
    const target = hit(event);
    if (!target) return;
    consume(event);
    runtime.cancelTransientGesture();
    if (runtime.worldAnimationState().nodeId !== target.nodeId) runtime.controller()?.selectNode(target.nodeId);
    const state = runtime.worldAnimationState();
    if (state.nodeId !== target.nodeId || state.duration <= 0) return;
    if (target.control === "play") {
      if (state.playing) runtime.pauseWorldAnimation(); else runtime.playWorldAnimation();
    } else if (target.control === "loop") runtime.setWorldAnimationLoop(!state.loop);
    else if (target.control === "track") {
      scrub = { pointerId: event.pointerId, nodeId: target.nodeId, track: target.track, resume: state.playing, time: state.time };
      canvas.setPointerCapture(event.pointerId);
      seek(event);
    }
  };
  const move = (event: PointerEvent) => {
    if (scrub?.pointerId !== event.pointerId) return;
    consume(event); seek(event);
  };
  const finish = (event: PointerEvent) => {
    const session = scrub;
    if (!session || session.pointerId !== event.pointerId) return;
    consume(event);
    if (runtime.worldAnimationState().nodeId === session.nodeId) {
      if (event.type === "pointercancel") runtime.seekWorldAnimation(session.time); else seek(event);
      const next = runtime.worldAnimationState();
      if (session.resume && (next.loop || next.time < next.duration)) runtime.playWorldAnimation();
    }
    scrub = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const lost = () => { scrub = null; };
  const block = (event: MouseEvent) => { if (scrub || hit(event)) consume(event); };
  // Hovering the native player must leave trackpad pan/pinch with the canvas.
  // Freeze the viewport only while a scrub owns its accepted world-space track.
  const wheel = (event: WheelEvent) => { if (scrub) consume(event); };
  canvas.addEventListener("pointerdown", down, true);
  canvas.addEventListener("pointermove", move, true);
  canvas.addEventListener("pointerup", finish, true);
  canvas.addEventListener("pointercancel", finish, true);
  canvas.addEventListener("lostpointercapture", lost, true);
  canvas.addEventListener("wheel", wheel, { capture: true, passive: false });
  canvas.addEventListener("dblclick", block, true);
  return () => {
    const pointerId = scrub?.pointerId;
    scrub = null;
    if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    canvas.removeEventListener("pointerdown", down, true);
    canvas.removeEventListener("pointermove", move, true);
    canvas.removeEventListener("pointerup", finish, true);
    canvas.removeEventListener("pointercancel", finish, true);
    canvas.removeEventListener("lostpointercapture", lost, true);
    canvas.removeEventListener("wheel", wheel, true);
    canvas.removeEventListener("dblclick", block, true);
  };
}

export function SceneAreaProgress({ runtime }: { runtime: CanvasRuntimeService }) {
  useEffect(() => {
    let canvas: HTMLCanvasElement | null = null, dispose: (() => void) | undefined;
    const bind = () => {
      const next = document.getElementById("bevy-canvas");
      if (next === canvas) return;
      dispose?.(); canvas = next instanceof HTMLCanvasElement ? next : null;
      dispose = canvas ? installSceneAreaPlayback(runtime, canvas) : undefined;
    };
    bind();
    const observer = new MutationObserver(bind);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); dispose?.(); };
  }, [runtime]);
  return null;
}
