import { installDeviceRecovery } from "./device-recovery.js";
import { errorDetail } from "./runtime-issues.js";
import * as module from "../../../bevy-wasm/woohaa_bevy_canvas.js";
import type { BevyModule } from "./bevy-runtime-types.js";

export type RendererWindow = Window & {
  __rendererReady?: (module: BevyModule) => void;
  __rendererFault?: (reason: string) => void;
};
const realm = window as RendererWindow;
const token = new URL(location.href).searchParams.get("realm") ?? "";
const registry = (parent as unknown as { __rendererRealms?: Map<string, { ready(module: BevyModule): void; fault(reason: string): void }> }).__rendererRealms;
realm.__rendererReady = module => registry?.get(token)?.ready(module);
realm.__rendererFault = reason => registry?.get(token)?.fault(reason);

/** 与 `dev-error-assistant/store.ts` 的 `DEV_ERROR_MESSAGE_FLAG` 同一字符串（跨不了 import）。 */
const DEV_ERROR_MESSAGE_FLAG = "__sixiDevError";

/**
 * 把渲染器里的原始错误转发给父窗口的开发期报错助手
 * （change: 2026-10-30-add-dev-error-assistant）。
 *
 * 只转发**细节**，不改变本 realm 的失败语义：`__rendererFault` 仍然照旧被调用，
 * `preventDefault` 也仍然照旧 —— 父窗口只负责把 message/stack/source 记进列表。
 * 生产构建里父窗口没有监听者，这条消息只是无人接收的 postMessage。
 */
function relayErrorDetail(kind: "error" | "rejection", message: string, stack: string | null, source: string | null): void {
  try {
    parent.postMessage({ [DEV_ERROR_MESSAGE_FLAG]: true, kind, message, stack, source }, location.origin);
  } catch {
    /* 转发是旁路：失败不能让渲染器自己的错误处理跟着挂 */
  }
}

// This realm contains only renderer code. Parent business errors are never claimed here.
window.addEventListener("error", event => {
  event.preventDefault();
  const message = event.message || "渲染器异步执行失败";
  const source = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : null;
  // Bevy/WASM 的 panic 往往只有一条 message、没有 stack，源码位置只能来自 event.filename。
  const stack = event.error instanceof Error ? event.error.stack ?? null : null;
  relayErrorDetail("error", message, stack, source);
  realm.__rendererFault?.(message);
});
window.addEventListener("unhandledrejection", event => {
  event.preventDefault();
  const reason = event.reason;
  relayErrorDetail(
    "rejection",
    errorDetail(reason),
    reason instanceof Error ? reason.stack ?? null : null,
    null
  );
  realm.__rendererFault?.(errorDetail(event.reason));
});
const canvas = document.querySelector("canvas")!;
// Native winit pointer handlers focus their canvas. Input focus belongs to the parent
// surface; focusing a child would route subsequent real keyboard events away from it.
canvas.focus = () => {};
installDeviceRecovery(canvas, reason => realm.__rendererFault?.(reason));
realm.__rendererReady?.(module as BevyModule);
