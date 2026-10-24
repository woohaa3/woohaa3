/**
 * 千卡片媒体驻留的行为回归
 * （change: 2026-10-23-scale-canvas-media-residency，任务 1.2/3.1/3.2/3.3/4.6 的可重复门禁）。
 *
 * 取代 `evidence/capacity-audit.probe.test.ts.txt` 里断言**缺陷**的探针：同一 fixture 现在断言
 * 目标行为（先准入再创建、同 key 只启动一份工作、真实异步上限、静止重复同步零创建）。
 * 这些是逻辑门禁，不是硬件性能证据。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import { createTextureSync } from "./texture-sync.js";
import { createVideoFrameSessions, type VideoElementLike } from "./video-frame-session.js";
import { CanvasResourceCoordinator } from "./residency/index.js";
import type { BevyRuntime } from "./bevy-runtime.js";
import type { RasterCanvas } from "./media-raster.js";

const STORAGE = `sha256-${"a".repeat(64)}`;

function fixture(kind: "image" | "video", count: number, assetCount = 1, spacing = 10_000): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("capacity-audit");
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `n${index}`, type: kind, position: { x: index * spacing, y: 0 } }));
  const assets: StoredAsset[] = Array.from({ length: assetCount }, (_, index) => ({
    id: `asset-${index}`,
    title: `asset-${index}`,
    mediaKind: kind,
    source: "generated",
    status: "ready",
    url: `/api/media/sha256-${"a".repeat(64)}-${index}`,
    createdAt: "2026-10-23T00:00:00Z",
    metadata: { storageKey: `${STORAGE}-${index}`, contentType: kind === "video" ? "video/mp4" : "image/png", size: 4 }
  }));
  return {
    ...base,
    document: { ...base.document, nodes },
    nodeData: Object.fromEntries(nodes.map((node, index) => [node.id, { outputAssetId: `asset-${index % assetCount}` }])),
    assets
  };
}

const runtime = {} as BevyRuntime;

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

function fakeImage(width = 512, height = 512): HTMLImageElement {
  return { width, height } as HTMLImageElement;
}

function videoFake(onSeek: () => void) {
  const events = new Map<string, (event: unknown) => void>();
  let currentTime = 0;
  const video = {
    src: "", preload: "", muted: true, loop: false, playsInline: true, duration: 2, crossOrigin: null,
    get currentTime() { return currentTime; },
    set currentTime(value: number) { currentTime = value; onSeek(); },
    videoWidth: 160, videoHeight: 90, pause() {}, load() {}, play() { return Promise.resolve(); },
    removeAttribute() {}, addEventListener(name: string, handler: (event: unknown) => void) { events.set(name, handler); },
    removeEventListener() {}, requestVideoFrameCallback() { return 1; }, cancelVideoFrameCallback() {}
  };
  return { video: video as unknown as VideoElementLike, metadata: () => events.get("loadedmetadata")?.({}) };
}

/** 由协调器为每个节点构造准入信息（视图覆盖全部节点，模拟「全部可见」的密集总览）。 */
function admissionFor(coordinator: CanvasResourceCoordinator) {
  return (nodeId: string) => {
    const tier = coordinator.tierOf(nodeId);
    return {
      admitted: coordinator.isAdmitted(nodeId),
      purpose: coordinator.purposeOf(nodeId) ?? ("visible" as const),
      tier: tier ?? (128 as const)
    };
  };
}

function projectAll(coordinator: CanvasResourceCoordinator, canvas: ServerCanvas, count: number) {
  coordinator.project({
    viewport: { x: 0, y: 0, zoom: 1 },
    surface: { width: 2_000_000, height: 100_000, pixelRatio: 1 },
    pageVisible: true,
    interactive: [],
    pins: [],
    candidates: canvas.document.nodes.slice(0, count).map((node) => ({
      nodeId: node.id,
      contentKey: String((canvas.nodeData as Record<string, { outputAssetId?: string }>)[node.id]?.outputAssetId ?? ""),
      x: node.position.x,
      y: node.position.y,
      width: 256,
      height: 256,
      eligible: true
    }))
  });
}

describe("千卡片媒体准入", () => {
  it("1000 张同 key 图片只启动一份解码工作，实例布局保持独立", async () => {
    let loads = 0;
    const uploaded = new Set<string>();
    const canvas = fixture("image", 1000, 1, 10);
    const coordinator = new CanvasResourceCoordinator();
    projectAll(coordinator, canvas, 1000);
    const sync = createTextureSync({
      runtime: { setTexture: (id: string) => { uploaded.add(id); return true; } } as unknown as BevyRuntime,
      getCanvas: () => canvas,
      residency: coordinator,
      admissionOf: admissionFor(coordinator),
      createCanvas: fakeRaster,
      loadImage: () => { loads += 1; return Promise.resolve(fakeImage()); }
    });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    // 同一资产：只解码一次，但每个**准入**节点各自绑定并上传一次纹理（nodeId 只绑定展示实例）。
    // 图片卡不占离屏预览槽，准入集合由页 GPU 估算预算收敛（不是 16/256 的槽位数量）。
    const admitted = coordinator.admittedNodeIds().length;
    expect(admitted).toBeGreaterThan(0);
    expect(coordinator.diagnostics().estimatedGpuBytes)
      .toBeLessThanOrEqual(coordinator.getPolicy().gpuDerivedBytes);
    expect(loads).toBe(1);
    expect(coordinator.channelSnapshot("image").started).toBe(1);
    // 逐帧上传 staging 预算（design D3）会把全部纹理分摊到多帧：
    // 单帧最多 8 MiB，因此首帧上传不全，但**不会**重解码，且最终全部补齐。
    expect(uploaded.size).toBeLessThan(admitted);
    for (let frame = 0; frame < 200 && uploaded.size < admitted; frame += 1) {
      coordinator.beginFrame();
      sync.sync();
    }
    expect(uploaded.size).toBe(admitted);
    expect(loads).toBe(1);
    expect(sync.textureNodeIds().size).toBe(admitted);
    sync.dispose();
    coordinator.dispose();
  });

  it("未准入的离屏节点不再触发全量原图加载", async () => {
    const canvas = fixture("image", 1000, 1, 10_000);
    const coordinator = new CanvasResourceCoordinator();
    // 只把视口放在前 3 个节点内。
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 1200, height: 800, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: canvas.document.nodes.map((node) => ({
        nodeId: node.id, contentKey: "shared", x: node.position.x, y: node.position.y,
        width: 256, height: 256, eligible: true
      }))
    });
    let loads = 0;
    const sync = createTextureSync({
      runtime: {} as BevyRuntime,
      getCanvas: () => canvas,
      residency: coordinator,
      admissionOf: admissionFor(coordinator),
      createCanvas: fakeRaster,
      loadImage: () => { loads += 1; return Promise.resolve(fakeImage()); }
    });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads).toBe(1);
    expect(coordinator.admittedNodeIds().length).toBeLessThan(10);
    sync.dispose();
    coordinator.dispose();
  });

  it("静止重复同步不产生新的解码/上传工作", async () => {
    const canvas = fixture("image", 50, 1, 10);
    const coordinator = new CanvasResourceCoordinator();
    projectAll(coordinator, canvas, 50);
    let loads = 0;
    const setTexture = () => { return true; };
    const sync = createTextureSync({
      runtime: { setTexture } as unknown as BevyRuntime,
      getCanvas: () => canvas,
      residency: coordinator,
      admissionOf: admissionFor(coordinator),
      createCanvas: fakeRaster,
      loadImage: () => { loads += 1; return Promise.resolve(fakeImage()); }
    });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    const startedAfterFirst = coordinator.channelSnapshot("image").started;
    for (let frame = 0; frame < 1000; frame += 1) {
      coordinator.project({
        viewport: { x: 0, y: 0, zoom: 1 },
        surface: { width: 2_000_000, height: 100_000, pixelRatio: 1 },
        pageVisible: true, interactive: [], pins: [],
        candidates: canvas.document.nodes.map((node) => ({
          nodeId: node.id, contentKey: "shared", x: node.position.x, y: node.position.y,
          width: 256, height: 256, eligible: true
        }))
      });
      sync.sync();
    }
    expect(loads).toBe(1);
    expect(coordinator.channelSnapshot("image").started).toBe(startedAfterFirst);
    sync.dispose();
    coordinator.dispose();
  });

  it("引用同一资产的节点全部删除后内容与像素被释放", async () => {
    let canvas = fixture("image", 3, 1, 10);
    const coordinator = new CanvasResourceCoordinator();
    projectAll(coordinator, canvas, 3);
    const sync = createTextureSync({
      runtime: { setTexture: () => true } as unknown as BevyRuntime,
      getCanvas: () => canvas,
      residency: coordinator,
      admissionOf: admissionFor(coordinator),
      createCanvas: fakeRaster,
      loadImage: () => Promise.resolve(fakeImage())
    });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    expect(sync.textureNodeIds().size).toBe(3);
    canvas = { ...canvas, document: { ...canvas.document, nodes: [] } };
    sync.sync();
    expect(sync.textureNodeIds().size).toBe(0);
    sync.dispose();
    coordinator.dispose();
  });
});

describe("千视频卡片准入", () => {
  it("1000 个视频只为准入名额创建 decoder，重复同步不再创建", () => {
    let created = 0;
    const canvas = fixture("video", 1000, 1, 10_000);
    const coordinator = new CanvasResourceCoordinator();
    coordinator.project({
      viewport: null, surface: null, pageVisible: true,
      interactive: ["n0", "n1"], pins: [],
      candidates: canvas.document.nodes.map((node) => ({
        nodeId: node.id, contentKey: "shared", x: node.position.x, y: node.position.y,
        width: 256, height: 256, eligible: true
      }))
    });
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => canvas,
      residency: coordinator,
      purposeOf: (nodeId) => coordinator.purposeOf(nodeId),
      createVideo: () => { created += 1; return videoFake(() => {}).video; },
      createCanvas: () => ({ width: 0, height: 0, getContext: () => null })
    });
    sessions.sync();
    const firstCreated = created;
    // 只有准入需求（interactive 两个）建 decoder；默认上限 12 不会先建 1000 个。
    expect(firstCreated).toBeLessThanOrEqual(2);
    sessions.sync();
    expect(created).toBe(firstCreated);
    sessions.dispose();
    coordinator.dispose();
  });

  it("maxStaticDecodes=2 时未完成首帧请求始终至多 2 个", () => {
    let seeks = 0;
    const videos: ReturnType<typeof videoFake>[] = [];
    const canvas = fixture("video", 12, 1, 10);
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => canvas,
      maxStaticDecodes: 2,
      createVideo: () => { const item = videoFake(() => { seeks += 1; }); videos.push(item); return item.video; },
      createCanvas: () => ({ width: 0, height: 0, getContext: () => null })
    });
    sessions.sync();
    for (const video of videos) video.metadata();
    // 元数据全部到达，但只有 2 个首帧真正启动（其余排队，等名额真实归还）。
    expect(seeks).toBe(2);
    expect(sessions.diagnostics?.().staticActive).toBe(2);
    expect(sessions.diagnostics?.().staticPending).toBe(10);
    // 帧回调完成后才轮到下一批。
    videos[0].video.requestVideoFrameCallback = () => 1;
    sessions.dispose();
  });

  it("有 poster 的普通静态视频不抢首帧名额，只在需要真帧时取帧", () => {
    const canvas = fixture("video", 3, 1, 10);
    const withPoster: ServerCanvas = {
      ...canvas,
      assets: canvas.assets.map((asset) => ({ ...asset, posterUrl: `/api/media/sha256-${"b".repeat(64)}` }))
    };
    let seeks = 0;
    const videos: ReturnType<typeof videoFake>[] = [];
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => withPoster,
      createVideo: () => { const item = videoFake(() => { seeks += 1; }); videos.push(item); return item.video; },
      createCanvas: () => ({ width: 0, height: 0, getContext: () => null }),
      loadPosterImage: () => Promise.resolve({ width: 160, height: 90 })
    });
    sessions.sync();
    for (const video of videos) video.metadata();
    // 普通静态卡片优先 poster：没有 hover/聚焦就不占首帧名额。
    expect(seeks).toBe(0);
    expect(sessions.diagnostics?.().staticActive).toBe(0);
    sessions.dispose();
  });

  it("页面策略是 decoder 数量与首帧并发的唯一来源", () => {
    let created = 0;
    const canvas = fixture("video", 40, 1, 10);
    // 只注入页面策略（不传 maxSessions/maxStaticDecodes）：所有媒体 owner 必须接同一份预算。
    const coordinator = new CanvasResourceCoordinator({ policy: { videoSessionLimit: 3, videoFirstFrameConcurrency: 1 } });
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 2000, height: 2000, pixelRatio: 1 },
      pageVisible: true, interactive: [], pins: [],
      candidates: canvas.document.nodes.map((node) => ({
        nodeId: node.id, contentKey: "shared", x: node.position.x, y: node.position.y,
        width: 256, height: 256, eligible: true
      }))
    });
    let seeks = 0;
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => canvas,
      residency: coordinator,
      purposeOf: (nodeId) => coordinator.purposeOf(nodeId),
      createVideo: () => { created += 1; return videoFake(() => { seeks += 1; }).video; },
      createCanvas: () => ({ width: 0, height: 0, getContext: () => null })
    });
    sessions.sync();
    expect(created).toBeLessThanOrEqual(3);
    expect(sessions.diagnostics?.().staticActive).toBeLessThanOrEqual(1);
    expect(seeks).toBeLessThanOrEqual(1);
    sessions.dispose();
    coordinator.dispose();
  });

  it("脱离需求时释放 decoder 并回到预算内", () => {
    let canvas = fixture("video", 12, 1, 10);
    const coordinator = new CanvasResourceCoordinator();
    coordinator.project({
      viewport: null, surface: null, pageVisible: true, interactive: canvas.document.nodes.map((node) => node.id), pins: [],
      candidates: canvas.document.nodes.map((node) => ({
        nodeId: node.id, contentKey: "shared", x: node.position.x, y: node.position.y,
        width: 256, height: 256, eligible: true
      }))
    });
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => canvas,
      residency: coordinator,
      purposeOf: (nodeId) => coordinator.purposeOf(nodeId),
      createVideo: () => videoFake(() => {}).video,
      createCanvas: () => ({ width: 0, height: 0, getContext: () => null })
    });
    sessions.sync();
    expect(sessions.activeNodeIds().length).toBe(12);
    canvas = { ...canvas, document: { ...canvas.document, nodes: [] } };
    coordinator.revokeAll();
    sessions.sync();
    expect(sessions.activeNodeIds()).toEqual([]);
    expect(sessions.diagnostics?.().sessions).toBe(0);
    sessions.dispose();
    coordinator.dispose();
  });
});
