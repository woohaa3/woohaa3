import { describe, expect, it } from "vitest";
import { createCanvasAppearanceStore } from "./canvas-appearance.js";

describe("local canvas appearance", () => {
  it("defaults on for missing/corrupt/non-boolean preferences, restores explicit off", () => {
    for (const value of [null, "broken", "null", '{}', '{"globalLightEnabled":"false"}']) {
      const store = createCanvasAppearanceStore({ getItem: () => value, setItem() {} });
      expect(store.getSnapshot().globalLightEnabled).toBe(true);
    }
    let saved: string | null = null;
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    const store = createCanvasAppearanceStore(storage);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.setGlobalLightEnabled(false);
    expect(notifications).toBe(1);
    expect(createCanvasAppearanceStore(storage).getSnapshot().globalLightEnabled).toBe(false);
    unsubscribe();
    store.setGlobalLightEnabled(true);
    expect(notifications).toBe(1);
    expect(createCanvasAppearanceStore(storage).getSnapshot().globalLightEnabled).toBe(true);
  });

  it("keeps working in memory and reports storage failures", () => {
    for (const storage of [null, { getItem() { throw new Error(); }, setItem() { throw new Error(); } }]) {
      const store = createCanvasAppearanceStore(storage);
      store.setGlobalLightEnabled(false);
      expect(store.getSnapshot().globalLightEnabled).toBe(false);
      expect(store.getSnapshot().error).toContain("本次会话");
    }
  });

  it("isolates separate app mounts", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    createCanvasAppearanceStore(storage, "/dev/a/").setGlobalLightEnabled(false);
    expect(createCanvasAppearanceStore(storage, "/dev/b/").getSnapshot().globalLightEnabled).toBe(true);
  });
});
