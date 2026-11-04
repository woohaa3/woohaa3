import { worldCameraEditorStore, type WorldCameraEditSession } from "../../services/world-camera-editor-store.js";
import { lookCamera, moveCamera } from "./flight-motion.js";

export function releaseCameraPointer(): void {
  if (document.pointerLockElement === document.documentElement) document.exitPointerLock();
}

export function captureCameraPointer(): Promise<boolean> {
  try {
    if (!document.documentElement.requestPointerLock) return Promise.resolve(false);
    return Promise.resolve(document.documentElement.requestPointerLock()).then(
      () => document.pointerLockElement === document.documentElement, () => false
    );
  } catch { return Promise.resolve(false); }
}

/** Only active during explicit free movement. Lock loss returns to composition. */
export function attachCameraFlightInput(input: {
  session: WorldCameraEditSession;
  onExit: () => void;
  onLockChange: (locked: boolean) => void;
}): () => void {
  const keys = new Set<string>();
  let frame = 0;
  let previous = performance.now();
  let stopped = false;
  const active = () => {
    const session = worldCameraEditorStore.getSnapshot();
    return !stopped && session?.source === input.session.source && session.phase === "editing";
  };
  const locked = () => document.pointerLockElement === document.documentElement;
  const tick = (now: number) => {
    const elapsed = (now - previous) / 1000;
    previous = now;
    const current = worldCameraEditorStore.getSnapshot();
    if (active() && locked() && current) {
      const next = moveCamera(current.draft, Number(keys.has("KeyW")) - Number(keys.has("KeyS")),
        Number(keys.has("KeyD")) - Number(keys.has("KeyA")), elapsed,
        keys.has("ShiftLeft") || keys.has("ShiftRight"), Number(keys.has("KeyZ")) - Number(keys.has("KeyX")));
      if (next !== current.draft) worldCameraEditorStore.update(next);
    }
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; keys.clear(); input.onLockChange(false); releaseCameraPointer(); input.onExit();
  };
  const keydown = (event: KeyboardEvent) => {
    if (!active()) return;
    if (event.code === "Escape" || event.code === "Tab") {
      event.preventDefault(); event.stopImmediatePropagation(); stop(); return;
    }
    if (!locked()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) { keys.clear(); return; }
    event.preventDefault(); event.stopImmediatePropagation(); keys.add(event.code);
  };
  const keyup = (event: KeyboardEvent) => {
    keys.delete(event.code);
    if (active() && locked()) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const mousemove = (event: MouseEvent) => {
    if (!active() || !locked()) return;
    event.stopImmediatePropagation();
    const current = worldCameraEditorStore.getSnapshot();
    if (current) worldCameraEditorStore.update(lookCamera(current.draft, event.movementX, event.movementY));
  };
  const lockchange = () => {
    keys.clear(); input.onLockChange(locked());
    if (!locked()) stop();
  };
  const visibility = () => { if (document.visibilityState !== "visible") stop(); };
  input.onLockChange(locked());
  if (!locked()) stop();
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keyup", keyup, true);
  window.addEventListener("mousemove", mousemove, true);
  window.addEventListener("blur", stop);
  document.addEventListener("pointerlockchange", lockchange);
  document.addEventListener("visibilitychange", visibility);
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("keyup", keyup, true);
    window.removeEventListener("mousemove", mousemove, true);
    window.removeEventListener("blur", stop);
    document.removeEventListener("pointerlockchange", lockchange);
    document.removeEventListener("visibilitychange", visibility);
    releaseCameraPointer();
  };
}
