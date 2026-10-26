import type { BevyModule } from "./bevy-runtime-types.js";
import { appPublicUrl } from "../../services/app-base-path.js";

declare const __WOOHAA_NATIVE_ONLY__: boolean;

export type RuntimeRealm = {
  module: BevyModule;
  dispose(): void;
  connected(): boolean;
  /**
   * 揭示画布 surface：浏览器 realm 在首个带主题的 scene 提交并绘制后才从透明淡入，
   * 避免新建 iframe 的默认浅色清屏在暗色画布切换时闪一帧白。原生 realm 无需处理。
   */
  reveal(): void;
};

function createRuntimeToken(): string {
  const cryptoRef = globalThis.crypto;
  if (typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 宿主是否注入了原生画布引导（Tauri 桌面窗口）。 */
export function hasNativeBootstrap(target: typeof globalThis): boolean {
  return (target as typeof globalThis & { __WOOHAA_NATIVE__?: unknown }).__WOOHAA_NATIVE__ !== undefined;
}

/**
 * 选择渲染 realm：原生引导存在时用宿主 App，否则用同源 iframe 里的 WASM。
 * Removing this iframe destroys the WASM memory, winit loop and device together.
 */
export async function createRuntimeRealm(target: typeof globalThis, fault: (reason: string) => void, signal?: AbortSignal): Promise<RuntimeRealm> {
  signal?.throwIfAborted();
  if (hasNativeBootstrap(target)) {
    // 桌面壳：原生 Bevy App 由宿主主线程驱动，没有 WASM 实例，也就没有可重建的 iframe。
    const { createNativeRuntimeRealm } = await import("./native-runtime-realm.js");
    return createNativeRuntimeRealm(target, fault, signal);
  }
  if (typeof __WOOHAA_NATIVE_ONLY__ !== "undefined" && __WOOHAA_NATIVE_ONLY__) {
    throw new Error("桌面原生渲染器未初始化，请重新打开 App。");
  }
  const canvas = target.document.getElementById("bevy-canvas") as HTMLCanvasElement | null;
  if (!canvas?.parentElement) throw new Error("画布输入表面尚未挂载");
  const host = canvas.parentElement;
  // 新 realm/画布切换：父级 curtain 重新盖住表面，直到 reveal 确认主题画面已绘制。
  delete host.dataset.canvasPresented;
  const iframe = target.document.createElement("iframe");
  iframe.title = "画布渲染预览";
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  // iframe 文档在拿到自己的主题底之前也可能被合成器画一帧；先把元素底色铺成当前主题，
  // 与 renderer.html 内联引导、canvas surface 三层兜底。
  try {
    const backdrop = target.getComputedStyle(target.document.documentElement)
      .getPropertyValue("--app-web-backdrop")
      .trim();
    if (backdrop) iframe.style.backgroundColor = backdrop;
  } catch {
    /* 主题变量不可用时交给 renderer.html 与父级 surface */
  }
  // opacity 0 直到首个 themed scene 绘制完成（见 `reveal`）：新 realm 的 Bevy 初始清屏取
  // 生成默认主题的浅色，暗色模式下切换画布会直接看到白闪。
  iframe.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;opacity:0;transition:opacity 120ms linear";
  canvas.tabIndex = 0;
  canvas.style.position = "relative";
  canvas.style.zIndex = "0";
  let active = true;
  let delivered = false;
  const cleanups: (() => void)[] = [];
  const dispose = () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups) cleanup();
    iframe.remove();
    delete host.dataset.canvasPresented;
  };
  const report = (reason: string) => { if (active) fault(reason); };
  const ready = new Promise<BevyModule>((resolve, reject) => {
    const abort = () => { dispose(); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    cleanups.push(() => signal?.removeEventListener("abort", abort));
    const timer = target.setTimeout(() => { reject(new Error("渲染器装载超时")); }, 30000);
    cleanups.push(() => target.clearTimeout(timer));
    host.prepend(iframe);
    // A same-origin bootstrap handoff survives the document navigation via the parent.
    const token = createRuntimeToken();
    const registry = target as typeof globalThis & { __rendererRealms?: Map<string, { ready(module: BevyModule): void; fault(reason: string): void }> };
    registry.__rendererRealms ??= new Map();
    registry.__rendererRealms.set(token, {
      ready(module) {
        if (!active) return;
        if (delivered) { report("renderer-reloaded"); return; }
        delivered = true; target.clearTimeout(timer); resolve(module);
      }, fault: report
    });
    cleanups.push(() => registry.__rendererRealms?.delete(token));
    iframe.src = `${appPublicUrl("/renderer.html")}?realm=${encodeURIComponent(token)}`;
  });
  // Parent input owns coordinates and editing gestures; forward native input to winit.
  for (const type of ["pointerdown", "pointerup", "pointermove", "pointercancel", "wheel", "keydown", "keyup", "blur"] as const) {
    const source: EventTarget = type.startsWith("key") || type === "blur" ? target : canvas;
    const listener = (event: Event) => {
      if (!active || !canvas.isConnected) return;
      if (event instanceof KeyboardEvent && target.document.activeElement?.matches("input,textarea,[contenteditable=true]")) return;
      if (type === "pointerdown") canvas.focus({ preventScroll: true });
      const realm = iframe.contentWindow;
      const child = iframe.contentDocument?.querySelector("canvas");
      if (!realm || !child) return;
      const rect = canvas.getBoundingClientRect();
      let clone: Event;
      if (event instanceof WheelEvent) clone = new WheelEvent(type, { ...mouseInit(event, rect), deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode });
      else if (event instanceof PointerEvent) clone = new PointerEvent(type, { ...mouseInit(event, rect), pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary, pressure: event.pressure });
      else if (event instanceof KeyboardEvent) clone = new KeyboardEvent(type, { key: event.key, code: event.code, repeat: event.repeat, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, bubbles: true });
      else clone = new Event(type);
      (type === "blur" ? realm : child).dispatchEvent(clone);
    };
    source.addEventListener(type, listener, true);
    cleanups.push(() => source.removeEventListener(type, listener, true));
  }
  const reveal = () => {
    if (!active) return;
    iframe.style.opacity = "1";
    host.dataset.canvasPresented = "true";
  };
  try {
    return {
      module: await ready,
      dispose,
      connected: () => canvas.isConnected && canvas.parentElement === host && iframe.isConnected,
      reveal
    };
  }
  catch (error) { dispose(); throw error; }
}

function mouseInit(event: MouseEvent, rect: DOMRect): MouseEventInit {
  return { clientX: event.clientX - rect.left, clientY: event.clientY - rect.top,
    button: event.button, buttons: event.buttons, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
    altKey: event.altKey, metaKey: event.metaKey, bubbles: true, cancelable: true };
}
