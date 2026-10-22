/**
 * 片场截图媒体就绪门禁测试
 * （change: 2026-10-08-make-film-set-model-only，任务 4.3/6.2）。
 */
import { describe, expect, it, vi } from "vitest";
import { ModelShotCaptureSession } from "./model-shot-capture.js";

function upload() {
  return Promise.resolve({ ok: true as const, media: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 4, url: "/api/media/a", deduplicated: false } });
}

describe("片场截图媒体就绪门禁", () => {
  it("片场视频帧未就绪时返回稳定失败，不渲染/不上传", async () => {
    const render = vi.fn(async () => ({ ok: true as const, blob: new Blob() }));
    const submit = vi.fn(() => ({ ok: true as const }));
    const session = new ModelShotCaptureSession({
      render,
      upload: async () => upload(),
      submit,
      readSource: () => ({ position: { x: 0, y: 0 }, width: 196 }),
      captureOrigin: () => ({ nodeData: { filmSetShotOrigin: { filmSetNodeId: "film", cameraId: "cam", capturedAt: "now" } } }),
      awaitCompositeAssetMediaReady: async () => false,
      isWritable: () => true
    });
    const result = await session.capture({ nodeId: "film", cameraId: "cam" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("media-not-ready");
    expect(render).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("片场截图就绪后原子创建图片并写入来源说明，不创建 edge", async () => {
    const submit = vi.fn((_commands: unknown, _commandId: string) => ({ ok: true as const }));
    const session = new ModelShotCaptureSession({
      render: async () => ({ ok: true as const, blob: new Blob() }),
      upload: async () => upload(),
      submit,
      readSource: () => ({ position: { x: 0, y: 0 }, width: 196 }),
      captureOrigin: () => ({ nodeData: { filmSetShotOrigin: { filmSetNodeId: "film", cameraId: "cam", capturedAt: "2026-10-08T00:00:00.000Z" } } }),
      awaitCompositeAssetMediaReady: async () => true,
      isWritable: () => true
    });
    const result = await session.capture({ nodeId: "film", cameraId: "cam" });
    expect(result.ok).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    const [commands] = submit.mock.calls[0]! as unknown as [Array<{ type: string; nodeData?: Record<string, unknown> }>];
    // 无 edge.add，且 node.add 携带来源说明。
    expect(commands.some((command) => command.type === "edge.add")).toBe(false);
    const add = commands.find((command) => command.type === "node.add");
    expect(add?.nodeData).toMatchObject({ filmSetShotOrigin: { filmSetNodeId: "film", cameraId: "cam" } });
  });

  it("普通 model3d 截图保留既有关系边并跳过片场媒体等待", async () => {
    const awaitMedia = vi.fn(async () => true);
    const submit = vi.fn((_commands: unknown, _commandId: string) => ({ ok: true as const }));
    const session = new ModelShotCaptureSession({
      render: async () => ({ ok: true as const, blob: new Blob() }),
      upload: async () => upload(),
      submit,
      readSource: () => ({ position: { x: 0, y: 0 }, width: 196 }),
      captureOrigin: () => null,
      awaitCompositeAssetMediaReady: awaitMedia,
      isWritable: () => true
    });
    const result = await session.capture({ nodeId: "model", cameraId: "cam" });
    expect(result.ok).toBe(true);
    expect(awaitMedia).not.toHaveBeenCalled();
    const [commands] = submit.mock.calls[0]! as unknown as [Array<{ type: string }>];
    expect(commands.some((command) => command.type === "edge.add")).toBe(true);
  });
  it("switching clips during upload cancels old result without a document write", async () => {
    let current = true;
    const submit = vi.fn(() => ({ ok: true }));
    const session = new ModelShotCaptureSession({ render: async () => ({ ok: true, blob: new Blob() }), upload: async () => { current = false; return upload(); }, submit, readSource: () => ({ position: { x: 0, y: 0 }, width: 196 }), isWritable: () => true });
    const result = await session.capture({ nodeId: "film", cameraId: "clip:a", isCurrent: () => current, origin: { nodeData: { filmSetShotOrigin: { filmSetNodeId: "film", cameraId: "clip:a", clipId: "a", timeSeconds: 3, sourceIdentity: "a-src", capturedAt: "now" } } } });
    expect(result).toMatchObject({ ok: false, code: "stale-capture" }); expect(submit).not.toHaveBeenCalled(); expect(session.busy).toBe(false);
  });

  it("durable rejection reports failure and leaves capture retryable", async () => {
    const session = new ModelShotCaptureSession({
      render: async () => ({ ok: true, blob: new Blob() }), upload,
      submit: () => ({ ok: true, settled: Promise.resolve({ state: "rejected", error: "保存失败" }) }),
      readSource: () => ({ position: { x: 0, y: 0 }, width: 196 }), isWritable: () => true
    });
    expect(await session.capture({ nodeId: "film", cameraId: "clip:a", captureId: "retry" })).toMatchObject({ ok: false, code: "command-rejected", message: "保存失败" });
    expect(session.committedCount()).toBe(0); expect(session.busy).toBe(false);
  });

});
