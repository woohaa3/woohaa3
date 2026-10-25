import type { BevyModule } from "./bevy-runtime-types.js";
import type { RuntimeRealm } from "./runtime-realm.js";
import { createNativeAsyncRpc } from "./native-async-rpc.js";
import { createNativeViewportChannel } from "./native-viewport-channel.js";
import { nativeProtocolUrl } from "../../../desktop/native-protocol.js";
import { nativeDrawableLayout } from "./native-surface-layout.js";

type NativeBootstrap = { protocol: string; token: string; viewportAsync?: boolean };
export function nativeBootstrap(target: typeof globalThis): NativeBootstrap | undefined {
  return (target as typeof globalThis & { __WOOHAA_NATIVE__?: NativeBootstrap }).__WOOHAA_NATIVE__;
}

/** Same renderer facade, backed by the host's native Bevy App, with no WASM or iframe. */
export async function createNativeRuntimeRealm(
  target: typeof globalThis, fault: (reason: string) => void, signal?: AbortSignal
): Promise<RuntimeRealm> {
  signal?.throwIfAborted();
  const bootstrap = nativeBootstrap(target);
  if (bootstrap?.protocol !== "woohaa-native-v1") throw new Error("桌面画布协议不匹配");
  const canvas = target.document.getElementById("bevy-canvas") as HTMLCanvasElement | null;
  if (!canvas?.parentElement) throw new Error("画布输入表面尚未挂载");
  const host = canvas.parentElement;
  // 与浏览器 realm 一致：新 host/画布切换先用主题 curtain 盖住，首个主题画面确认后揭示。
  delete host.dataset.canvasPresented;
  const asyncRpc = createNativeAsyncRpc(target, bootstrap.token);
  let active = true;
  target.document.documentElement.dataset.nativeCanvas = "true";

  // DOM 焦点是剪贴板语义的前提（change: fix-desktop-native-menu-clipboard-shortcuts）。
  // 浏览器 realm 由 iframe 转发在 pointerdown 上 focus 输入 canvas；原生 realm 没有 iframe，
  // 若不做同样的事，画布点击后 `document.activeElement` 仍是 body——此时 macOS 原生 Edit 菜单
  // 会吃掉 Cmd+C 且 WebKit 不派发 DOM `copy`，复制节点完全失效（粘贴也拿不到载荷）。
  // 把 canvas 变成可聚焦元素并在指针按下时聚焦，与浏览器侧保持同一输入前提。
  const hadTabIndex = canvas.hasAttribute("tabindex");
  if (!hadTabIndex) canvas.tabIndex = 0;
  const focusCanvas = () => { if (active && canvas.isConnected) canvas.focus({ preventScroll: true }); };
  canvas.addEventListener("pointerdown", focusCanvas, true);

  // The current interaction controller requires an exact synchronous query result.
  // WKWebView waits in its own process; the Rust handler queues each call onto
  // Tauri's main thread. Never substitute cached hover results for pointer-down.
  const request = (path: string, body?: string | Uint8Array): XMLHttpRequest => {
    if (!active) throw new Error("Native canvas disposed");
    const xhr = new target.XMLHttpRequest();
    xhr.open(body === undefined ? "GET" : "POST", nativeProtocolUrl(path, target), false);
    xhr.setRequestHeader("X-Woohaa-Token", bootstrap.token);
    if (typeof body === "string") xhr.setRequestHeader("Content-Type", "application/json");
    else xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send(body === undefined ? null : typeof body === "string" ? body : new Uint8Array(body).buffer);
    if (xhr.status !== 200) throw new Error(`桌面画布通信失败 (${xhr.status})`);
    return xhr;
  };
  const rawRpc = (method: string, ...args: unknown[]): unknown => {
    const result = JSON.parse(request("rpc", JSON.stringify({ method, args })).responseText) as
      { ok: true; value: unknown } | { ok: false; error: string };
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const viewport = createNativeViewportChannel({
    send: async (json, sequence, signal) => {
      const value = await asyncRpc.call("set_viewport_sequenced", [json, sequence], signal);
      if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("Invalid viewport acceptance");
      return value as number;
    },
    sync: (json, sequence) => rawRpc("set_viewport_sequenced", json, sequence) as number,
    failed: () => fault("native-viewport")
  });
  const rpc = (method: string, ...args: unknown[]) => {
    if (method === "set_scene" || method === "seed_runtime_generation") viewport.cancel();
    else if (method.startsWith("query_") || method === "set_positions" || method === "request_shot_capture") {
      const generation = viewport.flush();
      if (generation !== null && method.startsWith("query_") && typeof args[0] === "string") {
        const input = JSON.parse(args[0]);
        if (typeof input.generation === "number") args[0] = JSON.stringify({ ...input, generation });
      }
    }
    return rawRpc(method, ...args);
  };
  let previousLayout = "";
  const layout = () => {
    if (!active || !canvas.isConnected) return;
    const rect = host.getBoundingClientRect();
    const values = nativeDrawableLayout(rect);
    const key = values.join(":");
    if (key !== previousLayout) { rpc("layout", ...values); previousLayout = key; }
  };
  const observer = new ResizeObserver(layout);
  observer.observe(host);
  target.addEventListener("resize", layout);
  layout();

  const upload = (plane: boolean, id: string, width: number, height: number, rgba: Uint8Array, content = "") => {
    const meta = encodeURIComponent(JSON.stringify({ plane, id, width, height, content }));
    const result = JSON.parse(request(`texture?meta=${meta}`, rgba).responseText) as { ok: boolean; error?: string };
    if (!result.ok) throw new Error(result.error ?? "Native texture upload failed");
  };
  const module = {
    default: async () => undefined,
    start: () => {},
    ...(bootstrap.viewportAsync ? { queue_viewport: (json: string, accepted: (generation: number) => void) => viewport.queue(json, accepted) } : {}),
    async_canvas_work_diagnostics: async () => {
      const value = await asyncRpc.call("canvas_work_diagnostics");
      if (typeof value !== "string") throw new Error("Invalid native diagnostics");
      return value;
    },
    set_texture: (id, w, h, bytes, content) => upload(false, id, w, h, bytes, content ?? ""),
    set_model_media_texture: (id, w, h, bytes) => upload(true, id, w, h, bytes),
    poll_shot_capture: (id, generation) => {
      const text = request(`capture?requestId=${id}&generation=${generation}`).responseText;
      return Uint8Array.from(text, char => char.charCodeAt(0) & 255);
    }
  } as BevyModule;
  for (const name of [
    "is_ready", "rendered_revision", "base_scene_generation", "viewport_capability", "observer_capability", "position_capability", "scene_capability",
    "runtime_health", "canvas_work_diagnostics", "model_asset_diagnostics", "shot_diagnostics",
    "set_scene", "set_viewport", "set_observer", "set_positions", "prepare_and_register_model_resource",
    "declare_model_resource", "set_model_payload_leases",
    "query_point_hit", "query_marquee", "query_probe", "query_drop_target", "query_composite_asset_scopes",
    "query_model_pick", "query_composite_asset_item_pick", "query_composite_asset_item_bounds", "query_gizmo_hit",
    "request_shot_capture", "seed_runtime_generation"
  ]) {
    (module as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => rpc(name, ...args);
  }
  if (bootstrap.viewportAsync) module.set_viewport = json => viewport.commit(json);
  const dispose = () => {
    if (!active) return;
    viewport.dispose();
    observer.disconnect(); target.removeEventListener("resize", layout);
    signal?.removeEventListener("abort", dispose);
    canvas.removeEventListener("pointerdown", focusCanvas, true);
    if (!hadTabIndex) canvas.removeAttribute("tabindex");
    try { rpc("layout", 0, 0, 0, 0); } catch { /* Host may already be closing. */ }
    active = false;
    delete host.dataset.canvasPresented;
    asyncRpc.dispose();
    delete target.document.documentElement.dataset.nativeCanvas;
  };
  signal?.addEventListener("abort", dispose, { once: true });
  // `#bevy-canvas` 是跨 page scope 复用的单例元素（见 `bevy-canvas-element.ts`）：切换画布时
  // 它会被挂到新宿主容器，`parentElement` 随之改变。连通性只应要求「仍在文档里且仍由某个
  // 画布宿主持有」，不能钉死在创建 realm 那一刻的父节点快照上——否则每次挂载变化都会被判成
  // `surface-detached`，而该原因不走失败计数、会无限重建 Bevy App。
  return {
    module,
    dispose,
    connected: () => active && canvas.isConnected && canvas.parentElement !== null,
    // 原生 realm 没有 iframe，但仍用同一 curtain 信号遮住首个 themed 画面之前的宿主 surface。
    reveal: () => {
      if (active) host.dataset.canvasPresented = "true";
    }
  };
}
