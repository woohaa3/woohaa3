/**
 * 导出预设消费端口回归（change: 2026-10-22-add-photocraft-file-workflows，U04）。
 *
 * 断言三件事：
 * 1. 提供方缺失时**如实不可用**，不退化成一套本域自造的预设；
 * 2. 提供方返回的病态数据被收窄（非数组、坏条目、同名、超长名），不做第二份设置校验；
 * 3. 保存/删除失败原因原样上抛，不吞成「成功」。
 */
import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_PRESET_UNAVAILABLE,
  exportPresetFormat,
  normalizeExportPresetSnapshot,
  resolveExportPresetPort
} from "./export-bridge.js";

describe("导出预设端口解析", () => {
  it("io 会话没有 exportPresets 时明确不可用", () => {
    const port = resolveExportPresetPort({ io: {} });
    expect(port).toEqual({ available: false, reason: EXPORT_PRESET_UNAVAILABLE });
    expect(resolveExportPresetPort({})).toMatchObject({ available: false });
    expect(resolveExportPresetPort(null)).toMatchObject({ available: false });
  });

  it("提供方存在时列出预设，且不修改设置本身", () => {
    const settings = { mode: "export", format: "jpg", quality: 90 };
    const port = resolveExportPresetPort({ io: { exportPresets: () => [{ name: " 高 ", settings }] } });
    expect(port.available).toBe(true);
    if (!port.available) return;
    const snapshot = port.list();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    // 名称去空白，设置按引用原样透传（本域不复制导出设置类型）。
    expect(snapshot.presets).toEqual([{ name: "高", settings }]);
    expect(snapshot.presets[0]!.settings).toBe(settings);
  });

  it("提供方抛错时变成可显示的失败原因，不向上冒泡", () => {
    const port = resolveExportPresetPort({ io: { exportPresets: () => { throw new Error("内核未就绪"); } } });
    if (!port.available) return;
    expect(port.list()).toEqual({ ok: false, reason: "读取导出预设失败：内核未就绪" });
  });

  it("保存/删除只在提供方支持时出现，并原样返回失败原因", () => {
    const bare = resolveExportPresetPort({ io: { exportPresets: () => [] } });
    if (!bare.available) return;
    expect(bare.save).toBeUndefined();
    expect(bare.remove).toBeUndefined();

    const full = resolveExportPresetPort({
      io: {
        exportPresets: () => [],
        saveExportPreset: vi.fn(() => ({ ok: false, reason: "预设名重复" })),
        removeExportPreset: vi.fn(() => ({ ok: true }))
      }
    });
    if (!full.available) return;
    expect(full.save?.("高", {})).toEqual({ ok: false, reason: "预设名重复" });
    expect(full.remove?.("高")).toEqual({ ok: true });
  });
});

describe("导出预设快照的渲染收窄", () => {
  it("非数组明确失败", () => {
    expect(normalizeExportPresetSnapshot({ presets: [] })).toMatchObject({ ok: false });
    expect(normalizeExportPresetSnapshot(undefined)).toMatchObject({ ok: false });
  });

  it("丢弃坏条目、空名、超长名与同名重复，其余保持顺序", () => {
    const snapshot = normalizeExportPresetSnapshot([
      { name: "A", settings: { format: "jpg" } },
      null,
      "字符串条目",
      { name: "   ", settings: {} },
      { name: "x".repeat(201), settings: {} },
      { name: "A", settings: { format: "png" } },
      { name: "B", settings: { format: "webp" } }
    ]);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.presets.map((preset) => preset.name)).toEqual(["A", "B"]);
    expect(snapshot.presets[0]!.settings).toEqual({ format: "jpg" });
  });

  it("设置不是对象也保留条目：合法性由提供方负责，本域不判第二遍", () => {
    const snapshot = normalizeExportPresetSnapshot([{ name: "奇怪", settings: "not-an-object" }]);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.presets).toHaveLength(1);
  });
});

describe("从预设读到导出格式", () => {
  it("只读 format 一个字段并规范化大小写", () => {
    expect(exportPresetFormat({ format: "JPEG" })).toBe("jpeg");
    expect(exportPresetFormat({ format: "  " })).toBeNull();
    expect(exportPresetFormat({ mode: "export" })).toBeNull();
    expect(exportPresetFormat(null)).toBeNull();
  });
});
