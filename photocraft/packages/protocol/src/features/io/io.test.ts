/**
 * 栅格交换域协议测试（change: 2026-10-22-add-photocraft-raster-interchange）。
 *
 * 覆盖：预算与 `rust/project-limits.json` 的关系、设置归一化的拒绝条件、预设与报告的严格解码、
 * 交付文件名的有界与安全。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_WEB_SETTINGS,
  EXPORT_FORMATS,
  INTERCHANGE_BUDGETS,
  INTERCHANGE_CAPABILITIES,
  WEB_FORMATS,
  decodeAssetReport,
  decodeBundleInspection,
  decodeExportPresets,
  decodeExportReport,
  decodeLayerBundleReport,
  deliveryFileName,
  feature,
  normalizeExportSettings
} from "./index.js";

const limits = JSON.parse(
  readFileSync(new URL("../../../../../rust/project-limits.json", import.meta.url), "utf8")
) as Record<string, number>;

describe("交换预算", () => {
  it("不抬高工程上限，并与 project-limits.json 对齐", () => {
    expect(INTERCHANGE_BUDGETS.maxExportDimension).toBeLessThanOrEqual(limits.maxCanvasSide!);
    expect(INTERCHANGE_BUDGETS.maxExportPixels).toBeLessThanOrEqual(limits.maxCanvasPixels!);
    expect(INTERCHANGE_BUDGETS.maxLayerBundlePixels).toBeLessThanOrEqual(limits.maxCanvasPixels!);
    expect(INTERCHANGE_BUDGETS.maxAssetPixels).toBeLessThanOrEqual(limits.maxCanvasPixels!);
    expect(INTERCHANGE_BUDGETS.maxLayerBundleBytes).toBeLessThanOrEqual(limits.maxDecompressedResourceBytes!);
    expect(INTERCHANGE_BUDGETS.maxAssetBytes).toBeLessThanOrEqual(limits.maxDecompressedResourceBytes!);
    expect(INTERCHANGE_BUDGETS.maxLayerBundleFiles).toBeLessThanOrEqual(limits.maxLayers!);
  });

  it("每种预算都给了正整数，域内声明与阶段清单分开", () => {
    for (const [key, value] of Object.entries(INTERCHANGE_BUDGETS)) {
      if (key.startsWith("$")) continue;
      expect(Number.isInteger(value), key).toBe(true);
      expect(value, key).toBeGreaterThan(0);
    }
    expect(INTERCHANGE_CAPABILITIES).toContain("format.export");
    // 共享阶段清单里没有本 change 的能力（登记属于集成负责人）。
    const staged = feature.capabilities.map((entry) => entry.id);
    for (const id of INTERCHANGE_CAPABILITIES) expect(staged).not.toContain(id);
  });
});

describe("导出设置归一化", () => {
  it("接受默认值与合法组合", () => {
    expect(normalizeExportSettings(DEFAULT_EXPORT_SETTINGS)).toEqual({ ok: true, value: DEFAULT_EXPORT_SETTINGS });
    expect(normalizeExportSettings(DEFAULT_WEB_SETTINGS)).toEqual({ ok: true, value: DEFAULT_WEB_SETTINGS });
    const sized = normalizeExportSettings({ format: "png", percent: 50, pngCompression: "best", interlaced: true });
    expect(sized.ok && sized.value.percent).toBe(50);
    const web = normalizeExportSettings({ mode: "web", format: "gif", colors: 32, dither: "none" });
    expect(web.ok && web.value.format).toBe("gif");
  });

  it("拒绝未知格式、越界数值、互斥尺寸与非布尔开关", () => {
    for (const value of [
      null,
      [],
      { format: "exr" },
      { format: "pcx" },
      { mode: "web", format: "tif" },
      { mode: "web", format: "wbmp" },
      { mode: "save" },
      { format: "jpg", quality: 0 },
      { format: "jpg", quality: 101 },
      { format: "jpg", quality: 1.5 },
      { format: "webp", webpQuality: 0 },
      { format: "png", width: 0 },
      { format: "png", width: INTERCHANGE_BUDGETS.maxExportDimension + 1 },
      { format: "png", percent: 50, width: 10 },
      { format: "png", percent: 0 },
      { format: "png", percent: 1001 },
      { format: "png", transparency: "yes" },
      { format: "tif", tiffCompression: "zip" },
      { format: "png", pngCompression: "bestest" },
      { format: "jpg", metadata: "everything" },
      { mode: "web", format: "gif", colors: 1 },
      { mode: "web", format: "gif", colors: 257 },
      { mode: "web", format: "gif", dither: "random" },
      { format: "jpg", preset: "" },
      { format: "jpg", preset: "x".repeat(INTERCHANGE_BUDGETS.maxPresetNameLength + 1) }
    ]) {
      expect(normalizeExportSettings(value).ok, JSON.stringify(value)).toBe(false);
    }
    expect(EXPORT_FORMATS).not.toContain("exr" as never);
    expect(WEB_FORMATS).not.toContain("wbmp" as never);
  });

  it("只做客户端能判定的检查，不猜测能力", () => {
    // 有 alpha 的格式与无 alpha 的格式都通过：能否透明由内核按真实构建判定。
    expect(normalizeExportSettings({ format: "jpg" }).ok).toBe(true);
    expect(normalizeExportSettings({ format: "png" }).ok).toBe(true);
    // 未指定的字段保持缺省，不由客户端补一套「友好默认」。
    const value = normalizeExportSettings({ format: "webp" });
    expect(value.ok && value.value.quality).toBeUndefined();
    expect(value.ok && value.value.transparency).toBeUndefined();
  });
});

describe("预设与报告解码", () => {
  it("预设：有界、名字唯一、设置合法", () => {
    const presets = decodeExportPresets([
      { name: "网页 JPEG", settings: { format: "jpg", quality: 60 } },
      { name: "无损 PNG", settings: { format: "png", pngCompression: "best" } }
    ]);
    expect(presets.ok && presets.value).toHaveLength(2);
    expect(decodeExportPresets("no").ok).toBe(false);
    expect(decodeExportPresets([{ name: "a", settings: { format: "jpg" } }, { name: "a", settings: { format: "png" } }]).ok).toBe(false);
    expect(decodeExportPresets([{ name: "", settings: { format: "jpg" } }]).ok).toBe(false);
    expect(decodeExportPresets([{ name: "x", settings: { format: "exr" } }]).ok).toBe(false);
    const tooMany = Array.from({ length: INTERCHANGE_BUDGETS.maxExportPresets + 1 }, (_, index) => ({
      name: `p${index}`,
      settings: { format: "jpg" }
    }));
    expect(decodeExportPresets(tooMany).ok).toBe(false);
  });

  it("导出报告必须声明不改动文档，且字段完整", () => {
    const report = {
      kind: "export",
      format: "jpg",
      width: 32,
      height: 24,
      bytes: 1024,
      revision: 3,
      documentContentHash: "abcd",
      documentChanged: false
    };
    expect(decodeExportReport(report).ok).toBe(true);
    expect(decodeExportReport({ ...report, documentChanged: true }).ok).toBe(false);
    expect(decodeExportReport({ ...report, kind: "assets" }).ok).toBe(false);
    expect(decodeExportReport({ ...report, bytes: "1024" }).ok).toBe(false);
    expect(decodeExportReport({ ...report, documentContentHash: undefined }).ok).toBe(false);
    expect(decodeExportReport(null).ok).toBe(false);
  });

  it("逐层与资产报告的计数必须自洽", () => {
    const layerReport = {
      kind: "layers",
      format: "png",
      revision: 1,
      documentContentHash: "h",
      files: [{ fileName: "a.png", layerId: 1, name: "a", ok: true }],
      okCount: 1,
      failedCount: 0,
      totalBytes: 10,
      renames: [],
      rejected: [],
      documentChanged: false
    };
    expect(decodeLayerBundleReport(layerReport).ok).toBe(true);
    expect(decodeLayerBundleReport({ ...layerReport, okCount: 2 }).ok).toBe(false);
    expect(decodeLayerBundleReport({ ...layerReport, kind: "assets" }).ok).toBe(false);
    expect(decodeLayerBundleReport({ ...layerReport, documentChanged: true }).ok).toBe(false);

    const assetReport = {
      kind: "assets",
      revision: 1,
      documentContentHash: "h",
      files: [{ fileName: "a.png", layerId: 1, layerName: "a.png", requested: "a.png", ok: true }],
      okCount: 1,
      failedCount: 0,
      totalBytes: 10,
      renames: [],
      rejected: [],
      documentChanged: false
    };
    expect(decodeAssetReport(assetReport).ok).toBe(true);
    expect(decodeAssetReport({ ...assetReport, files: "none" }).ok).toBe(false);
    expect(decodeAssetReport({ ...assetReport, kind: "layers" }).ok).toBe(false);
  });

  it("包复核结果逐条校验，失败项不抛异常", () => {
    expect(decodeBundleInspection({ files: [{ name: "a.png", bytes: 4 }], report: { kind: "layers" }, bytes: 20 }).ok).toBe(true);
    expect(decodeBundleInspection({ files: [{ name: "a.png" }], bytes: 20 }).ok).toBe(false);
    expect(decodeBundleInspection({ files: [{ bytes: 4 }], bytes: 20 }).ok).toBe(false);
    expect(decodeBundleInspection({ files: [], bytes: "20" }).ok).toBe(false);
    expect(decodeBundleInspection({ files: [] }).ok).toBe(false);
  });
});

describe("交付文件名", () => {
  it("去掉目录与不可用字符，扩展名跟随真实格式", () => {
    expect(deliveryFileName("海报.pcraft", "png")).toBe("海报.png");
    expect(deliveryFileName("a/b:c*?.jpg", "webp")).toBe("a_b_c__.webp");
    expect(deliveryFileName("..hidden", "png")).toBe("hidden.png");
    expect(deliveryFileName("", "png")).toBe("未命名.png");
    expect(deliveryFileName("   ", "png")).toBe("未命名.png");
  });

  it("长度受预算约束，且始终保留扩展名", () => {
    const name = deliveryFileName("汉".repeat(400), "webp");
    expect(name.length).toBeLessThanOrEqual(INTERCHANGE_BUDGETS.maxFileNameLength);
    expect(name.endsWith(".webp")).toBe(true);
    expect(deliveryFileName("x".repeat(200), "png").length).toBeLessThanOrEqual(INTERCHANGE_BUDGETS.maxFileNameLength);
  });
});
