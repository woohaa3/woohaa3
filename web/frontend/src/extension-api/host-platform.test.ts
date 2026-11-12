import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { desktopAppVersion, desktopBootstrap, isDesktopHost } from "./host-platform.js";
import { desktopBootstrap as hostDesktopBootstrap } from "../desktop/window-controls.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

describe("运行宿主判定", () => {
  it("只有完整窗口能力才判定为桌面壳", () => {
    expect(isDesktopHost({} as typeof globalThis)).toBe(false);
    expect(isDesktopHost({ __WOOHAA_DESKTOP__: { protocol: "other", token: "t" } } as never)).toBe(false);
    expect(isDesktopHost({ __WOOHAA_DESKTOP__: { protocol: "woohaa-window-v1", token: "" } } as never)).toBe(false);
    expect(isDesktopHost({ __WOOHAA_DESKTOP__: { protocol: "woohaa-window-v1", token: "t" } } as never)).toBe(true);
    expect(desktopBootstrap({ __WOOHAA_DESKTOP__: { protocol: "woohaa-window-v1", token: "t" } } as never))
      .toEqual({ protocol: "woohaa-window-v1", token: "t" });
    expect(desktopAppVersion({ __WOOHAA_DESKTOP__: { protocol: "woohaa-window-v1", token: "t", version: "0.1.22" } } as never))
      .toBe("0.1.22");
    expect(desktopAppVersion({} as typeof globalThis)).toBeNull();
  });

  it("宿主的窗口控制与扩展共享同一判定，不出现两套协议字符串漂移", () => {
    const source = readFileSync(`${HERE}../desktop/window-controls.ts`, "utf8");
    // 宿主入口改为复用 leaf 判定，避免桌面能力协议在两处各写一份。
    expect(source).toContain('from "../extension-api/host-platform.js"');
    expect(hostDesktopBootstrap).toBe(desktopBootstrap);
  });
});
