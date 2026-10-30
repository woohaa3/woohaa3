/**
 * 插件偏好 store 测试
 * （配置投影语义：store 不持介质，写入转发给宿主配置）。
 */
import { describe, expect, it, vi } from "vitest";
import { ExtensionPreferenceStore } from "./store.js";

const IDS = ["task-activity", "prompt-snippets", "node-history"] as const;

describe("ExtensionPreferenceStore（配置投影）", () => {
  it("未提供配置时默认全启用", () => {
    const store = new ExtensionPreferenceStore({ ids: IDS });
    const snapshot = store.getSnapshot();
    expect(snapshot.preferences).toEqual({ "task-activity": true, "prompt-snippets": true, "node-history": true });
    expect(snapshot.diagnostic).toBeNull();
    expect(snapshot.persistenceAvailable).toBe(false);
  });

  it("开箱默认值来自 defaults：未出现的 ID 不按启用处理，显式配置仍优先", () => {
    const store = new ExtensionPreferenceStore({
      ids: ["task-activity", "prompt-snippets", "node-history"],
      defaults: { "prompt-snippets": false },
      desired: { "node-history": false }
    });
    expect(store.getSnapshot().preferences).toEqual({
      "task-activity": true,
      "prompt-snippets": false,
      "node-history": false
    });
    // 宿主热更新同样以 defaults 兜底。
    store.applyDesired({ "node-history": true });
    expect(store.isEnabled("prompt-snippets")).toBe(false);
  });

  it("按宿主配置投影目标状态，未出现的 ID 取默认启用", () => {
    const store = new ExtensionPreferenceStore({
      ids: IDS,
      desired: { "node-history": false },
      persist: async () => ({ ok: true as const })
    });
    expect(store.isEnabled("node-history")).toBe(false);
    expect(store.isEnabled("prompt-snippets")).toBe(true);
    expect(store.getSnapshot().persistenceAvailable).toBe(true);
  });

  it("setEnabled 先乐观更新，再转发给持久化实现", async () => {
    const persist = vi.fn(async () => ({ ok: true as const }));
    const store = new ExtensionPreferenceStore({ ids: IDS, persist });
    const listener = vi.fn();
    store.subscribe(listener);
    const result = store.setEnabled("node-history", false);
    expect(result.ok).toBe(true);
    expect(store.isEnabled("node-history")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    await store.settled();
    expect(persist).toHaveBeenCalledWith("node-history", false);
    expect(store.getSnapshot().diagnostic).toBeNull();
  });

  it("非 allowlist ID 被拒绝且不触发持久化", () => {
    const persist = vi.fn(async () => ({ ok: true as const }));
    const store = new ExtensionPreferenceStore({ ids: IDS, persist });
    expect(store.setEnabled("model-editor", false).ok).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });

  it("写入失败回滚到最后成功值并报告安全诊断", async () => {
    const persist = vi.fn(async () => ({ ok: false as const, error: "配置服务不可用" }));
    const store = new ExtensionPreferenceStore({ ids: IDS, persist });
    store.setEnabled("node-history", false);
    await store.settled();
    expect(store.isEnabled("node-history")).toBe(true);
    expect(store.getSnapshot().diagnostic?.code).toBe("storage-write-failed");
    expect(JSON.stringify(store.getSnapshot().diagnostic)).not.toContain("secret");
  });

  it("持久化抛错同样回滚，不产生未处理拒绝", async () => {
    const persist = vi.fn(async () => {
      throw new Error("network down");
    });
    const store = new ExtensionPreferenceStore({ ids: IDS, persist });
    store.setEnabled("node-history", false);
    await expect(store.settled()).resolves.toBeUndefined();
    expect(store.isEnabled("node-history")).toBe(true);
    expect(store.getSnapshot().diagnostic?.code).toBe("storage-write-failed");
  });

  it("没有持久化实现时拒绝写入并保持默认值", () => {
    const store = new ExtensionPreferenceStore({ ids: IDS });
    const result = store.setEnabled("node-history", false);
    expect(result.ok).toBe(false);
    expect(store.isEnabled("node-history")).toBe(true);
    expect(store.getSnapshot().persistenceAvailable).toBe(false);
  });

  it("宿主配置变化经 applyDesired 热更新并通知订阅者", () => {
    const store = new ExtensionPreferenceStore({ ids: IDS, persist: async () => ({ ok: true as const }) });
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyDesired({ "prompt-snippets": false });
    expect(store.isEnabled("prompt-snippets")).toBe(false);
    expect(store.isEnabled("task-activity")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("dispose 后不再通知订阅者", () => {
    const store = new ExtensionPreferenceStore({ ids: IDS, persist: async () => ({ ok: true as const }) });
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    store.setEnabled("node-history", false);
    expect(listener).not.toHaveBeenCalled();
  });
});
