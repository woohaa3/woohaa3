/**
 * 画板/切片导出（U56）的域内回归。
 *
 * 替身句柄覆盖三件事：计划解析的严格性、逐项交付的顺序与失败短路、以及「宿主没有文件端口」
 * 必须明确拒绝而不是假装成功。不加载 wasm。
 */
import { describe, expect, it, vi } from "vitest";
import type { EditorFilePort } from "../../ports.js";
import { exportCompositionArtifacts, parseExportPlan, type CompositionExportHost } from "./export.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function host(overrides: Partial<CompositionExportHost> = {}): CompositionExportHost {
  return {
    compositionExportPlan: () => ({
      ok: true,
      value: {
        files: [
          { fileName: "doc_01.png", name: "doc_01", rect: [0, 0, 10, 10] },
          { fileName: "doc_02.png", name: "doc_02", rect: [10, 0, 5, 5] }
        ]
      }
    }),
    compositionExportPng: () => ({ ok: true, value: PNG }),
    ...overrides
  };
}

describe("parseExportPlan", () => {
  it("接受内核计划并保留顺序", () => {
    const parsed = parseExportPlan({ files: [{ fileName: "a.png", name: "a", rect: [1, 2, 3, 4] }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual([{ fileName: "a.png", name: "a", rect: [1, 2, 3, 4] }]);
  });

  it("空计划与结构非法都给出具体原因", () => {
    for (const [input, fragment] of [
      [null, "为空"],
      [{}, "没有文件"],
      [{ files: [] }, "没有文件"],
      [{ files: [{}] }, "缺少文件名"],
      [{ files: [{ fileName: "a.png" }] }, "缺少名称"],
      [{ files: [{ fileName: "a.png", name: "a", rect: [0, 0, 1] }] }, "范围非法"],
      [{ files: [{ fileName: "a.png", name: "a", rect: [0, 0, 0, 5] }] }, "范围为空"]
    ] as const) {
      const parsed = parseExportPlan(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain(fragment);
    }
  });
});

describe("exportCompositionArtifacts", () => {
  it("按计划顺序逐项导出，并把每个 rect 交给内核", async () => {
    const rects: unknown[] = [];
    const delivery: EditorFilePort = vi.fn(async () => ({ ok: true, status: "written" }) as const);
    const result = await exportCompositionArtifacts(
      host({
        compositionExportPng: (rect) => {
          rects.push(rect);
          return { ok: true, value: PNG };
        }
      }),
      "slices",
      delivery
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.delivered).toEqual(["doc_01.png", "doc_02.png"]);
    expect(result.value.written).toBe(true);
    expect(rects).toEqual([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 10, y: 0, width: 5, height: 5 }
    ]);
  });

  it("没有宿主文件端口时明确拒绝", async () => {
    const result = await exportCompositionArtifacts(host(), "artboards", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("不支持本地文件保存");
  });

  it("中途失败即短路，不继续交付剩余产物", async () => {
    const delivery = vi.fn(async () => ({ ok: false, status: "failed", message: "磁盘已满" }) as const);
    const result = await exportCompositionArtifacts(host(), "slices", delivery);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("磁盘已满");
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it("只发起下载时保留「未确认写入」语义", async () => {
    const delivery: EditorFilePort = async () => ({ ok: true, status: "download-started" });
    const result = await exportCompositionArtifacts(host(), "slices", delivery);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.written).toBe(false);
  });

  it("内核计划失败时不渲染任何产物", async () => {
    const png = vi.fn(() => ({ ok: true as const, value: PNG }));
    const delivery: EditorFilePort = async () => ({ ok: true, status: "written" });
    const result = await exportCompositionArtifacts(
      host({ compositionExportPlan: () => ({ ok: false, code: "command-failed", message: "文档里没有切片可导出" }), compositionExportPng: png }),
      "slices",
      delivery
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("没有切片");
    expect(png).not.toHaveBeenCalled();
  });
});
