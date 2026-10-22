const EVENTS = new Set(["pointerdown", "pointerup", "pointercancel", "wheel", "dblclick", "contextmenu"]);
const GESTURES = new Set(["none", "history-press", "model-preview", "pan", "right-press", "drag", "resize", "connect", "aggregate-connect", "marquee"]);
const FLAGS = ["canvasBlocked", "focusBlocked", "modelFocused", "imageFocused", "videoFocused", "writable"];
const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const count = value => finite(value) && Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error("invalid canvas input diagnostics"); };

function state(value) {
  if (!value || !FLAGS.every(key => typeof value[key] === "boolean") || !GESTURES.has(value.gesture)
    || !(value.pointerId === null || (finite(value.pointerId) && Number.isSafeInteger(value.pointerId)))
    || !(value.generation === null || count(value.generation))
    || !count(value.queries) || !count(value.unavailableQueries)
    || !value.viewport || ![value.viewport.x, value.viewport.y, value.viewport.zoom].every(finite)
    || value.viewport.zoom <= 0 || !(value.renderError === null || typeof value.renderError === "string")) invalid();
  return { ...Object.fromEntries(FLAGS.map(key => [key, value[key]])), gesture: value.gesture,
    pointerId: value.pointerId, generation: value.generation, queries: value.queries,
    unavailableQueries: value.unavailableQueries,
    viewport: { x: value.viewport.x, y: value.viewport.y, zoom: value.viewport.zoom },
    renderError: value.renderError?.slice(0, 512) ?? null };
}

/** Fixed schema and server-owned path, shared by browser and native WebView. */
export function validateCanvasInputBatch(batch) {
  if (!batch || !/^[\w-]{1,80}$/.test(batch.recorderId ?? "") || typeof batch.recorderId !== "string"
    || !count(batch.sequence) || !count(batch.dropped) || typeof batch.pageLoadId !== "string"
    || batch.pageLoadId.length > 128 || !["native", "wasm"].includes(batch.runtime)
    || !Array.isArray(batch.samples) || batch.samples.length > 16) invalid();
  const samples = batch.samples.map(value => {
    if (!value || !EVENTS.has(value.type) || !count(value.time)
      || ![value.x, value.y, value.button].every(finite) || !Number.isSafeInteger(value.button)) invalid();
    return { type: value.type, time: value.time, x: value.x, y: value.y, button: value.button,
      before: state(value.before), ...(value.after !== undefined ? { after: state(value.after) } : {}) };
  });
  return { category: "canvas-input", recorderId: batch.recorderId, sequence: batch.sequence,
    dropped: batch.dropped, pageLoadId: batch.pageLoadId, runtime: batch.runtime, samples };
}
