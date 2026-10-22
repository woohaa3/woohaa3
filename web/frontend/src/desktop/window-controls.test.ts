import { afterEach, expect, it, vi } from "vitest";
import { controlWindow, desktopBootstrap } from "./window-controls.js";
afterEach(() => vi.unstubAllGlobals());
it("没有宿主能力或协议不兼容时不发起窗口操作", async () => {
  vi.stubGlobal("__WOOHAA_DESKTOP__", { protocol: "unknown", token: "test" });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(desktopBootstrap(globalThis)).toBeUndefined();
  await expect(controlWindow("close")).rejects.toThrow("桌面窗口不可用");
  expect(fetch).not.toHaveBeenCalled();
});
it("窗口请求携带宿主令牌，拒绝错误或无效状态回包", async () => {
  vi.stubGlobal("__WOOHAA_DESKTOP__", { protocol: "woohaa-window-v1", token: "window-test" });
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, value: { maximized: true } })));
  vi.stubGlobal("fetch", fetch);
  await expect(controlWindow("toggle-maximize")).resolves.toEqual({ maximized: true });
  expect(fetch).toHaveBeenCalledWith("woohaa-native://localhost/window", expect.objectContaining({
    method: "POST", headers: { "Content-Type": "application/json", "X-Woohaa-Token": "window-test" },
    body: '{"action":"toggle-maximize"}'
  }));
  fetch.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "Unauthorized native boundary" })));
  await expect(controlWindow("close")).rejects.toThrow("Unauthorized");
  fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, value: null })));
  await expect(controlWindow("state")).rejects.toThrow("窗口操作失败");
});
