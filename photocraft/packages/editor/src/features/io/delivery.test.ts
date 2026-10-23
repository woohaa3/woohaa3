/**
 * 交付动作的回归（change: 2026-10-22-add-photocraft-raster-interchange，design D3）。
 *
 * 只锁定「什么算一次交付」：空名/空字节不发起、下载不等于已保存、字节被复制、URL 被释放。
 * 真实写盘由宿主端口负责，这里不模拟磁盘。
 */
import { describe, expect, it } from "vitest";
import { previewObjectUrl, startDownload, type DeliveryEnvironment } from "./delivery.js";

function recordingEnvironment(options: { failTrigger?: boolean } = {}) {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const triggered: { url: string; fileName: string }[] = [];
  let seq = 0;
  const environment: DeliveryEnvironment = {
    createObjectURL: (blob) => {
      created.push(blob);
      seq += 1;
      return `blob:preview-${seq}`;
    },
    revokeObjectURL: (url) => { revoked.push(url); },
    trigger: (url, fileName) => {
      if (options.failTrigger) throw new Error("下载被拦截");
      triggered.push({ url, fileName });
    }
  };
  return { environment, created, revoked, triggered };
}

describe("导出交付", () => {
  it("发起下载后立即释放对象 URL，并把真实字节放进 Blob", async () => {
    const env = recordingEnvironment();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const outcome = startDownload({ fileName: "art.jpg", contentType: "image/jpeg", bytes }, env.environment);
    expect(outcome).toEqual({ ok: true, status: "download-started", fileName: "art.jpg", bytes: 4 });
    expect(env.triggered).toEqual([{ url: "blob:preview-1", fileName: "art.jpg" }]);
    expect(env.revoked).toEqual(["blob:preview-1"]);
    expect(env.created[0]!.type).toBe("image/jpeg");
    expect(new Uint8Array(await env.created[0]!.arrayBuffer())).toEqual(bytes);
    // 调用方之后修改自己的缓冲区不影响已交付内容。
    bytes[0] = 9;
    expect(new Uint8Array(await env.created[0]!.arrayBuffer())[0]).toBe(1);
  });

  it("空文件名、空字节与缺少 DOM 环境都拒绝，且不产生副作用", () => {
    const env = recordingEnvironment();
    expect(startDownload({ fileName: "  ", contentType: "image/png", bytes: new Uint8Array([1]) }, env.environment))
      .toMatchObject({ ok: false, status: "failed" });
    expect(startDownload({ fileName: "a.png", contentType: "image/png", bytes: new Uint8Array() }, env.environment))
      .toMatchObject({ ok: false, status: "failed", message: "交付内容为空，未发起下载" });
    expect(startDownload({ fileName: "a.png", contentType: "image/png", bytes: new Uint8Array([1]) }, null))
      .toMatchObject({ ok: false, status: "failed" });
    expect(env.triggered).toEqual([]);
    expect(env.created).toEqual([]);
  });

  it("宿主触发失败时释放已创建的 URL 并返回原因", () => {
    const env = recordingEnvironment({ failTrigger: true });
    const outcome = startDownload({ fileName: "a.png", contentType: "image/png", bytes: new Uint8Array([1]) }, env.environment);
    expect(outcome).toEqual({ ok: false, status: "failed", message: "下载被拦截" });
    expect(env.revoked).toEqual(["blob:preview-1"]);
  });

  it("预览 URL 只在有字节且环境可用时创建", () => {
    const env = recordingEnvironment();
    expect(previewObjectUrl(new Uint8Array(), "image/png", env.environment)).toBeNull();
    expect(previewObjectUrl(new Uint8Array([1]), "image/png", null)).toBeNull();
    expect(previewObjectUrl(new Uint8Array([1]), "image/webp", env.environment)).toBe("blob:preview-1");
    expect(env.created[0]!.type).toBe("image/webp");
  });
});
