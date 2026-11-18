// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot } from "@woohaa3/contracts";
import { AboutSection } from "./about-section.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const snapshot: SettingsSnapshot = {
  settings: [
    { key: "storage.primary", kind: "string", label: "主存储", description: "", reload: "hot", secret: false, source: "default", lockedBy: null, value: "local", configured: true, pendingRestart: false },
    { key: "exposer.primary", kind: "string", label: "对外地址", description: "", reload: "hot", secret: false, source: "default", lockedBy: null, value: "", configured: true, pendingRestart: false },
    { key: "storage.local.publicEnabled", kind: "boolean", label: "公开桶", description: "", reload: "hot", secret: false, source: "default", lockedBy: null, value: true, configured: true, pendingRestart: false }
  ],
  plugins: [],
  extensionPoints: {
    storage: [{ id: "local", label: "本地", ownerExtensionId: "local-storage" }],
    exposer: [{ id: "local-public", label: "公开临时桶", ownerExtensionId: "local-storage" }]
  },
  installedExtensions: [],
  files: { config: "/tmp/woohaa.config.yml", secrets: "/tmp/woohaa.secrets.yml" }
};

describe("设置 · 关于", () => {
  it("展示版本、存储与临时图床的自动状态", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<AboutSection snapshot={snapshot} />));

    expect(container.querySelector('[data-testid="settings-about-version"]')?.textContent).toContain("未注入");
    expect(container.querySelector('[data-testid="settings-about-storage"]')?.textContent).toContain("local");
    expect(container.querySelector('[data-testid="settings-about-exposer"]')?.textContent).toContain("自动");
    expect(container.querySelector('[data-testid="settings-about-exposer"]')?.textContent).toContain("公开临时桶");
    expect(container.querySelector('[data-testid="settings-about-public-bucket"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-about-files"]')?.textContent).toContain("woohaa.config.yml");

    await act(async () => root.unmount());
    container.remove();
  });

  it("Tauri 桌面壳注入版本时，应用版本优先显示桌面包版本号", async () => {
    const globals = globalThis as unknown as { __WOOHAA_DESKTOP__?: unknown };
    const prev = globals.__WOOHAA_DESKTOP__;
    globals.__WOOHAA_DESKTOP__ = { protocol: "woohaa-window-v1", token: "test", platform: "darwin", version: "0.1.22" };
    try {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => root.render(<AboutSection snapshot={snapshot} />));

      const versionText = container.querySelector('[data-testid="settings-about-version"]')?.textContent ?? "";
      expect(versionText).toContain("0.1.22");
      expect(versionText).not.toContain("未注入");

      await act(async () => root.unmount());
      container.remove();
    } finally {
      if (prev === undefined) delete globals.__WOOHAA_DESKTOP__;
      else globals.__WOOHAA_DESKTOP__ = prev;
    }
  });

  it("稳定版安装包不渲染「接收开发者版本」入口", async () => {
    // 服务端只提供 stable：普通用户看不到任何开发者入口。
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        value: { channel: "stable", pendingRollback: false, available: ["stable"] }
      }))
    );
    const globals = globalThis as unknown as { __WOOHAA_DESKTOP__?: unknown; fetch?: unknown };
    const prevDesktop = globals.__WOOHAA_DESKTOP__;
    const prevFetch = globals.fetch;
    globals.__WOOHAA_DESKTOP__ = { protocol: "woohaa-window-v1", token: "test", platform: "darwin", version: "0.1.26" };
    globals.fetch = fetch;
    try {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => root.render(<AboutSection snapshot={snapshot} />));
      expect(container.querySelector('[data-testid="settings-about-update-channel"]')).toBeNull();
      expect(container.querySelector('[data-testid="settings-about-update-channel-toggle"]')).toBeNull();
      await act(async () => root.unmount());
      container.remove();
    } finally {
      if (prevDesktop === undefined) delete globals.__WOOHAA_DESKTOP__;
      else globals.__WOOHAA_DESKTOP__ = prevDesktop;
      globals.fetch = prevFetch;
    }
  });

  it("alpha 安装包里开关缺省关闭，开启后写入 alpha", async () => {
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      const channel = init?.body ? (JSON.parse(init.body as string) as { channel: string }).channel : "stable";
      return new Response(JSON.stringify({
        ok: true,
        value: { channel, pendingRollback: false, available: ["stable", "alpha"] }
      }));
    });
    const globals = globalThis as unknown as { __WOOHAA_DESKTOP__?: unknown; fetch?: unknown };
    const prevDesktop = globals.__WOOHAA_DESKTOP__;
    const prevFetch = globals.fetch;
    globals.__WOOHAA_DESKTOP__ = { protocol: "woohaa-window-v1", token: "test", platform: "darwin", version: "0.2.0-alpha.3" };
    globals.fetch = fetch;
    try {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => root.render(<AboutSection snapshot={snapshot} />));
      const toggle = container.querySelector<HTMLButtonElement>('[data-testid="settings-about-update-channel-toggle"]');
      expect(toggle).not.toBeNull();
      // 缺省关闭：读到的 channel 是 stable。
      expect(toggle!.getAttribute("aria-checked")).toBe("false");
      expect(calls[0]?.method).toBe("GET");
      expect(calls[0]?.url).toBe("woohaa-native://localhost/update-channel");

      await act(async () => { toggle!.click(); });
      const write = calls.find((call) => call.method === "POST");
      expect(write?.body).toBe('{"channel":"alpha"}');
      // 写回后开关变成开启，说明状态来自服务端而不是本地猜测。
      expect(container.querySelector('[data-testid="settings-about-update-channel-toggle"]')!.getAttribute("aria-checked")).toBe("true");

      await act(async () => root.unmount());
      container.remove();
    } finally {
      if (prevDesktop === undefined) delete globals.__WOOHAA_DESKTOP__;
      else globals.__WOOHAA_DESKTOP__ = prevDesktop;
      globals.fetch = prevFetch;
    }
  });
});
