import { FrameChannel, captureGeometry } from "./frame-channel.js";

const PREFERENCES_KEY = "photocraft.preferences";
const LIGHT_DEFAULT_MARKER = "photocraft.integration-light-default-v1";

/**
 * Integrated PhotoCraft starts on its light appearance. Seed a missing preference set, and migrate
 * the old default (dark Pro Medium) once; an explicit non-default theme remains the user's choice.
 */
export function seedDefaultPreferences(storage) {
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return;
    const raw = storage.getItem(PREFERENCES_KEY);
    if (raw === null) {
      storage.setItem(PREFERENCES_KEY, JSON.stringify({ interface: { appearanceMode: "light", lightTheme: "proLight" } }));
      storage.setItem(LIGHT_DEFAULT_MARKER, "1");
      return;
    }
    if (storage.getItem(LIGHT_DEFAULT_MARKER)) return;
    let preferences;
    try { preferences = JSON.parse(raw); }
    catch { return; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return;
    const current = preferences.interface;
    const ui = current && typeof current === "object" && !Array.isArray(current) ? current : {};
    const oldDefault = ui.appearanceMode === undefined
      || (ui.appearanceMode === "dark" && (ui.darkTheme === undefined || ui.darkTheme === "proMedium"));
    if (oldDefault) {
      preferences.interface = { ...ui, appearanceMode: "light", lightTheme: ui.lightTheme ?? "proLight" };
      storage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    }
    storage.setItem(LIGHT_DEFAULT_MARKER, "1");
  } catch {
    // Storage can be unavailable (privacy modes); PhotoCraft then uses its own defaults.
  }
}

/** Direct instance port. No globals are installed until createRuntime is called. */
export async function createRuntime({ canvas, assetBaseUrl, onEvent }, loadModule = url => import(url)) {
  seedDefaultPreferences();
  const base = new URL(assetBaseUrl, location.href);
  const photocraft = await loadModule(new URL("photocraft-web.js", base).href);
  await photocraft.default({ module_or_path: new URL("photocraft-web_bg.wasm", base) });
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true,
    preserveDrawingBuffer: true, antialias: false, depth: true, stencil: false });
  if (!gl?.getContextAttributes()?.preserveDrawingBuffer) throw new Error("需要支持画面捕获的 WebGL2 浏览器，请启用硬件加速后重试");
  await photocraft.runtime_create(canvas, base.href);
  photocraft.runtime_presentation(false, false);
  let disposed = false, visible = false, focused = false, input = false, contextLost = false;
  const announced = new Map();
  let activeDocument = null, preparedDocument = null;
  let interactingUntil = 0, lastState = "", previous = null, raf = 0, generation = 0;
  const lifecycle = new AbortController(), channel = new FrameChannel();
  const state = () => {
    const snapshot = JSON.parse(photocraft.overlay_state() || "{}");
    const actual = JSON.parse(photocraft.runtime_documents());
    const active = actual.documents.find(doc => doc.id === actual.documentId);
    if (actual.documentId !== snapshot.documentId || (active && active.revision !== snapshot.revision)) {
      return { ...snapshot, ...actual, revision: active?.revision ?? null, rect: null, documentView: null, viewReady: false };
    }
    return { ...snapshot, ...actual };
  };
  const post = (event) => { if (!disposed) onEvent(event); };
  const listen = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal: lifecycle.signal });
  async function capture(snapshot) {
    const geometry = captureGeometry(canvas, snapshot.rect);
    if (!geometry) return null;
    const { x, y, width, height, outWidth, outHeight } = geometry;
    const bitmap = await createImageBitmap(canvas, x, y, width, height,
      { resizeWidth: outWidth, resizeHeight: outHeight, resizeQuality: "high" });
    const off = document.createElement("canvas");
    off.width = outWidth; off.height = outHeight;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    try {
      if (!ctx) throw new Error("无法读取编辑器画面");
      ctx.drawImage(bitmap, 0, 0);
      return { width: outWidth, height: outHeight, buffer: ctx.getImageData(0, 0, outWidth, outHeight).data.buffer };
    } finally { bitmap.close(); }
  }

  function samePixels(a, b) {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function tick(now) {
    raf = 0;
    if (disposed || !visible) return;
    raf = requestAnimationFrame(tick);
    let snapshot;
    try { snapshot = state(); }
    catch (error) {
      visible = false; input = false; generation++; channel.paused = true; cancelAnimationFrame(raf); raf = 0;
      post({ type: "photocraft:error", fatal: true, message: `PhotoCraft 运行已中断：${String(error)}。内存工程可能无法导出；请先尝试下载，重新加载会丢失所有未保存文档。` }); return;
    }
    const serialized = JSON.stringify(snapshot);
    for (const doc of snapshot.documents) {
      const old = announced.get(doc.id);
      if (!old) post({ type: "photocraft:document-opened", documentId: doc.id, document: doc });
      else if (old.revision !== doc.revision || old.dirty !== doc.dirty || old.name !== doc.name) post({ type: "photocraft:document-changed", documentId: doc.id, document: doc });
      announced.set(doc.id, doc);
    }
    for (const id of announced.keys()) if (!snapshot.documents.some(doc => doc.id === id)) {
      announced.delete(id); post({ type: "photocraft:document-closed", documentId: id });
    }
    if (activeDocument !== snapshot.documentId) { activeDocument = snapshot.documentId; post({ type: "photocraft:document-activated", documentId: activeDocument }); }

    if (serialized !== lastState) { lastState = serialized; post({ type: "photocraft:state", state: snapshot }); }
    for (const request of JSON.parse(photocraft.runtime_requests())) post({ type: "photocraft:document-request", ...request });
    // Initial Fit must finish before reveal. Later zoom animations are valid frames.
    if (snapshot.viewReady) preparedDocument = snapshot.documentId;
    if (contextLost || document.hidden || !focused || preparedDocument !== snapshot.documentId || !snapshot.rect || !snapshot.documentId || !channel.canCapture(now, now < interactingUntil || !snapshot.viewReady)) return;
    channel.start(now); const token = generation;
    void capture(snapshot).then((frame) => {
      channel.busy = false; const current = state();
      if (disposed || token !== generation || !visible || contextLost || !frame || channel.paused || document.hidden
        || current.documentId !== snapshot.documentId || current.revision !== snapshot.revision || String(current.rect) !== String(snapshot.rect)) return;
      // createImageBitmap snapshots the pixels at invocation. Keep their matching
      // camera/rectangle even when the next animation step has already rendered.
      const pixels = new Uint8Array(frame.buffer);
      const key = `${snapshot.documentId}:${snapshot.rect}:${JSON.stringify(snapshot.documentView)}`;
      if (previous?.key === key && samePixels(previous.pixels, pixels)) return;
      previous = { key, pixels: pixels.slice() };
      const id = channel.sent(performance.now());
      post({ type: "photocraft:frame", ...frame, id, generation: token, rect: snapshot.rect,
        documentId: snapshot.documentId, revision: snapshot.revision, documentView: snapshot.documentView });
    }).catch((error) => { channel.busy = false; channel.paused = true; post({ type: "photocraft:error", message: String(error) }); });
  }
  const owns = (event) => canvas.parentElement?.contains(event.target);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "keydown"]) {
    listen(canvas, type, () => { interactingUntil = performance.now() + 200; }, { passive: true });
  }
  listen(window, "keydown", (event) => {
    if (!visible || !input || !canvasFocused || !owns(event) || event.key !== "Escape" || event.isComposing || event.repeat || state().escOwned) return;
    event.preventDefault(); event.stopImmediatePropagation(); post({ type: "photocraft:escape" });
  }, { capture: true });
  listen(canvas, "webglcontextlost", (event) => { event.preventDefault(); contextLost = true; generation++; previous = null; post({ type: "photocraft:error", message: "图形连接已中断，本地文档仍保留。恢复后可继续；请先尝试保存工程。" }); });
  listen(canvas, "webglcontextrestored", () => { contextLost = false; generation++; previous = null; channel.pending = null; });
  const presentation = () => photocraft.runtime_presentation(visible && !document.hidden, input && canvasFocused && visible && !document.hidden);
  listen(document, "visibilitychange", presentation);
  let canvasFocused = true;
  listen(document, "focusin", event => { canvasFocused = owns(event); presentation(); });
  listen(window, "blur", () => { canvasFocused = false; presentation(); });
  listen(canvas, "pointerdown", () => { canvasFocused = true; presentation(); }, { capture: true });
  const focus = () => {
    if (disposed || !visible || !input || document.hidden) return;
    // Keep egui's IME/text agent focused when it already owns input.
    if (!canvas.parentElement?.contains(document.activeElement)) canvas.focus({ preventScroll: true });
    canvasFocused = canvas.parentElement?.contains(document.activeElement) ?? false;
    presentation();
  };
  return {
    state,
    focus,
    show(clean = true) { visible = true; focused = clean; lastState = ""; generation++; previous = null; preparedDocument = null; channel.paused = false;
      photocraft.overlay_set_capture_clean(clean); input = true; presentation(); if (!raf) raf = requestAnimationFrame(tick); return generation; },
    hide() { visible = false; input = false; generation++; previous = null; channel.pending = null;
      cancelAnimationFrame(raf); raf = 0; presentation(); },
    input(enabled) { input = enabled; presentation(); },
    open(operationId, name, bytes) {
      const id = photocraft.runtime_open(operationId, name, bytes);
      const doc = state().documents.find(doc => doc.id === id);
      if (doc) announced.set(id, doc);
      post({ type: "photocraft:document-opened", operationId, documentId: id, document: doc }); return id;
    },
    activate(id) { generation++; previous = null; preparedDocument = null; photocraft.runtime_activate(id); return generation; },
    close(id) { photocraft.runtime_close(id); },
    export(id, project = false) { return photocraft.runtime_export(id, project); },
    ack(id, accepted) { if (!accepted) previous = null; channel.ack(id); },
    settle() { const s = state(); if (s.operation || s.modal) throw new Error("请先确认或取消 PhotoCraft 中的当前操作"); return s; },
    dispose() { if (disposed) return; disposed = true; visible = false; generation++; cancelAnimationFrame(raf); lifecycle.abort(); photocraft.runtime_requests(); announced.clear(); photocraft.runtime_destroy(); }
  };
}
