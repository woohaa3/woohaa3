import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  COLOR_TABLE_PRESETS,
  IMAGE_MODE_LIMITS,
  IMAGE_MODE_TARGETS,
  MODE_TOOL_IDS,
  decodeBase64,
  decodeColorTable,
  decodeDuotone,
  decodeModeInfo,
  decodeModePlan,
  decodeModeReport,
  modeExportAvailability,
  modeToolAvailability,
  unsupportedModeTools
} from "./mode-data.js";
import { modeLossText } from "./panels.js";

/**
 * 本域纯数据回归：内核 JSON 的有界解码、工具/导出矩阵与报告文案
 * （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.1）。
 */

const info = (overrides: Record<string, unknown> = {}) => ({
  mode: "rgb",
  rawMode: "Rgb",
  depth: 8,
  colorTable: null,
  duotone: null,
  layers: 2,
  targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: id !== "rgb", reason: id === "rgb" ? "当前已是 RGB 颜色" : null })),
  revision: 7,
  contentHash: "hash-1",
  readOnly: false,
  trap: { available: false, requires: "cmyk", reason: "陷印是 CMYK 印前步骤" },
  ...overrides
});

const rgba = (width: number, height: number) => {
  const bytes = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) bytes.set([index, 0, 255 - index, 255], index * 4);
  return bytes;
};
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const report = (overrides: Record<string, unknown> = {}) => ({
  target: "grayscale",
  label: "Grayscale",
  fromMode: "rgb",
  toMode: "grayscale",
  depth: 8,
  layersBefore: 3,
  layersAfter: 3,
  flattened: false,
  dropped: {},
  lossy: false,
  colorCount: null,
  colors: null,
  transparentIndex: null,
  inks: null,
  notes: ["转换为灰度合并颜色通道，图层与蒙版保留。"],
  changed: true,
  ...overrides
});

it("decodes bounded mode info and rejects malformed payloads", () => {
  const decoded = decodeModeInfo(info());
  expect(decoded).toMatchObject({ mode: "rgb", depth: 8, revision: 7, readOnly: false });
  expect(decoded?.targets.map((entry) => entry.id)).toEqual([...IMAGE_MODE_TARGETS]);
  expect(decoded?.trap).toEqual({ available: false, requires: "cmyk", reason: "陷印是 CMYK 印前步骤" });

  // 不在范围的颜色模型：`mode` 为 null，但信息仍可渲染（只读提示）。
  expect(decodeModeInfo(info({ mode: null, rawMode: "Cmyk" }))?.mode).toBeNull();
  // 结构非法一律拒绝，不渲染半截面板。
  expect(decodeModeInfo(info({ mode: "cmyk" }))).toBeNull();
  expect(decodeModeInfo(info({ targets: [] }))).toBeNull();
  // 目标必须五个各出现一次：重复 id 会让某个目标失去真实可用性。
  const duplicated = info({ targets: [...IMAGE_MODE_TARGETS.slice(0, 4).map((id) => ({ id, label: id, available: true, reason: null })), { id: "rgb", label: "rgb", available: false, reason: "dup" }] });
  expect(decodeModeInfo(duplicated)).toBeNull();
  expect(decodeModeInfo(info({ trap: { available: false, requires: "rgb", reason: "x" } }))).toBeNull();
  expect(decodeModeInfo(info({ revision: -1 }))).toBeNull();
  // `rawMode`、目标名、不可用原因、陷印原因都会原样渲染进 DOM，必须有界。
  expect(decodeModeInfo(info({ rawMode: "" }))).toBeNull();
  expect(decodeModeInfo(info({ rawMode: "x".repeat(200) }))).toBeNull();
  expect(decodeModeInfo(info({ targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: "x".repeat(200), available: true, reason: null })) }))).toBeNull();
  expect(decodeModeInfo(info({ targets: IMAGE_MODE_TARGETS.map((id) => ({ id, label: id, available: false, reason: "x".repeat(1000) })) }))).toBeNull();
  expect(decodeModeInfo(info({ trap: { available: false, requires: "cmyk", reason: "x".repeat(1000) } }))).toBeNull();
  expect(decodeModeInfo(info({ colorTable: { colors: [] } }))).toBeNull();
  expect(decodeModeInfo(info({ duotone: { inks: [] } }))).toBeNull();
  expect(decodeModeInfo(null)).toBeNull();
});

it("decodes color tables and inks with hard bounds", () => {
  expect(decodeColorTable({ colors: ["#000000", "#ffffff"], transparent: 1 })).toEqual({ colors: ["#000000", "#ffffff"], transparent: 1 });
  expect(decodeColorTable({ colors: ["#000000"], transparent: null })).toEqual({ colors: ["#000000"], transparent: null });
  // 透明索引必须落在表内；条目数必须 1–256。
  expect(decodeColorTable({ colors: ["#000000"], transparent: 1 })).toBeNull();
  expect(decodeColorTable({ colors: [], transparent: null })).toBeNull();
  expect(decodeColorTable({ colors: ["#00"] })).toBeNull();
  expect(decodeColorTable({ colors: Array.from({ length: IMAGE_MODE_LIMITS.maxTableColors + 1 }, () => "#000000") })).toBeNull();

  expect(decodeDuotone({ inks: [{ name: "Black", color: "#101010", curve: [[0, 0], [100, 90]] }] })).toEqual({
    inks: [{ name: "Black", color: "#101010", curve: [[0, 0], [100, 90]] }]
  });
  expect(decodeDuotone({ inks: [] })).toBeNull();
  expect(decodeDuotone({ inks: [{ name: "", color: "#101010", curve: [] }] })).toBeNull();
  expect(decodeDuotone({ inks: [{ name: "a", color: "#101010", curve: [[0, 101]] }] })).toBeNull();
  expect(decodeDuotone({ inks: Array.from({ length: IMAGE_MODE_LIMITS.maxInks + 1 }, () => ({ name: "a", color: "#101010", curve: [] })) })).toBeNull();
});

it("decodes base64 preview pixels and rejects truncated plans", () => {
  const pixels = rgba(4, 2);
  expect(decodeBase64(toBase64(pixels))).toEqual(pixels);
  expect(decodeBase64("")).toBeNull();
  expect(decodeBase64("not base64!")).toBeNull();

  const plan = {
    report: report(),
    preview: { width: 4, height: 2, pixelsBase64: toBase64(pixels), bytes: pixels.length },
    baseRevision: 7,
    baseContentHash: "hash-1",
    changed: true
  };
  const decoded = decodeModePlan(plan);
  expect(decoded?.preview).toEqual({ width: 4, height: 2, pixels });
  expect(decoded?.changed).toBe(true);
  expect(decoded?.baseRevision).toBe(7);
  expect(decoded?.baseContentHash).toBe("hash-1");

  // 字节数与尺寸不符、超出预览上限、缺基线都必须拒绝。
  expect(decodeModePlan({ ...plan, preview: { ...plan.preview, height: 3 } })).toBeNull();
  expect(decodeModePlan({ ...plan, preview: { ...plan.preview, width: IMAGE_MODE_LIMITS.maxPreviewSide + 1 } })).toBeNull();
  expect(decodeModePlan({ ...plan, baseRevision: -1 })).toBeNull();
  expect(decodeModePlan({ ...plan, report: { ...report(), target: "cmyk" } })).toBeNull();
  // 预算前移：声明 4×2 却夹带超长载荷时，在解码前就拒绝，不按实际载荷分配。
  const oversized = `${toBase64(pixels)}${"A".repeat(4_000_000)}`;
  expect(decodeModePlan({ ...plan, preview: { ...plan.preview, pixelsBase64: oversized } })).toBeNull();
  expect(decodeModePlan({ ...plan, preview: { ...plan.preview, pixelsBase64: toBase64(pixels.slice(0, 8)) } })).toBeNull();
});

it("decodes conversion reports including loss detail and rejects unknown layer kinds", () => {
  const decoded = decodeModeReport(report({
    target: "indexed",
    toMode: "indexed",
    flattened: true,
    dropped: { raster: 1, adjustment: 1 },
    lossy: true,
    colorCount: 2,
    colors: ["#000000", "#ffffff"],
    transparentIndex: 1
  }));
  expect(decoded).toMatchObject({ target: "indexed", colorCount: 2, transparentIndex: 1, flattened: true });
  expect(decoded?.dropped).toEqual({ raster: 1, adjustment: 1 });

  expect(decodeModeReport(report({ target: "color-table", label: "Color Table" }))?.target).toBe("color-table");
  expect(decodeModeReport(report({ dropped: { layerx: 1 } }))).toBeNull();
  expect(decodeModeReport(report({ colors: ["#000"] }))).toBeNull();
  expect(decodeModeReport(report({ inks: [{ name: "a", color: "#000000" }] }))?.inks).toEqual([{ name: "a", color: "#000000" }]);
  // 报告文案只使用解码后的结构，不猜测模式。
  expect(modeLossText(decodeModeReport(report({ flattened: true, layersBefore: 3, layersAfter: 1, dropped: { raster: 2 } }))!))
    .toBe("图层 3 → 1 · 丢弃 像素层 2");
  expect(modeLossText(decodeModeReport(report())!)).toBe("结构不变");
});

it("bounds every report field that goes straight into the DOM", () => {
  // 这些字段来自内核 JSON 并直接渲染：不设上界时，一份被篡改的响应可以塞进任意长数组。
  expect(decodeModeReport(report({ colors: Array.from({ length: IMAGE_MODE_LIMITS.maxTableColors + 1 }, () => "#000000") }))).toBeNull();
  expect(decodeModeReport(report({ notes: Array.from({ length: IMAGE_MODE_LIMITS.maxReportNotes + 1 }, () => "x") }))).toBeNull();
  // 位深只有内核的三种采样位深。
  for (const depth of [0, 1, 7, 9, 12, 64, 1e9]) {
    expect(decodeModeReport(report({ depth }))).toBeNull();
  }
  for (const depth of [8, 16, 32]) {
    expect(decodeModeReport(report({ depth }))?.depth).toBe(depth);
  }
  // 颜色数不能超过表上限，且必须与实际条目数一致。
  expect(decodeModeReport(report({ colorCount: IMAGE_MODE_LIMITS.maxTableColors + 1 }))).toBeNull();
  expect(decodeModeReport(report({ colorCount: 5, colors: ["#000000", "#ffffff"] }))).toBeNull();
  expect(decodeModeReport(report({ colorCount: 2, colors: ["#000000", "#ffffff"] }))?.colorCount).toBe(2);
  // 只报颜色数、不报颜色表的组合仍然合法（灰度等模式）。
  expect(decodeModeReport(report({ colorCount: 2 }))?.colorCount).toBe(2);
  // 报告里的油墨名会原样渲染；名称必须非空且有上界，与 `decodeDuotone`/内核一致。
  expect(decodeModeReport(report({ inks: [{ name: "", color: "#000000" }] }))).toBeNull();
  expect(decodeModeReport(report({ inks: [{ name: "x".repeat(IMAGE_MODE_LIMITS.maxInkNameLength + 1), color: "#000000" }] }))).toBeNull();
  // 上界按码点算：内核 `chars().count()` 接受 64 个 emoji，用 UTF-16 `length` 会比内核更严。
  const emoji = "🎨".repeat(IMAGE_MODE_LIMITS.maxInkNameLength);
  expect(decodeModeReport(report({ inks: [{ name: emoji, color: "#000000" }] }))?.inks?.[0]?.name).toBe(emoji);
  expect(decodeModeReport(report({ inks: [{ name: `${emoji}🎨`, color: "#000000" }] }))).toBeNull();
  expect(decodeModeReport(report({ inks: Array.from({ length: IMAGE_MODE_LIMITS.maxInks + 1 }, () => ({ name: "a", color: "#000000" })) }))).toBeNull();
});

it("keeps the tool matrix closed for modes that cannot express a tool", () => {
  // RGB 全开。
  for (const tool of MODE_TOOL_IDS) expect(modeToolAvailability("rgb", tool)).toEqual({ enabled: true, assessed: true, reason: null });
  // 位图只有几何与选区（写像素颜色的工具会被内核拒绝）。
  expect(modeToolAvailability("bitmap", "brush").enabled).toBe(false);
  expect(modeToolAvailability("bitmap", "text").enabled).toBe(false);
  expect(modeToolAvailability("bitmap", "marquee")).toEqual({ enabled: true, assessed: true, reason: null });
  expect(unsupportedModeTools("bitmap")).toEqual(["brush", "eraser", "text", "clone", "heal", "retouch"]);
  // 灰度为灰阶，彩色内容会收敛为灰色（实测 nonGray=0），因此不关闭任何工具。
  expect(modeToolAvailability("grayscale", "brush")).toEqual({ enabled: true, assessed: true, reason: null });
  expect(modeToolAvailability("grayscale", "text")).toEqual({ enabled: true, assessed: true, reason: null });
  // 索引色关闭一切写像素颜色的工具，并给出真实原因。
  expect(modeToolAvailability("indexed", "brush").reason).toContain("颜色表");
  expect(unsupportedModeTools("indexed")).toEqual(["brush", "eraser", "text", "clone", "heal", "retouch"]);
  // 双色调同样收敛为灰阶（实测文字也安全），因此全部放开——早期「关闭文字/路径」是错误声明。
  expect(modeToolAvailability("duotone", "text")).toEqual({ enabled: true, assessed: true, reason: null });
  expect(modeToolAvailability("duotone", "brush")).toEqual({ enabled: true, assessed: true, reason: null });
  expect(unsupportedModeTools("duotone")).toEqual([]);
  // 范围外的颜色模型本域**不判定**：实测 CMYK/Lab 文档上绘制与文字都能提交，
  // 因此既不能报「可用」（越权替别的域承诺），也不能报「关闭」（假的）。
  expect(modeToolAvailability(null, "move").assessed).toBe(false);
  expect(modeToolAvailability(null, "move").enabled).toBe(false);
  expect(unsupportedModeTools(null)).toEqual([]);
});

it("matches the cross-language gate contract exactly", () => {
  // 权威契约与内核 `features/modes/gate.rs` 共读同一份 fixture；这里逐项核对界面矩阵。
  const fixture = JSON.parse(
    readFileSync(new URL("../../../../protocol/src/features/modes/gate-fixtures.json", import.meta.url), "utf8")
  ) as {
    tools: Record<string, string[]>;
    neverGated: string[];
    closedByMode: Record<string, string[]>;
    colourWritingCommands: Record<string, string[]>;
  };

  // 工具清单必须一致（新增工具要同时改三处）。
  expect(Object.keys(fixture.tools).sort()).toEqual([...MODE_TOOL_IDS].sort());
  // 每种受限模式的关闭集合必须与本模块判定完全一致。
  for (const mode of ["indexed", "bitmap"] as const) {
    expect(unsupportedModeTools(mode)).toEqual(fixture.closedByMode[mode]);
  }
  // 灰度/双色调/RGB 全开，与 fixture 的「未列出即放开」一致。
  for (const mode of ["rgb", "grayscale", "duotone"] as const) {
    expect(unsupportedModeTools(mode)).toEqual([]);
  }
  // 永不门禁的工具（选区/几何/路径）不得出现在任何关闭集合里。
  for (const tools of Object.values(fixture.closedByMode)) {
    for (const tool of fixture.neverGated) expect(tools).not.toContain(tool);
  }
  // 受限模式下每个关闭工具都必须有代表命令可供内核拒绝（空命令意味着没法验证）。
  for (const mode of ["indexed", "bitmap"] as const) {
    for (const tool of fixture.closedByMode[mode]) {
      expect(fixture.tools[tool].length).toBeGreaterThan(0);
      for (const command of fixture.tools[tool]) {
        expect(fixture.colourWritingCommands[mode]).toContain(command);
      }
    }
  }
});

it("maps export targets to modes that can express them", () => {
  expect(modeExportAvailability("rgb", "png")).toEqual({ enabled: true, assessed: true, reason: null });
  expect(modeExportAvailability("indexed", "png")).toEqual({ enabled: true, assessed: true, reason: "索引色写出 8 位调色板 PNG" });
  expect(modeExportAvailability("duotone", "png")).toEqual({ enabled: true, assessed: true, reason: "双色调按油墨渲染为 RGB PNG" });
  // 共享 PSD 导出在预检阶段就拒绝非 RGB/U8 文档：凡是内核会拒绝的组合，面板必须同样关闭并说明，
  // 否则用户会看到一个点下去必然失败的导出入口（实测灰度/位图/索引色/双色调都被拒绝）。
  expect(modeExportAvailability("rgb", "psd")).toEqual({ enabled: true, assessed: true, reason: null });
  for (const mode of ["grayscale", "bitmap", "indexed", "duotone"] as const) {
    const psd = modeExportAvailability(mode, "psd");
    expect(psd.enabled).toBe(false);
    expect(psd.assessed).toBe(true);
    expect(psd.reason).toContain("RGB/U8");
  }
  // PNG 与工程保存对五种模式都成立（真实导出字节由真实 WASM 冒烟覆盖）。
  for (const mode of IMAGE_MODE_TARGETS) {
    expect(modeExportAvailability(mode, "png").enabled).toBe(true);
    expect(modeExportAvailability(mode, "project").enabled).toBe(true);
  }
  // 范围外颜色模型：实测能保存工程、导出 RGB PNG（见 verification.md 的 CMYK/Lab 实测），
  // 但 PSD 仍被共享预检拒绝。矩阵必须分别说明，而不是一律报「关闭」。
  for (const target of ["png", "project"] as const) {
    const support = modeExportAvailability(null, target);
    expect(support.enabled).toBe(true);
    expect(support.assessed).toBe(false);
    expect(support.reason).toContain("不在本次模式范围");
  }
  expect(modeExportAvailability(null, "psd")).toEqual({
    enabled: false,
    assessed: true,
    reason: "PSD 导出只支持 RGB/U8 文档；当前色彩模型不在本次模式范围"
  });
  // 颜色表预设清单与内核一致（custom 表示只改条目）。
  expect(COLOR_TABLE_PRESETS[0]).toBe("custom");
  expect(COLOR_TABLE_PRESETS).toHaveLength(7);
});
