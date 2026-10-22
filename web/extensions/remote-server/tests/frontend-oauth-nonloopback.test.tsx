/**
 * 非 loopback 的浏览器访问：面板**不提供**浏览器授权登录入口。
 *
 * 为什么单独一个文件：`window.location` 在 jsdom 里是一个文件一套环境，本文件的 URL 必须
 * 是「通过 LAN/反代访问」的形态（非本机主机），而不是默认的 localhost。
 * 结论要锁死：不显示浏览器登录、不发 oauth-start，直接走设备码（design D6）。
 */
// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://canvas.example.com/app" }
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { RemoteServerSettingsPanel } from "../src/frontend/settings-panel.js";
import { createRemoteServerService } from "../src/frontend/remote.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createService(responses: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const transport = {
    request: vi.fn(async (input: { path: string; body?: unknown }) => {
      calls.push(input);
      const key = Object.keys(responses).find((suffix) => input.path.endsWith(suffix));
      if (key === undefined) return { ok: false as const, code: "unavailable" as const, error: "未配置" };
      return { ok: true as const, status: 200, data: responses[key] };
    })
  };
  return { service: createRemoteServerService(transport), calls };
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

describe("非 loopback 访问", () => {
  it("当前页面确实不是本机地址（用例前提）", () => {
    expect(window.location.hostname).toBe("canvas.example.com");
  });

  it("「登录并连接」直接走设备码：不发 oauth-start，也不打开浏览器登录", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const { service, calls } = createService({
      "/session": { phase: "local", serverUrl: "https://canvas.example.com", subject: null, displayName: null, expiresAt: null, methods: [], error: null },
      "/device-start": {
        ok: true,
        userCode: "BCDF-GHJK",
        verificationUri: "https://canvas.example.com/device",
        intervalMs: 3000,
        expiresAt: Date.now() + 900_000
      }
    });
    await act(async () => {
      await service.refresh();
    });
    const { container, unmount } = await mount(createElement(RemoteServerSettingsPanel, { service }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="server-connect"]')!.click();
    });

    expect(calls.some((call) => call.path.endsWith("/oauth-start"))).toBe(false);
    expect(calls.some((call) => call.path.endsWith("/device-start"))).toBe(true);
    expect(container.querySelector('[data-testid="server-oauth-pending"]')).toBeNull();
    expect(container.querySelector('[data-testid="server-device-code"]')?.textContent).toContain("BCDF-GHJK");
    // 打开的是短码批准页，不是授权入口。
    expect(openSpy).toHaveBeenCalledWith("https://canvas.example.com/device", "_blank", "noopener,noreferrer");
    unmount();
  });
});
