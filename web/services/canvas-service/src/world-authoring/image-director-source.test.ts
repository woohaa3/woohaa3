import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { prepareImageDirectorSource } from "./image-director-source.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64");
function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-11-03T00:00:00Z");
  canvas.document.nodes.push({ id: "image", type: "image", position: { x: 0, y: 0 } });
  canvas.nodeData.image = { outputAssetId: "asset" };
  canvas.assets.push({ id: "asset", mediaKind: "image", title: "image", status: "ready", source: "uploaded", createdAt: "2026-11-03T00:00:00Z", metadata: { storageKey: "image.png" } } as never);
  return { canvas, deps: { authorize: vi.fn(async () => true), resolveRoom: vi.fn(async () => ({ exportCanvas: () => ({ ok: true, canvas }) }) as never), media: { verify: vi.fn(async () => ({ exists: true, matches: true })), read: vi.fn(async () => ({ bytes: png, contentType: "image/png" })) } } };
}
const input = { owner: "owner", canvasId: "canvas", sourceNodeId: "image" };
describe("image director source", () => {
  it("reads authorized bytes and freezes actual dimensions and checksum", async () => {
    const { deps } = fixture();
    const result = await prepareImageDirectorSource(input, deps);
    expect(result.source).toMatchObject({ sourceNodeId: "image", assetId: "asset", mimeType: "image/png", width: 1, height: 1 });
    expect(result.source.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(deps.media.read).toHaveBeenCalledWith("image.png", "canvas");
  });
  it("rejects revoked access and mismatched bytes", async () => {
    const { canvas, deps } = fixture();
    deps.authorize.mockResolvedValueOnce(false);
    await expect(prepareImageDirectorSource(input, deps)).rejects.toThrow("权限");
    canvas.assets[0]!.metadata!.checksum = "wrong";
    await expect(prepareImageDirectorSource(input, deps)).rejects.toThrow("checksum");
  });
  it("rejects an unready asset, unsupported bytes and stale records with distinct reasons", async () => {
    const { canvas, deps } = fixture();
    canvas.assets[0]!.status = "pending" as never;
    await expect(prepareImageDirectorSource(input, deps)).rejects.toThrow("尚未就绪");
    canvas.assets[0]!.status = "ready";
    // 记录的类型与真实字节不一致时以字节为准：生成结果常被默认记成 image/png。
    canvas.assets[0]!.metadata!.contentType = "image/jpeg";
    await expect(prepareImageDirectorSource(input, deps)).resolves.toMatchObject({ source: { mimeType: "image/png" } });
    // 真正不受支持的格式要说明原因，而不是笼统的「字节校验失败」。
    deps.media.read.mockResolvedValueOnce({ bytes: Buffer.from("GIF89a-not-a-captured-image"), contentType: "image/gif" });
    await expect(prepareImageDirectorSource(input, deps)).rejects.toThrow("PNG/JPEG/WebP");
    canvas.assets[0]!.metadata!.size = 1;
    await expect(prepareImageDirectorSource(input, deps)).rejects.toThrow("字节数不一致");
    canvas.assets[0]!.metadata!.size = png.length;
    canvas.assets[0]!.metadata!.checksum = "0".repeat(64);
    await expect(prepareImageDirectorSource(input, deps)).rejects.toThrow("checksum");
  });
});
