/**
 * 最近画布选择存储测试
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 3.4）。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { createCanvasSelectionService, RECENT_CANVAS_STORAGE_KEY } from "./canvas-selection.js";

describe("createCanvasSelectionService", () => {
  it("读写最近画布 ID", () => {
    const storage = new Map<string, string>();
    const store = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key)
    } as unknown as Storage;
    const service = createCanvasSelectionService(store);
    service.setRecentCanvasId("canvas-a");
    expect(service.getRecentCanvasId()).toBe("canvas-a");
    expect(storage.get(RECENT_CANVAS_STORAGE_KEY)).toBe("canvas-a");
    service.setRecentCanvasId(null);
    expect(service.getRecentCanvasId()).toBeNull();
  });

  it("存储抛错时静默降级", () => {
    const store = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined
    } as unknown as Storage;
    const service = createCanvasSelectionService(store);
    expect(service.getRecentCanvasId()).toBeNull();
    expect(() => service.setRecentCanvasId("x")).not.toThrow();
  });
});
