/**
 * 置入图片与 PSD 交付适配回归
 * （change: 2026-10-22-complete-photocraft-webui-editing，任务 4.4/5.3/5.4）。
 *
 * 只验证适配层的契约：真实字节预检后才置入、置入只作用于当前文档、PSD 交付不宣称落盘。
 * 内核的 PSD 解析与损失报告在子项目 Rust 测试。
 */
import { describe, expect, it, vi } from "vitest";
import { deliverPsd, PLACE_IMAGE_ACCEPT, placeImageFile, type PickedFile } from "../src/place-file.js";
import { OPEN_RASTER_ACCEPT, OPEN_RASTER_EXTENSIONS } from "@woohaa3/photocraft-protocol";

function file(name = "pic.png", bytes = [1, 2, 3, 4]): PickedFile {
  return { name, type: "image/png", bytes: new Uint8Array(bytes) };
}

type InspectResult = { ok: true; value: unknown } | { ok: false; message: string };
type PlaceResult = { ok: true; value: unknown } | { ok: false; message: string };

function controller(overrides: { inspect?: InspectResult; place?: PlaceResult } = {}) {
  const calls: string[] = [];
  return {
    calls,
    inspectPlace: (bytes: Uint8Array): InspectResult => {
      calls.push(`inspect:${bytes.length}`);
      return overrides.inspect ?? { ok: true, value: { width: 20, height: 16, format: "Png" } };
    },
    placeAsset: (input: { name: string; bytes: Uint8Array; assetId?: string; mode?: "pixel" | "smartObject" }): PlaceResult => {
      calls.push(`place:${input.mode ?? "pixel"}:${input.assetId ?? "-"}`);
      return overrides.place ?? { ok: true, value: { placedLayer: 2 } };
    },
    currentView: () => ({ document: { width: 100, height: 80 } })
  };
}

describe("置入图片适配（任务 4.4）", () => {
  it("先真实解码预检，再置入并保留模式选择", async () => {
    const target = controller();
    const outcome = await placeImageFile(target, file());
    expect(outcome).toEqual({ ok: true, name: "pic.png", mode: "pixel" });
    expect(target.calls[0]).toBe("inspect:4");
    expect(target.calls[1]).toMatch(/^place:pixel:/);
  });

  it("预检失败不置入，原因原样返回", async () => {
    const target = controller({ inspect: { ok: false, message: "无法解码素材：unsupported" } });
    const outcome = await placeImageFile(target, file());
    expect(outcome).toEqual({ ok: false, reason: "无法解码素材：unsupported" });
    expect(target.calls.some((call) => call.startsWith("place:"))).toBe(false);
  });

  it("尺寸无效时拒绝，而不是把 0×0 当作合法素材", async () => {
    const target = controller({ inspect: { ok: true, value: { width: 0, height: 16 } } });
    expect(await placeImageFile(target, file())).toEqual({ ok: false, reason: "图片尺寸无效" });
    expect(target.calls.some((call) => call.startsWith("place:"))).toBe(false);
  });

  it("内核置入失败保留文档并返回原因", async () => {
    const target = controller({ place: { ok: false, message: "图层已达上限（64 层）" } });
    expect(await placeImageFile(target, file())).toEqual({ ok: false, reason: "图层已达上限（64 层）" });
  });

  it("显式要求嵌入智能对象时透传模式", async () => {
    const target = controller();
    const outcome = await placeImageFile(target, file(), "smartObject");
    expect(outcome.ok && outcome.mode).toBe("smartObject");
    expect(target.calls.some((call) => call.startsWith("place:smartObject:"))).toBe(true);
  });
});

describe("置入的文件选择范围（与打开同源）", () => {
  it("接受全部可打开栅格，不再硬编码三种 MIME", () => {
    // 缺陷版本这里是 "image/png,image/jpeg,image/webp"：内核能解码的 TIFF/GIF/… 选不中。
    expect(PLACE_IMAGE_ACCEPT).toBe(OPEN_RASTER_ACCEPT);
    for (const extension of OPEN_RASTER_EXTENSIONS) expect(PLACE_IMAGE_ACCEPT).toContain(`.${extension}`);
    expect(PLACE_IMAGE_ACCEPT).toContain(".tif");
    // 工程不是可置入的素材：不能混进置入清单。
    expect(PLACE_IMAGE_ACCEPT).not.toContain(".pcraft");
  });
});

describe("PSD 交付适配（任务 5.4）", () => {
  it("经文件端口交付，只报告下载已发起", async () => {
    const delivery = vi.fn(async () => ({ ok: true as const, status: "download-started" as const }));
    const result = await deliverPsd(delivery, { bytes: new Uint8Array([1]), fileName: "art.psd" });
    expect(result).toEqual({ ok: true, status: "download-started" });
    expect(delivery).toHaveBeenCalledWith({ fileName: "art.psd", contentType: "image/vnd.adobe.photoshop", bytes: new Uint8Array([1]) });
  });

  it("取消与失败如实返回，不宣称已保存", async () => {
    expect(await deliverPsd(async () => ({ ok: false as const, status: "cancelled" as const }), { bytes: new Uint8Array([1]), fileName: "a.psd" }))
      .toEqual({ ok: false, status: "cancelled" });
    expect(await deliverPsd(async () => ({ ok: false as const, status: "failed" as const, message: "磁盘已满" }), { bytes: new Uint8Array([1]), fileName: "a.psd" }))
      .toEqual({ ok: false, status: "failed", message: "磁盘已满" });
  });

  it("宿主没有文件端口时明确说明", async () => {
    const result = await deliverPsd(undefined, { bytes: new Uint8Array([1]), fileName: "a.psd" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("不支持文件交付");
  });
});
