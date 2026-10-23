/**
 * 打开准入预检的回归（change: 2026-10-22-add-photocraft-raster-interchange，U05）。
 *
 * `inspectRasterFile` 是文件选择/拖入时唯一会调用的域入口：它必须给出**可用**结论
 * （可打开 / 只读可打开 / 暂缓并带真实原因），并且永远不替换文档。
 */
import { describe, expect, it } from "vitest";
import { inspectRasterFile } from "./panels.js";

function controller(inspection: unknown, options: { ok?: boolean; message?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    controller: {
      features: {
        io: {
          inspectOpenRaster: (bytes: Uint8Array) => {
            calls.push(`inspect:${bytes.length}`);
            return options.ok === false
              ? { ok: false, message: options.message ?? "解码失败" }
              : { ok: true, value: inspection };
          }
        }
      }
    } as never
  };
}

describe("打开准入预检", () => {
  it("可编辑打开与只读打开都允许，只读带出标志", () => {
    const open = inspectRasterFile(controller({ status: "open", openable: true, format: "tif", name: "TIFF" }).controller, new Uint8Array([1]));
    expect(open).toEqual({ ok: true, format: "tif", readOnly: false });

    const readOnly = inspectRasterFile(controller({ status: "read-only", openable: true, format: "dds", name: "DDS" }).controller, new Uint8Array([1]));
    expect(readOnly).toEqual({ ok: true, format: "dds", readOnly: true });
  });

  it("暂缓格式拒绝并给出内核原因，而不是只说打不开", () => {
    const result = inspectRasterFile(
      controller({ status: "deferred", openable: false, format: "exr", name: "OpenEXR", reason: "HDR/浮点位深（F16/F32）" }).controller,
      new Uint8Array([1])
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("OpenEXR");
    expect(result.message).toContain("HDR/浮点位深");
  });

  it("解码失败直接透传原因，不假装成功", () => {
    const { controller: c, calls } = controller(null, { ok: false, message: "无法识别的栅格签名（扩展名不作为依据）" });
    const result = inspectRasterFile(c, new Uint8Array([9]));
    expect(result).toEqual({ ok: false, message: "无法识别的栅格签名（扩展名不作为依据）" });
    expect(calls).toEqual(["inspect:1"]);
  });

  it("内核没有本域会话时给出可读原因", () => {
    const result = inspectRasterFile({ features: {} } as never, new Uint8Array([1]));
    expect(result).toEqual({ ok: false, message: "当前环境不支持栅格交换" });
  });
});
