/// <reference types="vite/client" />
import type { InteractionCore } from "./interaction-core.js";

const EVENT_TYPES = ["pointerdown", "pointerup", "pointercancel", "wheel", "dblclick", "contextmenu"] as const;
const MAX_EVENTS = 64;

/** In-memory input mirror for manual/E2E troubleshooting. Records rejected input too. */
export function installInputDiagnostics(
  core: InteractionCore,
  renderError: () => string | null,
  queryCounters: () => { queries: number; unavailableQueries: number }
): () => void {
  if (!import.meta.env.DEV) return () => {};
  const read = () => Object.freeze({
    canvasBlocked: core.modalActive(),
    focusBlocked: core.focusInputBlocked(),
    modelFocused: core.model.active,
    imageFocused: core.options.isImageFocused?.() ?? !!core.options.getImageFocus?.(),
    videoFocused: core.options.isVideoFocused?.() ?? !!core.options.getVideoFocus?.(),
    writable: core.writable(),
    gesture: core.state.gesture.kind,
    pointerId: "pointerId" in core.state.gesture ? core.state.gesture.pointerId : null,
    generation: core.options.getRuntime()?.interactionGeneration?.() ?? null,
    viewport: Object.freeze({ ...core.activeViewport() }),
    ...queryCounters(),
    renderError: renderError()?.slice(0, 512) ?? null
  });
  type Snapshot = ReturnType<typeof read>;
  type Entry = Readonly<{
    type: string; time: number; x: number; y: number; button: number;
    before: Snapshot; after?: Snapshot;
  }>;
  const entries: Entry[] = [];
  const unsettled = new Set<Entry>();
  const byEvent = new WeakMap<Event, Entry>();
  const timers = new Map<Entry, ReturnType<typeof setTimeout>>();
  let disposed = false;
  const settle = (entry: Entry) => {
    if (disposed || !unsettled.delete(entry)) return;
    clearTimeout(timers.get(entry));
    timers.delete(entry);
    try {
      const index = entries.indexOf(entry);
      if (index >= 0) entries[index] = Object.freeze({ ...entry, after: read() });
    } catch { /* Keep the captured state. */ }
  };
  const observe = (event: Event) => {
    try {
      const mouse = event as MouseEvent;
      const entry: Entry = Object.freeze({ type: event.type, time: Date.now(),
        x: mouse.clientX, y: mouse.clientY, button: mouse.button, before: read() });
      entries.push(entry);
      unsettled.add(entry);
      byEvent.set(event, entry);
      if (entries.length > MAX_EVENTS) entries.shift();
      // Browser-generated events can run microtasks BETWEEN capture and target
      // listeners. Settle after the controller listener, with a task fallback
      // for stopImmediatePropagation, instead of calling queueMicrotask here.
      timers.set(entry, setTimeout(() => settle(entry), 0));
    } catch { /* Diagnostics cannot interrupt input. */ }
  };
  const afterInput = (event: Event) => {
    try { const entry = byEvent.get(event); if (entry) settle(entry); } catch { /* Diagnostic isolation. */ }
  };
  const hooks = core.target as unknown as Record<string, unknown>;
  const mirror = { snapshot: () => ({ current: read(), events: entries.slice() }) };
  hooks.__canvasInputDiagnostics = mirror;
  for (const type of EVENT_TYPES) {
    core.canvas.addEventListener(type, observe, true);
    core.canvas.addEventListener(type, afterInput);
  }
  return () => {
    unsettled.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    disposed = true;
    for (const type of EVENT_TYPES) {
      core.canvas.removeEventListener(type, observe, true);
      core.canvas.removeEventListener(type, afterInput);
    }
    if (hooks.__canvasInputDiagnostics === mirror) delete hooks.__canvasInputDiagnostics;
  };
}
