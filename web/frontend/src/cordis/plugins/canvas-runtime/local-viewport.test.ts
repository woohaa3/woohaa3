/**
 * 本地视口存储测试（change: replace-godot-canvas-runtime-with-bevy）。
 *
 * 视口是各浏览器本地状态：按 canvasId 记忆、刷新后恢复、不写规范画布。
 */
import { describe, expect, it } from "vitest";
import { createLocalViewportStore } from "./local-viewport.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    }
  };
}

describe("createLocalViewportStore", () => {
  it("defaults to origin at 100%", () => {
    const store = createLocalViewportStore("canvas-a", memoryStorage());
    expect(store.get()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("persists per canvas and restores on next load", () => {
    const storage = memoryStorage();
    const first = createLocalViewportStore("canvas-a", storage);
    first.set({ x: 80, y: -40, zoom: 0.5 });

    const second = createLocalViewportStore("canvas-a", storage);
    expect(second.get()).toEqual({ x: 80, y: -40, zoom: 0.5 });

    // 不同画布互不影响。
    const other = createLocalViewportStore("canvas-b", storage);
    expect(other.get()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("clamps zoom to the canonical range", () => {
    const store = createLocalViewportStore("canvas-a", memoryStorage());
    store.set({ x: 0, y: 0, zoom: 99 });
    expect(store.get().zoom).toBe(12);
    store.set({ x: 0, y: 0, zoom: 0.001 });
    expect(store.get().zoom).toBe(0.1);
  });

  it("ignores malformed stored values", () => {
    const storage = memoryStorage();
    storage.setItem("woohaa3:viewport:canvas-a", "not-json");
    expect(createLocalViewportStore("canvas-a", storage).get()).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
