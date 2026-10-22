// 只验证内容、取景和纹理发布状态，不创建绘图上下文。
import { expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, PHOTOCRAFT_ENGINE_VERSION, type ImageProjectDocument } from "@woohaa3/contracts";
import { ImageFocusWorkspace, type ImageFocusTarget } from "../src/workspace.js";
import type { ImageDecoder } from "../src/loader.js";
import type { ViewportTransitionRequest } from "@woohaa3/frontend/plugin-api";

function target(id: string, project: ImageProjectDocument | null = null): ImageFocusTarget {
  const canvas = createEmptyWoohaa3ServerCanvas("c", "2026-10-17T00:00:00Z");
  canvas.document.nodes.push({ id: "image", type: "image", position: { x: 300, y: 400 }, width: 248, height: 232 });
  const asset = { id, url: `/api/media/${id}.png`, metadata: { storageKey: `${id}.png`, width: 800, height: 600 } } as never;
  return { canvas, nodeId: "image", asset, edit: null, project };
}

function setup(decode: ImageDecoder = async () => ({ bitmap: {} as CanvasImageSource, width: 800, height: 600 })) {
  const onTexture = vi.fn();
  const restoreViewport = vi.fn();
  const run = vi.fn(async (request: ViewportTransitionRequest) => { request.apply(request.to, 1); return true; });
  const workspace = new ImageFocusWorkspace({
    nodeId: "image", target: target("original"), rect: { x: 52, y: 152, width: 1000, height: 700 },
    savedViewport: { x: 10, y: 20, zoom: 0.8 }, restoreViewport, setProjection: vi.fn(), onTexture, decode,
    transition: { run, cancel: vi.fn(), isActive: () => false }
  });
  return { workspace, onTexture, restoreViewport, run };
}

it("恢复工程与纯图片时替换编辑会话和纹理，保留聚焦及退出视口", async () => {
  const { workspace, onTexture, run, restoreViewport } = setup();
  await workspace.start();
  const direct = { x: 30, y: -20, zoom: 1.4 };
  workspace.setViewport(direct);
  workspace.setEditorPreview({ width: 2, height: 1, pixels: new Uint8Array(8) }, { width: 800, height: 600 });
  workspace.setHistoryOverride({ url: "/api/canvas-node-history/c/image/old/preview" });
  await Promise.resolve(); await Promise.resolve();
  const previousSession = workspace.project;
  const document = { version: "woohaa-image-project-v1", engine: "photocraft", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1, baseAssetId: "restored", sourceWidth: 800, sourceHeight: 600, canvasWidth: 800, canvasHeight: 600,
    project: { storageKey: "restored.pcraft" }, documentContentHash: "restored" } as ImageProjectDocument;
  await workspace.replaceContent(target("restored", document));
  expect(workspace.project).not.toBe(previousSession);
  expect(workspace.projectDocument()).toBe(document);
  expect(workspace.baseAsset()).toMatchObject({ id: "restored" });
  expect(workspace.project.isDirty()).toBe(false);
  expect(workspace.isReadOnlyPreview()).toBe(false);
  expect(workspace.isPresentationReady()).toBe(true);
  expect(workspace.focus.viewportState()).toEqual(direct);
  expect(workspace.contentRevisionState()).toBe(1);
  expect(onTexture.mock.lastCall?.[0]).toBe(workspace.loadedImage());
  expect(run).toHaveBeenCalledTimes(1);
  expect(restoreViewport).not.toHaveBeenCalled();
  await workspace.replaceContent(target("plain"));
  expect(workspace.projectDocument()).toBeNull();
  expect(workspace.baseAsset()).toMatchObject({ id: "plain" });
  expect(workspace.contentRevisionState()).toBe(2);
  workspace.dispose();
  expect(restoreViewport).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 0.8 });
});

it("连续恢复只发布最新版本，旧版本解码和历史解码不能覆盖新内容", async () => {
  const pending = new Map<string, (image: { bitmap: CanvasImageSource; width: number; height: number }) => void>();
  const { workspace, onTexture } = setup(url => new Promise(resolve => pending.set(url, resolve)));
  const complete = (url: string) => {
    const close = vi.fn();
    pending.get(url)!({ bitmap: { close } as unknown as CanvasImageSource, width: 800, height: 600 });
    return close;
  };
  const starting = workspace.start();
  complete("/api/media/original.png?canvas=c");
  await starting;
  workspace.setHistoryOverride({ url: "/api/canvas-node-history/c/image/old/preview" });
  const a = workspace.replaceContent(target("a"));
  const b = workspace.replaceContent(target("b"));
  complete("/api/media/b.png?canvas=c");
  await b;
  const newest = workspace.loadedImage();
  const count = onTexture.mock.calls.length;
  const closedA = complete("/api/media/a.png?canvas=c");
  const closedHistory = complete("/api/canvas-node-history/c/image/old/preview");
  await a;
  await Promise.resolve(); await Promise.resolve();
  expect(closedA).toHaveBeenCalledOnce();
  expect(closedHistory).toHaveBeenCalledOnce();
  expect(onTexture).toHaveBeenCalledTimes(count);
  expect(workspace.loadedImage()).toBe(newest);
  workspace.dispose();
});
