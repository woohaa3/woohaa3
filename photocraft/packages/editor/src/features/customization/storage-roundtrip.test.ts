/** @vitest-environment jsdom */
/**
 * 偏好持久化往返回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * spec 场景要求「重载保留偏好」：这里用真实 `localStorage`（jsdom 提供）验证写入后新建仓库能读回，
 * 并验证受限存储下降级为会话内偏好、且不伪造「已保存」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOMIZATION_STORAGE_KEY,
  CUSTOMIZATION_VERSION,
  CustomizationStore,
  browserPreferenceStorage
} from "./preferences.js";

afterEach(() => {
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
});

describe("真实本机存储", () => {
  it("写入后新建仓库能读回同一份偏好（等同于重载编辑器）", () => {
    const storage = browserPreferenceStorage();
    expect(storage).not.toBeNull();

    const first = new CustomizationStore(storage);
    expect(first.snapshot().persistence).toBe("local");
    first.setShortcut("edit.undo", "Mod+U");
    first.setToolbarHidden(["tool.brush"]);
    first.setMenuHidden(["layer.delete"]);
    first.saveWorkspace("看图");
    const saved = first.snapshot().preferences;

    // 重载：同一份存储、新的仓库实例。
    const reopened = new CustomizationStore(browserPreferenceStorage());
    expect(reopened.snapshot().loadError).toBeNull();
    expect(reopened.snapshot().preferences).toEqual(saved);
    expect(reopened.snapshot().preferences.shortcuts["edit.undo"]).toBe("Mod+U");
    expect(reopened.snapshot().preferences.toolbarHidden).toEqual(["tool.brush"]);
    expect(reopened.snapshot().preferences.workspaces.map((workspace) => workspace.name)).toEqual(["看图"]);
  });

  it("写进真实存储的内容带版本号，且不含文档字节", () => {
    const store = new CustomizationStore(browserPreferenceStorage());
    store.setShortcut("edit.undo", "Mod+U");
    const raw = globalThis.localStorage.getItem(CUSTOMIZATION_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const decoded = JSON.parse(raw!);
    expect(decoded.version).toBe(CUSTOMIZATION_VERSION);
    // 偏好只有动作/工具 id、布局参数与版本；没有图层、像素或文档内容字段。
    expect(Object.keys(decoded).sort()).toEqual(
      ["activeWorkspace", "menuHidden", "shortcuts", "toolOptions", "toolbarHidden", "toolbarOrder", "version", "workspaces"].sort()
    );
  });

  it("存储拒绝写入时操作整体失败并保留原设置", () => {
    const store = new CustomizationStore(browserPreferenceStorage());
    store.setShortcut("edit.undo", "Mod+U");
    const before = store.snapshot().preferences;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const result = store.setShortcut("edit.undo", "Mod+Alt+U");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("storage");
    expect(store.snapshot().preferences.shortcuts["edit.undo"]).toBe("Mod+U");
    expect(store.snapshot().preferences).toEqual(before);
  });

  it("存储整体不可用（读取即抛错）时降级为会话内偏好并给出原因", () => {
    const hostile = {
      read: () => { throw new Error("SecurityError"); },
      write: () => { throw new Error("SecurityError"); }
    };
    const store = new CustomizationStore(hostile);
    expect(store.snapshot().persistence).toBe("local");
    expect(store.snapshot().loadError).toContain("无法读取本机偏好存储");
    // 降级后仍允许改本会话内的设置，但写入失败必须如实失败。
    expect(store.setShortcut("edit.undo", "Mod+U").ok).toBe(false);
    expect(store.snapshot().preferences.shortcuts["edit.undo"]).toBeUndefined();
  });

  it("完全没有存储对象时只保留会话内偏好", () => {
    const store = new CustomizationStore(null);
    expect(store.snapshot().persistence).toBe("memory");
    expect(store.snapshot().loadError).toContain("只在当前会话内保留");
  });
});
