/**
 * 宿主默认图片聚焦查看会话测试（change: default-image-focus-viewer）。
 *
 * 关注三件容易回归的事：进入后推入 `woohaa-image-focus-v1` 投影并上传同源纹理；解码失败给出
 * 可读错误而不是黑屏；退出清空投影/纹理且写回 pending 默认。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { ImageFocusTarget } from "../../focus/image-focus-target.js";
import { ImageViewerSession, fitZoomFor, clampZoom } from "./session.js";

function canvasWithAsset(url = "/api/media/canvas-1/asset-1.png") {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", "2026-10-28T00:00:00.000Z");
  return {
    ...base,
    document: { ...base.document, nodes: [{ id: "node-1", type: "image", position: { x: 100, y: 50 } }] },
    nodeData: { "node-1": { outputAssetId: "asset-1" } },
    assets: [{ id: "asset-1", title: "", source: "uploaded", status: "ready", mediaKind: "image", createdAt: "2026-10-28T00:00:00.000Z", url }]
  } as never;
}

function target(url = "/api/media/canvas-1/asset-1.png"): ImageFocusTarget {
  const canvas = canvasWithAsset(url);
  return { canvas: canvas as never, nodeId: "node-1", asset: (canvas as never as { assets: never[] }).assets[0]!, url };
}

function session(overrides: {
  decode?: () => Promise<{ width: number; height: number; drawable: CanvasImageSource }>;
  rect?: () => { x: number; y: number; width: number; height: number };
} = {}) {
  const setProjection = vi.fn();
  const setTexture = vi.fn();
  const setPending = vi.fn();
  const instance = new ImageViewerSession({
    nodeId: "node-1",
    target: target(),
    getCanvas: () => canvasWithAsset() as never,
    rect: overrides.rect ?? (() => ({ x: 0, y: 0, width: 1000, height: 800 })),
    savedViewport: { x: 0, y: 0, zoom: 1 },
    transition: {
      run: async (request) => { request.apply(request.to, 1); return true; },
      cancel: () => undefined,
      isActive: () => false
    },
    runtime: { setProjection, setTexture, setPending },
    decode: overrides.decode ?? (async () => ({ width: 2000, height: 1000, drawable: {} as CanvasImageSource })),
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8Array(w * h * 4) })
      })
    })
  });
  return { instance, setProjection, setTexture, setPending };
}

describe("宿主默认图片查看会话", () => {
  it("进入时上传聚焦纹理并推入 woohaa-image-focus-v1 投影", async () => {
    const { instance, setProjection, setTexture, setPending } = session();
    await instance.start();
    expect(setPending).toHaveBeenNthCalledWith(1, true);
    expect(setPending).toHaveBeenLastCalledWith(false);
    expect(setTexture).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-1", width: 2000, height: 1000 }));
    const projection = setProjection.mock.calls.at(-1)?.[0];
    expect(projection).toMatchObject({
      version: "woohaa-image-focus-v1",
      nodeId: "node-1",
      presentationReady: true,
      sourceWidth: 2000,
      sourceHeight: 1000,
      viewport: { x: 0, y: 0, zoom: fitZoomFor(2000, 1000, { width: 1000, height: 800 }) }
    });
  });

  it("解码失败保留可读原因，不上传空白纹理", async () => {
    const { instance, setProjection, setTexture, setPending } = session({
      decode: async () => { throw new Error("图片加载失败（HTTP 404）。"); }
    });
    await instance.start();
    expect(instance.state()).toMatchObject({ loading: false, error: "图片加载失败（HTTP 404）。" });
    expect(setTexture).not.toHaveBeenCalled();
    expect(setProjection).not.toHaveBeenCalled();
    expect(setPending).toHaveBeenLastCalledWith(false);
  });

  it("退出清空投影与纹理，并解除 pending", async () => {
    const { instance, setProjection, setTexture, setPending } = session();
    await instance.start();
    instance.dispose();
    expect(setProjection).toHaveBeenLastCalledWith(null);
    expect(setTexture).toHaveBeenLastCalledWith(null);
    expect(setPending).toHaveBeenLastCalledWith(false);
  });

  it("取景手势只改本地取景：适应窗口、100% 与缩放钳制", async () => {
    const { instance } = session();
    await instance.start();
    instance.actualSize();
    expect(instance.viewportState()).toEqual({ x: 0, y: 0, zoom: 1 });
    instance.zoomAround(1000);
    expect(instance.viewportState().zoom).toBe(clampZoom(1000));
    instance.panBy(10, -5);
    expect(instance.viewportState()).toMatchObject({ x: 10, y: -5 });
    instance.fitWindow();
    expect(instance.viewportState().zoom).toBeCloseTo(fitZoomFor(2000, 1000, { width: 1000, height: 800 }));
  });

  it("内容矩形变化（历史 drawer）重新适应窗口", async () => {
    const box = { current: { x: 0, y: 0, width: 1000, height: 800 } };
    const { instance } = session({ rect: () => box.current });
    await instance.start();
    box.current = { x: 0, y: 0, width: 600, height: 800 };
    instance.setRect();
    expect(instance.viewportState().zoom).toBeCloseTo(fitZoomFor(2000, 1000, box.current));
  });
});
