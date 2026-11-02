/**
 * 页面隐藏时冻结媒体驻留的回归
 * （缺陷：切走标签页再切回来，画布上所有图片重新 fetch + 解码）。
 *
 * 隐藏的页面不再出帧，撤销已驻留像素既救不了当帧算力，又会在切回时把整屏媒体重新解码一遍。
 * 这里锁定「隐藏冻结、可见恢复、需求未变时零重建」；真实设备上的切页耗时仍属人工验证项。
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { CanvasResourceCoordinator } from "./coordinator.js";
import { createTextureSync } from "../texture-sync.js";
import type { BevyRuntime } from "../bevy-runtime.js";
import type { RasterCanvas } from "../media-raster.js";

const STORAGE = `sha256-${"a".repeat(64)}`;

function canvasWithImage(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("visibility-freeze");
  const assets: StoredAsset[] = [{
    id: "asset-0",
    title: "asset-0",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    url: "/api/media/sha256-aaaa",
    createdAt: "2026-11-02T00:00:00Z",
    metadata: { storageKey: STORAGE, contentType: "image/png", size: 4 }
  }];
  return {
    ...base,
    document: { ...base.document, nodes: [{ id: "n0", type: "image", position: { x: 0, y: 0 } }] },
    nodeData: { n0: { outputAssetId: "asset-0" } },
    assets
  };
}

const CANDIDATE = { nodeId: "n0", contentKey: "asset-0", x: 0, y: 0, width: 248, height: 232, eligible: true };
const SURFACE = { width: 1600, height: 1000, pixelRatio: 1 };
const VIEWPORT = { x: 0, y: 0, zoom: 1 };

function project(coordinator: CanvasResourceCoordinator, pageVisible: boolean) {
  return coordinator.project({
    viewport: VIEWPORT, surface: SURFACE, pageVisible,
    interactive: [], pins: [], candidates: [CANDIDATE]
  });
}

function fakeRaster(): RasterCanvas {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => undefined,
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
    })
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("页面隐藏时冻结媒体驻留", () => {
  it("隐藏帧不撤销已准入需求，也不新建需求", () => {
    const coordinator = new CanvasResourceCoordinator();
    expect(project(coordinator, true)).toEqual(["n0"]);
    const revision = coordinator.projectionRevision();
    const demand = coordinator.tierOf("n0");
    expect(demand).not.toBeNull();

    // 隐藏帧：集合冻结，返回空（没有新准入），版本不变（owner 不会重建绑定）。
    expect(project(coordinator, false)).toEqual([]);
    expect(coordinator.isAdmitted("n0")).toBe(true);
    expect(coordinator.tierOf("n0")).toBe(demand);
    expect(coordinator.projectionRevision()).toBe(revision);

    // 隐藏期间新出现的候选也不得开始解码。
    coordinator.project({
      viewport: VIEWPORT, surface: SURFACE, pageVisible: false, interactive: [], pins: [],
      candidates: [CANDIDATE, { ...CANDIDATE, nodeId: "n1", contentKey: "asset-1" }]
    });
    expect(coordinator.isAdmitted("n1")).toBe(false);

    // 回到可见：需求未变 → 没有新准入（零重建）。
    expect(project(coordinator, true)).toEqual([]);
    expect(coordinator.isAdmitted("n0")).toBe(true);
    expect(coordinator.projectionRevision()).toBe(revision);
    coordinator.dispose();
  });

  it("无有效 surface 仍然撤销需求（那是画布没挂载，不是「暂时看不见」）", () => {
    const coordinator = new CanvasResourceCoordinator();
    project(coordinator, true);
    coordinator.project({ viewport: null, surface: null, pageVisible: true, interactive: [], pins: [], candidates: [CANDIDATE] });
    expect(coordinator.isAdmitted("n0")).toBe(false);
    coordinator.dispose();
  });

  it("切走再切回不重新解码图片", async () => {
    const coordinator = new CanvasResourceCoordinator();
    const canvas = canvasWithImage();
    const loadImage = vi.fn(async () => ({ width: 256, height: 232 }) as HTMLImageElement);
    const setTexture = vi.fn(() => true);
    const sync = createTextureSync({
      runtime: { setTexture } as unknown as BevyRuntime,
      getCanvas: () => canvas,
      residency: coordinator,
      admissionOf: (nodeId) => {
        const tier = coordinator.tierOf(nodeId);
        const purpose = coordinator.purposeOf(nodeId);
        return coordinator.isAdmitted(nodeId) && tier !== null && purpose !== null
          ? { admitted: true as const, purpose, tier }
          : null;
      },
      createCanvas: fakeRaster,
      loadImage
    });

    project(coordinator, true);
    sync.sync();
    await flush();
    // 解码完成后的下一次同步才上传纹理。
    sync.sync();
    await flush();
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(setTexture).toHaveBeenCalled();

    // 隐藏：真实故障里后台任务完成会同步触发一帧（run-state flush），旧实现在这里撤销全部图片。
    project(coordinator, false);
    sync.sync();
    await flush();
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(coordinator.isAdmitted("n0")).toBe(true);

    // 切回：内容还在，只允许重新上传（GPU 侧），不允许重新 fetch/解码。
    project(coordinator, true);
    sync.sync();
    await flush();
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(coordinator.isAdmitted("n0")).toBe(true);
    sync.dispose();
    coordinator.dispose();
  });
});
