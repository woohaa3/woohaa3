// 只检查入场投影的发布顺序，不创建绘图上下文。
import { expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type BevyImageFocus } from "@woohaa3/contracts";
import { nodeImageRect, overviewImageView, type ViewportTransitionRequest } from "@woohaa3/frontend/plugin-api";
import { ImageFocusWorkspace } from "../src/workspace.js";

it.each([false, true])("编辑预览先到时，动画前的全部投影仍在节点原位（已知尺寸：%s）", async (knownSize) => {
  const canvas = createEmptyWoohaa3ServerCanvas("test", "2026-10-16T00:00:00Z");
  canvas.document.nodes.push({ id: "image", type: "image", position: { x: 300, y: 400 }, width: 248, height: 232 });
  const rect = { x: 52, y: 152, width: 948, height: 704 };
  const savedViewport = { x: -120, y: 50, zoom: 0.8 };
  const size = { width: 1600, height: 900 };
  const expected = overviewImageView(nodeImageRect({ x: 300, y: 400, width: 248, height: 232 }, size.width, size.height), size.width, rect, savedViewport);
  let decode: (image: { bitmap: CanvasImageSource; width: number; height: number }) => void = () => {};
  let request: ViewportTransitionRequest | undefined;
  let finish: (completed: boolean) => void = () => {};
  const projections: BevyImageFocus[] = [];
  const texture = vi.fn(() => workspace.pushProjection());
  const workspace = new ImageFocusWorkspace({
    nodeId: "image", target: { canvas, nodeId: "image", asset: { url: "/api/media/output.png", ...(knownSize ? { metadata: size } : {}) } as never, edit: null, project: null },
    rect, savedViewport, restoreViewport: () => {},
    setProjection: (projection) => { if (projection) projections.push(projection); },
    onTexture: texture,
    decode: () => new Promise((resolve) => { decode = resolve; }),
    transition: {
      run: (next) => { request = next; return new Promise((resolve) => { finish = resolve; }); },
      cancel: () => finish(false), isActive: () => request !== undefined
    }
  });
  const pending = workspace.start();
  const preview = { width: 4, height: 2, pixels: new Uint8Array(32) };
  workspace.setEditorPreview(preview, size);
  workspace.setRect(rect);
  if (!knownSize) {
    expect(projections).toHaveLength(0);
    expect(texture).not.toHaveBeenCalled();
  }
  decode({ bitmap: {} as CanvasImageSource, ...size });
  await pending;
  expect(projections.length).toBeGreaterThan(0);
  for (const projection of projections) {
    expect(projection.viewport).toEqual(expected);
    expect(projection.presentationReady).toBe(false);
  }
  expect(texture).toHaveBeenLastCalledWith(preview);
  expect(request?.from).toEqual(expected);
  expect(workspace.isPresentationReady()).toBe(false);
  request!.apply(request!.to, 1);
  expect(projections.at(-1)?.presentationReady).toBe(false);
  finish(true);
  await Promise.resolve();
  expect(projections.at(-1)?.viewport).toMatchObject({ x: 0, y: 0 });
  expect(projections.at(-1)?.viewport.zoom).toBeCloseTo(948 / 1600);
  expect(workspace.isPresentationReady()).toBe(true);
  expect(projections.at(-1)?.presentationReady).toBe(true);
  workspace.dispose();
});
