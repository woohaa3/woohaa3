/** Only the desktop host injects this capability; browsers keep their normal chrome. */
import { desktopBootstrap, type DesktopBootstrap } from "../extension-api/host-platform.js";
import { nativeProtocolUrl } from "./native-protocol.js";

export type { DesktopBootstrap };
export { desktopBootstrap };
export type WindowAction = "state" | "drag" | "minimize" | "toggle-maximize" | "close";
export type WindowState = { maximized: boolean };

export async function controlWindow(action: WindowAction): Promise<WindowState> {
  const bootstrap = desktopBootstrap(globalThis);
  if (!bootstrap) throw new Error("桌面窗口不可用");
  const response = await fetch(nativeProtocolUrl("window"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Woohaa-Token": bootstrap.token },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(5000)
  });
  const result = await response.json() as { ok: boolean; value?: WindowState; error?: string };
  if (!response.ok || !result.ok || typeof result.value?.maximized !== "boolean") {
    throw new Error(result.error ?? "窗口操作失败，请重试");
  }
  return result.value;
}
