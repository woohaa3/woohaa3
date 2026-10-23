/**
 * 栅格交换域会话的回归（change: 2026-10-22-add-photocraft-raster-interchange，U05/U06/U07）。
 *
 * 用替身内核锁定**域内**契约，真实编码像素在 Rust 侧测试：
 * - 报告不可信：形状不对/内容指纹被改写/`documentChanged` 非 false 一律拒绝；
 * - 预览与交付共用同一份设置与编码入口，且都不推进工程基线；
 * - 草稿期间拒绝交付，避免把半成品当成品；
 * - 打开只给预检结论，不在这里替换文档。
 */
import { describe, expect, it } from "vitest";
import { EditorHandle } from "../../editor-wasm.js";
import { createSession } from "./workspace.js";
import type { WorkspaceFeatureContext } from "../workspace-context.js";
import type { EditorFailure, EditorHandle as Handle } from "../../editor-wasm.js";
import type { EditorViewModel } from "../../editor-view-model.js";

const HASH = "0123456789abcdef";

const view = (name = "art"): EditorViewModel => ({
  hasDocument: true,
  sessionActiveIndex: 0,
  document: { name } as EditorViewModel["document"]
});

type Encoded = { bytes: Uint8Array; reportJson: string; free?: () => void };

function exportReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "export",
    mode: "export",
    format: "jpg",
    mime: "image/jpeg",
    width: 8,
    height: 6,
    bytes: 3,
    revision: 4,
    documentContentHash: HASH,
    settings: {},
    warnings: [],
    lossy: true,
    colors: null,
    transparentIndex: null,
    preview: false,
    documentChanged: false,
    ...overrides
  });
}

function bundleReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "layers",
    format: "png",
    revision: 4,
    documentContentHash: HASH,
    files: [{ fileName: "a.png", layerId: 1, name: "A", ok: true }],
    okCount: 1,
    failedCount: 0,
    totalBytes: 3,
    renames: [],
    rejected: [],
    documentChanged: false,
    ...overrides
  });
}

function assetReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "assets",
    revision: 4,
    documentContentHash: HASH,
    files: [{ fileName: "图标.png", layerId: 2, layerName: "图标", requested: "图标.png", ok: true }],
    okCount: 1,
    failedCount: 0,
    totalBytes: 3,
    renames: [],
    rejected: [],
    documentChanged: false,
    ...overrides
  });
}

function setup(options: { overrides?: Record<string, unknown>; draft?: boolean } = {}) {
  const calls: string[] = [];
  const freed: number[] = [];
  let live = 0;
  const encoded = (report: string): Encoded => {
    live += 1;
    return {
      bytes: new Uint8Array([1, 2, 3]),
      reportJson: report,
      free: () => { freed.push(live); }
    };
  };
  const instance = {
    interchangeMatrixJson: () => {
      calls.push("matrix");
      return JSON.stringify({
        formats: [
          { id: "png", name: "PNG", extensions: ["png", "apng"], mime: "image/png", status: "open", read: true },
          { id: "tif", name: "TIFF", extensions: ["tif", "tiff"], mime: "image/tiff", status: "read-only", read: true },
          { id: "exr", name: "OpenEXR", extensions: ["exr"], mime: "image/x-exr", status: "deferred", read: false }
        ],
        openable: ["png", "apng", "tif", "tiff"],
        exportable: ["jpg"],
        budgets: {},
        capabilities: []
      });
    },
    inspectRaster: (bytes: Uint8Array) => {
      calls.push(`inspect-raster:${bytes.length}`);
      return JSON.stringify({ format: "tif", status: "read-only", width: 8, height: 6 });
    },
    openRaster: (name: string, bytes: Uint8Array) => {
      calls.push(`open-raster:${name}:${bytes.length}`);
      return JSON.stringify({ raster: { format: "tif", readOnly: true }, documentChanged: true });
    },
    exportMatrixJson: () => { calls.push("export-matrix"); return "[]"; },
    inspectExport: (params: string) => { calls.push(`inspect-export:${params}`); return exportReport({ preview: true }); },
    previewExport: (params: string) => { calls.push(`preview:${params}`); return encoded(exportReport({ preview: true })); },
    exportRaster: (params: string) => { calls.push(`export:${params}`); return encoded(exportReport()); },
    inspectLayerExport: (params: string) => {
      calls.push(`layer-plan:${params}`);
      return bundleReport();
    },
    exportLayerBundle: (params: string) => { calls.push(`layer-bundle:${params}`); return encoded(bundleReport()); },
    exportLayerAs: (params: string) => {
      calls.push(`layer-as:${params}`);
      return encoded(exportReport({ kind: "layer-export", layerName: "前景", format: "png", mime: "image/png" }));
    },
    inspectImageAssets: () => { calls.push("asset-plan"); return assetReport(); },
    exportImageAssets: () => { calls.push("asset-bundle"); return encoded(assetReport()); },
    inspectIoBundle: (bytes: Uint8Array) => {
      calls.push(`inspect-bundle:${bytes.length}`);
      return JSON.stringify({ files: [{ name: "a.png", bytes: 3 }, { name: "report.json", bytes: 9 }], report: { kind: "layers" }, bytes: 12 });
    },
    ...options.overrides
  };
  const handle = new EditorHandle(instance as never, {
    upstreamCommit: "pinned",
    upstreamVersion: "0.9.0",
    engineVersion: "photocraft-v1",
    formatVersion: 1
  });
  const blocking: EditorFailure = { ok: false, code: "gesture-active", message: "请先结算当前草稿" };
  const context: WorkspaceFeatureContext = {
    owner: { documentId: null, generation: 0 },
    saving: false,
    frozen: () => null,
    documentGeneration: () => 0,
    blockingDraftExceptVector: () => null,
    writesFrozen: () => false,
    vectorToken: () => ({ generation: 0, session: null }),

    handle: handle as Handle,
    view: view(),
    selectionModifyActive: false,
    retouchActive: false,
    filterActive: false,
    composeActive: false,
    hasActiveDraft: () => options.draft === true,
    blockingDraft: () => (options.draft === true ? blocking : null),
    unavailable: () => ({ ok: false, code: "unavailable", message: "内核未就绪" }),
    fail: (failure) => failure,
    afterWrite: () => ({ ok: true, value: view() })
  };
  return { io: createSession(() => context), calls, freed, context };
}

describe("宿主打开端口（accept 来自内核矩阵）", () => {
  it("只列出真实可打开的扩展名与 MIME，暂缓格式不进 accept", () => {
    const { io } = setup();
    const accept = io.openAccept();
    expect(accept.ok).toBe(true);
    if (!accept.ok) throw new Error("unreachable");
    // 全部可打开格式都在，宿主不需要各自硬编码三格式。
    expect(accept.value.extensions).toEqual(["png", "apng", "tif", "tiff"]);
    expect(accept.value.mimes).toEqual(["image/png", "image/tiff"]);
    expect(accept.value.accept).toContain(".tiff");
    expect(accept.value.accept).toContain("image/tiff");
    // 暂缓格式出现在 accept 里只会让用户选中后立刻被拒绝。
    expect(accept.value.extensions).not.toContain("exr");
    expect(accept.value.accept).not.toContain("image/x-exr");
  });

  it("矩阵缺少可打开行时明确失败，而不是给出空 accept", () => {
    const { io } = setup({
      overrides: {
        interchangeMatrixJson: () => JSON.stringify({
          formats: [{ id: "exr", name: "OpenEXR", extensions: ["exr"], mime: "image/x-exr", status: "deferred" }]
        })
      }
    });
    expect(io.openAccept()).toMatchObject({ ok: false, code: "invalid-matrix" });
  });

  it("旧内核缺矩阵时沿用能力协商失败，不是崩溃", () => {
    const { io } = setup({ overrides: { interchangeMatrixJson: undefined } });
    expect(io.openAccept()).toMatchObject({ ok: false, code: "capability-disabled" });
  });
});

describe("内核产物协商", () => {
  it("旧内核缺少本域导出时给出可读失败，而不是 TypeError", () => {
    const { io, calls } = setup({
      overrides: {
        // 旧产物：没有本 change 的 13 个导出。
        interchangeMatrixJson: undefined,
        inspectRaster: undefined,
        openRaster: undefined,
        exportMatrixJson: undefined,
        inspectExport: undefined,
        previewExport: undefined,
        exportRaster: undefined,
        inspectLayerExport: undefined,
        exportLayerBundle: undefined,
        exportLayerAs: undefined,
        inspectImageAssets: undefined,
        exportImageAssets: undefined,
        inspectIoBundle: undefined
      }
    });
    expect(io.matrix()).toMatchObject({ ok: false, code: "capability-disabled" });
    expect(io.exportRaster({ mode: "export", format: "jpg" })).toMatchObject({ ok: false, code: "capability-disabled" });
    expect(io.inspectOpenRaster(new Uint8Array([1]))).toMatchObject({ ok: false, code: "capability-disabled" });
    const message = (io.matrix() as { message: string }).message;
    expect(message).toContain("请更新 WASM 产物");
    // 失败发生在调用内核之前，不会产生半次调用。
    expect(calls).toEqual([]);
  });
});

describe("打开准入（U05）", () => {
  it("只返回预检结论：可编辑打开与只读都算 openable，不在这里替换文档", () => {
    const { io, calls } = setup();
    const result = io.inspectOpenRaster(new Uint8Array([1, 2]));
    expect(result).toMatchObject({ ok: true, value: { format: "tif", status: "read-only", openable: true } });
    expect(calls).toEqual(["inspect-raster:2"]);
  });

  it("暂缓格式不可打开，空文件在调用内核前就被拒绝", () => {
    const { io, calls } = setup({ overrides: { inspectRaster: () => JSON.stringify({ format: "exr", status: "deferred" }) } });
    expect(io.inspectOpenRaster(new Uint8Array([1]))).toMatchObject({ ok: true, value: { openable: false } });
    expect(io.inspectOpenRaster(new Uint8Array())).toMatchObject({ ok: false, code: "import-failed" });
    expect(calls).toEqual([]);
  });

  it("矩阵与导出选项来自真实构建，不是前端常量", () => {
    const { io, calls } = setup();
    expect(io.matrix()).toMatchObject({ ok: true });
    expect(io.exportOptions()).toMatchObject({ ok: true, value: [] });
    expect(calls).toEqual(["matrix", "export-matrix"]);
  });
});

describe("导出与 Save for Web（U06）", () => {
  it("预览与交付走同一设置，报告解码后带文件名与 MIME，且都只读", () => {
    const { io, calls, freed } = setup();
    const settings = { mode: "export", format: "jpg", quality: 70 };
    const preview = io.previewExport(settings);
    const delivered = io.exportRaster(settings);
    expect(preview).toMatchObject({ ok: true, value: { fileName: "art.jpg", contentType: "image/jpeg" } });
    expect(delivered).toMatchObject({ ok: true, value: { fileName: "art.jpg", contentType: "image/jpeg" } });
    expect((delivered as { value: { report: { documentChanged: boolean } } }).value.report.documentChanged).toBe(false);
    // 内核只收到归一化后的设置；默认值补齐但不改写用户给出的值。
    expect(calls[0]).toBe(`preview:${JSON.stringify({ mode: "export", format: "jpg", quality: 70 })}`);
    expect(calls[1]).toBe(`export:${JSON.stringify({ mode: "export", format: "jpg", quality: 70 })}`);
    expect(freed).toHaveLength(2);
  });

  it("Save for Web 只接受文档化的四个格式词，与显式 format 冲突时拒绝", () => {
    const { io, calls } = setup();
    // 客户端只放行面板提供的词（png24/png8/gif/jpeg）。内核虽然把 `jpg`/`png`/`png32`
    // 也当别名，但那属于上游宽松解析；界面不该依赖未文档化的别名。
    expect(io.exportRaster({ mode: "web", format: "jpg" })).toMatchObject({ ok: false, code: "invalid-export-settings" });
    expect(io.exportRaster({ mode: "web", format: "png24", colors: 64 })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("尺寸三选一互斥，越界在客户端就拒绝", () => {
    const { io } = setup();
    expect(io.exportRaster({ mode: "export", format: "png", percent: 50, width: 10 })).toMatchObject({ ok: false });
    expect(io.exportRaster({ mode: "export", format: "png", width: 999_999 })).toMatchObject({ ok: false });
    expect(io.exportRaster({ mode: "export", format: "png", quality: 101 })).toMatchObject({ ok: false });
    expect(io.exportRaster({ mode: "export", format: "exr" })).toMatchObject({ ok: false });
  });

  it("报告被改写时拒绝：内容指纹缺失或声称改动了文档都不算成功", () => {
    const missingHash = setup({ overrides: { exportRaster: () => ({ bytes: new Uint8Array([1]), reportJson: exportReport({ documentContentHash: undefined }) }) } });
    expect(missingHash.io.exportRaster({ mode: "export", format: "jpg" })).toMatchObject({ ok: false, code: "invalid-export-report" });
    const changed = setup({ overrides: { exportRaster: () => ({ bytes: new Uint8Array([1]), reportJson: exportReport({ documentChanged: true }) }) } });
    expect(changed.io.exportRaster({ mode: "export", format: "jpg" })).toMatchObject({ ok: false, code: "invalid-export-report" });
    const broken = setup({ overrides: { exportRaster: () => ({ bytes: new Uint8Array([1]), reportJson: "{ not json" }) } });
    expect(broken.io.exportRaster({ mode: "export", format: "jpg" })).toMatchObject({ ok: false, code: "invalid-report" });
  });

  it("导出预检与预览/交付走同一份设置，且不编码", () => {
    const { io, calls } = setup();
    const preflight = io.inspectExport({ mode: "export", format: "webp", quality: 90 });
    expect(preflight.ok).toBe(true);
    // 预检只调一次预检绑定，不触发 preview/export 编码。
    expect(calls.filter((call) => call.startsWith("inspect-export:"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("preview:") || call.startsWith("export:"))).toBe(false);
    // 客户端能判定的非法设置不进内核。
    expect(io.inspectExport({ mode: "export", format: "exr" })).toMatchObject({ ok: false });
    expect(io.inspectExport({ mode: "export", format: "png", width: 10, percent: 50 })).toMatchObject({ ok: false });
    expect(calls.filter((call) => call.startsWith("inspect-export:"))).toHaveLength(1);
  });

  it("草稿期间预检、预览与交付都拒绝，且不调用内核", () => {
    const { io, calls } = setup({ draft: true });
    expect(io.inspectExport({ mode: "export", format: "jpg" })).toMatchObject({ ok: false, code: "gesture-active" });
    expect(io.previewExport({ mode: "export", format: "jpg" })).toMatchObject({ ok: false, code: "gesture-active" });
    expect(io.exportRaster({ mode: "export", format: "jpg" })).toMatchObject({ ok: false, code: "gesture-active" });
    expect(calls).toEqual([]);
  });
});

describe("逐层与按名称资产（U07）", () => {
  it("逐层包与资产包都是内存 ZIP，文件名带文档名", () => {
    const { io } = setup();
    expect(io.exportLayerBundle({ format: "png" })).toMatchObject({
      ok: true,
      value: { fileName: "art-图层.zip", contentType: "application/zip" }
    });
    expect(io.exportImageAssets()).toMatchObject({
      ok: true,
      value: { fileName: "art-assets.zip", contentType: "application/zip" }
    });
  });

  it("单层 Export As 用报告里的真实格式与图层名命名", () => {
    const { io } = setup();
    expect(io.exportLayerAs({ format: "png" })).toMatchObject({
      ok: true,
      value: { fileName: "art-前景.png", contentType: "image/png" }
    });
  });

  it("计划与交付同源：计划里的失败项可由报告定位", () => {
    const { io } = setup({
      overrides: {
        exportLayerBundle: () => ({
          bytes: new Uint8Array([1]),
          reportJson: bundleReport({
            files: [{ fileName: "a.png", layerId: 1, name: "A", ok: true }, { fileName: "b.png", layerId: 2, name: "B", ok: false, error: "无可见像素" }],
            okCount: 1,
            failedCount: 1
          })
        })
      }
    });
    const delivered = io.exportLayerBundle({ format: "png" });
    expect(delivered).toMatchObject({ ok: true });
    if (!delivered.ok) throw new Error("unreachable");
    expect(delivered.value.report.failedCount).toBe(1);
    expect(delivered.value.report.files.filter((file) => !file.ok)).toEqual([
      { fileName: "b.png", layerId: 2, name: "B", ok: false, error: "无可见像素" }
    ]);
  });

  it("报告计数与文件列表不一致时拒绝，避免界面显示错误总数", () => {
    const { io } = setup({ overrides: { exportLayerBundle: () => ({ bytes: new Uint8Array([1]), reportJson: bundleReport({ okCount: 5 }) }) } });
    expect(io.exportLayerBundle({ format: "png" })).toMatchObject({ ok: false, code: "invalid-report" });
  });

  it("包复核报告不可信时拒绝，空包在调用内核前就失败", () => {
    const { io, calls } = setup({ overrides: { inspectIoBundle: () => JSON.stringify({ files: [{ name: 1 }], bytes: 2 }) } });
    expect(io.inspectBundle(new Uint8Array([1]))).toMatchObject({ ok: false, code: "invalid-bundle" });
    expect(io.inspectBundle(new Uint8Array())).toMatchObject({ ok: false, code: "invalid-bundle" });
    expect(calls).toEqual([]);
  });

  it("可复核已交付的包：条目与 report.json 都返回", () => {
    const { io } = setup();
    expect(io.inspectBundle(new Uint8Array([1, 2]))).toMatchObject({
      ok: true,
      value: { bytes: 12, files: [{ name: "a.png", bytes: 3 }, { name: "report.json", bytes: 9 }], report: { kind: "layers" } }
    });
  });
});
