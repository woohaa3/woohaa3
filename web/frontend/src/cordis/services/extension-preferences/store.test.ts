/**
 * 插件偏好 store 测试
 * （change: add-frontend-plugin-manager，任务 2.1/2.2）。
 */
import { describe, expect, it, vi } from "vitest";
import { FRONTEND_PLUGIN_PREFERENCES_KEY, type PreferenceStorage } from "./codec.js";
import { ExtensionPreferenceStore } from "./store.js";

const IDS = ["task-activity", "prompt-snippets", "node-history"] as const;

/** 内存 Storage 替身。 */
function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    }
  };
}

describe("ExtensionPreferenceStore（任务 2.1/2.2）", () => {
  it("首次启动默认全启用且无诊断", () => {
    const store = new ExtensionPreferenceStore({ ids: IDS, storage: memoryStorage() });
    const snapshot = store.getSnapshot();
    expect(snapshot.preferences).toEqual({ "task-activity": true, "prompt-snippets": true, "node-history": true });
    expect(snapshot.diagnostic).toBeNull();
    expect(snapshot.persistenceAvailable).toBe(true);
  });

  it("成功保存规范化写入并通知订阅者", () => {
    const storage = memoryStorage();
    const store = new ExtensionPreferenceStore({ ids: IDS, storage });
    const listener = vi.fn();
    store.subscribe(listener);
    const result = store.setEnabled("node-history", false);
    expect(result.ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.data[FRONTEND_PLUGIN_PREFERENCES_KEY])).toEqual({
      "task-activity": true,
      "prompt-snippets": true,
      "node-history": false
    });
    expect(store.isEnabled("node-history")).toBe(false);
  });

  it("非 allowlist ID 被拒绝且不写存储", () => {
    const storage = memoryStorage();
    const store = new ExtensionPreferenceStore({ ids: IDS, storage });
    const result = store.setEnabled("model-editor", false);
    expect(result.ok).toBe(false);
    expect(storage.data[FRONTEND_PLUGIN_PREFERENCES_KEY]).toBeUndefined();
  });

  it("写入失败保留最后成功值、报告无敏感内容诊断", () => {
    const storage: PreferenceStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded secret-token");
      }
    };
    const store = new ExtensionPreferenceStore({ ids: IDS, storage });
    const result = store.setEnabled("node-history", false);
    expect(result.ok).toBe(false);
    // 最后成功值（默认全启用）保持不变。
    expect(store.isEnabled("node-history")).toBe(true);
    const snapshot = store.getSnapshot();
    expect(snapshot.diagnostic?.code).toBe("storage-write-failed");
    expect(snapshot.persistenceAvailable).toBe(false);
    expect(JSON.stringify(snapshot.diagnostic)).not.toContain("secret-token");
  });

  it("存储不可用时报告无法保存但保留默认启动", () => {
    const store = new ExtensionPreferenceStore({ ids: IDS, storage: null });
    expect(store.getSnapshot().preferences["node-history"]).toBe(true);
    expect(store.getSnapshot().persistenceAvailable).toBe(false);
    const result = store.setEnabled("node-history", false);
    expect(result.ok).toBe(false);
    expect(store.isEnabled("node-history")).toBe(true);
  });

  it("读取异常回退全启用并暴露降级诊断", () => {
    const storage: PreferenceStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined
    };
    const store = new ExtensionPreferenceStore({ ids: IDS, storage });
    const snapshot = store.getSnapshot();
    expect(snapshot.preferences).toEqual({ "task-activity": true, "prompt-snippets": true, "node-history": true });
    expect(snapshot.diagnostic?.code).toBe("storage-read-failed");
    expect(snapshot.persistenceAvailable).toBe(false);
  });

  it("读取损坏配置整体降级到全启用并暴露诊断", () => {
    const storage = memoryStorage({ [FRONTEND_PLUGIN_PREFERENCES_KEY]: "{broken" });
    const store = new ExtensionPreferenceStore({ ids: IDS, storage });
    expect(store.getSnapshot().preferences["node-history"]).toBe(true);
    expect(store.getSnapshot().diagnostic?.code).toBe("malformed-json");
  });

  it("写入失败后可再次重试成功", () => {
    let fail = true;
    const data: Record<string, string> = {};
    const storage: PreferenceStorage = {
      getItem: (key) => data[key] ?? null,
      setItem: (key, value) => {
        if (fail) throw new Error("nope");
        data[key] = value;
      }
    };
    const store = new ExtensionPreferenceStore({ ids: IDS, storage });
    expect(store.setEnabled("node-history", false).ok).toBe(false);
    fail = false;
    expect(store.setEnabled("node-history", false).ok).toBe(true);
    expect(store.isEnabled("node-history")).toBe(false);
    expect(store.getSnapshot().diagnostic).toBeNull();
    expect(store.getSnapshot().persistenceAvailable).toBe(true);
  });

  it("dispose 后不再通知订阅者", () => {
    const store = new ExtensionPreferenceStore({ ids: IDS, storage: memoryStorage() });
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    store.setEnabled("node-history", false);
    expect(listener).not.toHaveBeenCalled();
  });
});
