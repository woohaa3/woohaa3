/**
 * 导出预设存储的回归（change: 2026-10-22-add-photocraft-raster-interchange，design D3）。
 *
 * 预设是本机偏好，不进入文档内容与内容指纹。这里锁定：坏快照整体回退、同名覆盖、上限拒绝、
 * 内置项不可删除，以及存储不可用时仍在内存里可用。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_EXPORT_PRESETS, ExportPresetStore, MAX_USER_PRESETS, mergePresets } from "./export-presets.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  let reads = 0;
  let writes = 0;
  const removed: string[] = [];
  return {
    data,
    get reads() { return reads; },
    get writes() { return writes; },
    removed,
    storage: {
      getItem: (key: string) => { reads += 1; return data.get(key) ?? null; },
      setItem: (key: string, value: string) => { writes += 1; data.set(key, value); },
      removeItem: (key: string) => { removed.push(key); data.delete(key); }
    }
  };
}

const JPEG_HIGH = { mode: "export", format: "jpg", quality: 90 } as const;

describe("导出预设", () => {
  it("内置预设可被界面直接使用，且不含重复名", () => {
    expect(new Set(BUILTIN_EXPORT_PRESETS.map((preset) => preset.name)).size).toBe(BUILTIN_EXPORT_PRESETS.length);
    expect(BUILTIN_EXPORT_PRESETS.map((preset) => preset.name)).toContain("网页 PNG-24");
    expect(mergePresets([])).toEqual([...BUILTIN_EXPORT_PRESETS]);
  });

  it("同名用户预设覆盖内置项且不增条目，其余保持顺序", () => {
    const merged = mergePresets([{ name: "JPEG 高", settings: { mode: "export", format: "jpg", quality: 55 } }]);
    expect(merged).toHaveLength(BUILTIN_EXPORT_PRESETS.length);
    expect(merged.find((preset) => preset.name === "JPEG 高")?.settings.quality).toBe(55);
    expect(merged[0]!.name).toBe("JPEG 中");
  });

  it("保存、覆盖与删除走同一校验并落盘", () => {
    const memory = memoryStorage();
    const store = new ExportPresetStore(memory.storage);
    expect(store.save("我的 JPEG", JPEG_HIGH)).toBe(true);
    expect(store.find("我的 JPEG")).toMatchObject({ format: "jpg", quality: 90 });
    expect(store.save("我的 JPEG", { mode: "export", format: "jpg", quality: 70 })).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.find("我的 JPEG")).toMatchObject({ quality: 70 });
    expect(memory.writes).toBe(2);
    expect(store.remove("我的 JPEG")).toBe(true);
    expect(store.list()).toEqual([]);
    // 内置项不是用户预设，不能删除。
    expect(store.remove("JPEG 高")).toBe(false);
  });

  it("非法输入被拒绝且不写入存储", () => {
    const memory = memoryStorage();
    const store = new ExportPresetStore(memory.storage);
    expect(store.save("   ", JPEG_HIGH)).toBe(false);
    expect(store.lastError).toBe("预设名不能为空");
    expect(store.save("x".repeat(81), JPEG_HIGH)).toBe(false);
    // 客户端能判定的非法设置（质量越界）被拒绝，避免存下永远失败的预设。
    expect(store.save("坏的", { mode: "export", format: "jpg", quality: 0 as unknown as number })).toBe(false);
    expect(store.list()).toEqual([]);
    expect(memory.writes).toBe(0);
  });

  it("坏快照整体丢弃并回退到内置预设", () => {
    for (const raw of ["{ not json", JSON.stringify([{ name: "坏", settings: { mode: "export", format: "exr" } }]), JSON.stringify({})]) {
      const memory = memoryStorage({ "photocraft.export-presets.v1": raw });
      const store = new ExportPresetStore(memory.storage);
      expect(store.list()).toEqual([]);
      expect(store.all()).toEqual([...BUILTIN_EXPORT_PRESETS]);
      expect(store.lastError).toBeTruthy();
      expect(memory.removed).toEqual(["photocraft.export-presets.v1"]);
    }
  });

  it("存储不可用时不抛错，预设仍在本会话可用", () => {
    const failing = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("denied"); }
    };
    const store = new ExportPresetStore(failing);
    expect(store.lastError).toBe("无法读取本机导出预设");
    expect(store.save("临时", JPEG_HIGH)).toBe(true);
    expect(store.find("临时")).toMatchObject({ format: "jpg" });
    expect(store.lastError).toBe("本机导出预设保存失败（存储不可用或已满）");
    // 没有存储实现（隐私模式）同样可用。
    const memoryOnly = new ExportPresetStore(null);
    expect(memoryOnly.save("仅内存", JPEG_HIGH)).toBe(true);
    expect(memoryOnly.lastError).toBeNull();
  });

  it("用户预设数量受预算限制，达到上限后拒绝新增但允许覆盖", () => {
    const memory = memoryStorage();
    const store = new ExportPresetStore(memory.storage);
    for (let index = 0; index < MAX_USER_PRESETS; index += 1) {
      expect(store.save(`预设 ${index}`, JPEG_HIGH)).toBe(true);
    }
    expect(store.list()).toHaveLength(MAX_USER_PRESETS);
    expect(store.save("再来一条", JPEG_HIGH)).toBe(false);
    expect(store.save("预设 0", { mode: "export", format: "png" })).toBe(true);
    expect(store.find("预设 0")).toMatchObject({ format: "png" });
  });
});
