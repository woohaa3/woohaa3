import { installDeviceRecovery } from "./device-recovery.js";
import { installRendererFaultDetails } from "./renderer-fault-details.js";
import * as module from "../../../bevy-wasm/woohaa_bevy_canvas.js";
import type { BevyModule } from "./bevy-runtime-types.js";

export type RendererWindow = Window & {
  __rendererReady?: (module: BevyModule) => void;
  __rendererFault?: (reason: string) => void;
};
const realm = window as RendererWindow;
const faultDetails = installRendererFaultDetails(console);
const token = new URL(location.href).searchParams.get("realm") ?? "";
const registry = (parent as unknown as { __rendererRealms?: Map<string, { ready(module: BevyModule): void; fault(reason: string): void }> }).__rendererRealms;
realm.__rendererReady = module => registry?.get(token)?.ready(module);
realm.__rendererFault = reason => registry?.get(token)?.fault(reason);
// This realm contains only renderer code. Parent business errors are never claimed here.
window.addEventListener("error", event => {
  event.preventDefault();
  realm.__rendererFault?.(faultDetails(event.error, event.message || "渲染器异步执行失败"));
});
window.addEventListener("unhandledrejection", event => {
  event.preventDefault();
  realm.__rendererFault?.(faultDetails(event.reason));
});
const canvas = document.querySelector("canvas")!;
// Native winit pointer handlers focus their canvas. Input focus belongs to the parent
// surface; focusing a child would route subsequent real keyboard events away from it.
canvas.focus = () => {};
installDeviceRecovery(canvas, reason => realm.__rendererFault?.(reason));
realm.__rendererReady?.(module as BevyModule);
