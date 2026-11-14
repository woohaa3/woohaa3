import { desktopBootstrap } from "../extension-api/host-platform.js";
import { nativeProtocolUrl } from "./native-protocol.js";

export async function workspaceFolder(action: { action: "pick" } | { action: "open"; path: string }): Promise<{ path?: string | null }> {
  const bootstrap = desktopBootstrap(globalThis);
  if (!bootstrap) throw new Error("目录操作仅支持桌面版");
  const response = await fetch(nativeProtocolUrl("workspace-folder"), {
    method: "POST", headers: { "content-type": "application/json", "X-Woohaa-Token": bootstrap.token }, body: JSON.stringify(action)
  });
  const result = await response.json() as { ok: boolean; value?: { path?: string | null }; error?: string };
  if (!response.ok || !result.ok) throw new Error(result.error ?? "目录操作失败");
  return result.value ?? {};
}
