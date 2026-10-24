/**
 * 100/500/1000/3000 节点的驻留门禁
 * （change: 2026-10-23-scale-canvas-media-residency，任务 1.1/1.2/1.3/9.1 的可重复回归）。
 *
 * 断言的是**逻辑硬门禁**（design D9 第 2 条）：准入先于创建；固定可见集合下重资源数量不随
 * 文档规模增长；同 key 只启动一份工作；静止帧零创建；删除/撤销不复活旧代资源。
 *
 * 这里不含任何硬件时间结论：fake 解码器与 fake 运行时只能证明调度逻辑，真实帧率/长尾/显存
 * 必须在真实 GPU 上采集（见 verification.md 的「待人工验证」）。
 */
import { describe, expect, it } from "vitest";
import { createTextureSync } from "../plugins/canvas-runtime/texture-sync.js";
import { createVideoFrameSessions, type VideoElementLike } from "../plugins/canvas-runtime/video-frame-session.js";
import {
  CanvasResourceCoordinator,
  createContentIdentity,
  createResidencyCandidateCache,
  createResidencyProjector,
  type ResidencyCandidate
} from "../plugins/canvas-runtime/residency/index.js";
import type { BevyRuntime } from "../plugins/canvas-runtime/bevy-runtime.js";
import type { RasterCanvas } from "../plugins/canvas-runtime/media-raster.js";
import {
  SCALE_FIXTURE_FIXED_VISIBLE,
  createScaleFixture,
  fixedDemandProjection,
  type ScaleFixture
} from "./canvas-scale-fixture.js";

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

function fakeVideo(onSeek: () => void): VideoElementLike {
  const events = new Map<string, (event: unknown) => void>();
  let currentTime = 0;
  return {
    src: "", preload: "", muted: true, loop: false, playsInline: true, duration: 6, crossOrigin: null,
    get currentTime() { return currentTime; },
    set currentTime(value: number) { currentTime = value; onSeek(); },
    videoWidth: 1280, videoHeight: 720, pause() {}, load() {}, play() { return Promise.resolve(); },
    removeAttribute() {},
    addEventListener(name, handler) {
      if (typeof name === "string" && typeof handler === "function") events.set(name, handler);
    },
    removeEventListener() {}, requestVideoFrameCallback() { return 1; }, cancelVideoFrameCallback() {}
  } as VideoElementLike;
}

/** 组装一个 attach scope 形态的投影：内容身份 + 候选 memo + 每帧投影。 */
function scope(fixture: ScaleFixture, coordinator: CanvasResourceCoordinator) {
  const contentKeyOfOf = createContentIdentity({
    modelResourceKey: (nodeId) => `woohaa-model-scene-ir-v2:${nodeId}-content`
  });
  const candidatesFor = createResidencyCandidateCache(contentKeyOfOf);
  const projection = fixture.meta.demand === "fixed"
    ? fixedDemandProjection(fixture)
    : { viewport: { x: 0, y: 0, zoom: 1 },
        surface: { width: fixture.meta.count * fixture.meta.spacing, height: 4096, pixelRatio: 1 } };
  const project = createResidencyProjector({
    coordinator,
    getCanvas: () => fixture.canvas,
    candidatesFor,
    viewport: () => projection.viewport,
    surface: () => projection.surface,
    interactive: () => [],
    pins: () => [],
    pageVisible: () => true
  });
  return { project, candidatesFor, contentKeyOfOf };
}

function candidatesOf(fixture: ScaleFixture): ResidencyCandidate[] {
  const contentKeyOfOf = createContentIdentity({ modelResourceKey: (nodeId) => `model:${nodeId}` });
  return [...createResidencyCandidateCache(contentKeyOfOf)(fixture.canvas)];
}

describe("千卡片 fixture 的形状", () => {
  it("100/500/1000/3000 的图片/视频/模型/混合与相同/不同资产都可确定性重建", () => {
    for (const count of [100, 500, 1000, 3000] as const) {
      for (const kind of ["image", "video", "model", "mixed"] as const) {
        for (const assets of ["shared", "distinct"] as const) {
          const first = createScaleFixture({ count, kind, assets });
          const second = createScaleFixture({ count, kind, assets });
          expect(first.canvas.document.nodes).toHaveLength(count);
          expect(first.meta.seed).toBe(second.meta.seed);
          // 时间戳来自 `createEmptyWoohaa3ServerCanvas`，不是 fixture 内容：比较结构与内容。
          expect({ ...first.canvas, updatedAt: "" }).toEqual({ ...second.canvas, updatedAt: "" });
          expect(first.canvas.document.updatedAt).toEqual(expect.any(String));
          expect(first.meta.distinctAssets).toBe(assets === "shared" ? 1 : count);
        }
      }
    }
    const mixed = createScaleFixture({ count: 1000, kind: "mixed" });
    expect(mixed.meta.nodeKinds.image).toBe(500);
    expect(mixed.meta.nodeKinds.video).toBe(250);
    expect(mixed.meta.nodeKinds.model).toBe(250);
    // 固定可见形态只声明 24 个需求；密集总览覆盖全部节点。
    expect(mixed.visibleNodeIds).toHaveLength(SCALE_FIXTURE_FIXED_VISIBLE);
    expect(createScaleFixture({ count: 3000, demand: "dense" }).visibleNodeIds).toHaveLength(3000);
  });
});

describe("固定可见需求下重资源数量不随文档规模增长", () => {
  it("100 与 3000 节点的准入集合都由同一预算约束", () => {
    const small = createScaleFixture({ count: 100 });
    const large = createScaleFixture({ count: 3000 });
    const counts: number[] = [];
    for (const fixture of [small, large]) {
      const coordinator = new CanvasResourceCoordinator();
      const { project } = scope(fixture, coordinator);
      project();
      counts.push(coordinator.admittedNodeIds().length);
      coordinator.dispose();
    }
    // 两者都只准入固定视口覆盖的那一小片，而不是整张文档。
    expect(counts[0]).toBeLessThanOrEqual(SCALE_FIXTURE_FIXED_VISIBLE * 2);
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThan(100);
  });

  it("密集总览受页 GPU 估算预算约束，而不是被预览槽截断", () => {
    const coordinator = new CanvasResourceCoordinator();
    const fixture = createScaleFixture({ count: 3000, demand: "dense" });
    const { project } = scope(fixture, coordinator);
    project();
    const admitted = coordinator.admittedNodeIds().length;
    expect(admitted).toBeGreaterThan(0);
    // 预览槽只服务离屏预览相机（模型/复合资产）；密集总览全是图片卡，必须由 GPU 估算预算
    // 收敛，不能沿用预览槽数量（否则 16 张之后全部卡片只能 hover 才加载）。
    expect(admitted).toBeGreaterThan(coordinator.getPolicy().previewSlots);
    const diagnostics = coordinator.diagnostics();
    expect(diagnostics.demands).toBe(admitted);
    expect(diagnostics.deferred).toBeGreaterThan(0);
    // GPU/CPU 都只是估算值，但仍必须存在且被统计（design D3）。
    expect(diagnostics.estimatedGpuBytes).toBeGreaterThan(0);
    expect(diagnostics.estimatedGpuBytes).toBeLessThanOrEqual(coordinator.getPolicy().gpuDerivedBytes);
    expect(diagnostics.estimatedCpuBytes).toBe(diagnostics.estimatedGpuBytes);
    coordinator.dispose();
  });

  it("候选表覆盖尾部节点，裁剪不会退化成固定数组前缀", () => {
    // 公平性前提：候选表必须包含尾部节点，否则裁剪会退化成「固定取数组前缀」（design D9）。
    const fixture = createScaleFixture({ count: 1000 });
    const candidates = candidatesOf(fixture);
    expect(candidates).toHaveLength(1000);
    expect(candidates.at(-1)!.nodeId).toBe("n999");
    expect(candidates.filter(candidate => candidate.eligible)).toHaveLength(1000);
  });
});

describe("千卡片图片准入", () => {
  it("1000 张同 key 只解码一次、上传按帧预算收敛到准入数", async () => {
    const fixture = createScaleFixture({ count: 1000, demand: "dense" });
    const coordinator = new CanvasResourceCoordinator();
    const { project } = scope(fixture, coordinator);
    project();
    let loads = 0;
    const uploaded = new Set<string>();
    const sync = createTextureSync({
      runtime: { setTexture: (id: string) => { uploaded.add(id); return true; } } as unknown as BevyRuntime,
      getCanvas: () => fixture.canvas,
      residency: coordinator,
      admissionOf: (nodeId) => {
        const tier = coordinator.tierOf(nodeId);
        const purpose = coordinator.purposeOf(nodeId);
        return coordinator.isAdmitted(nodeId) && tier !== null && purpose !== null
          ? { admitted: true as const, purpose, tier }
          : null;
      },
      createCanvas: fakeRaster,
      loadImage: () => { loads += 1; return Promise.resolve(fakeImage()); }
    });
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    const admitted = coordinator.admittedNodeIds().length;
    expect(loads).toBe(1);
    expect(coordinator.channelSnapshot("image").started).toBe(1);
    // 上传 staging 是**每帧**预算：一帧只能推进有限张，其余保留待上传（design D3）。
    // 不变式是「单帧上传数受预算约束」+「继续推进后收敛到准入集合」，不是一帧传完。
    expect(uploaded.size).toBeGreaterThan(0);
    expect(uploaded.size).toBeLessThanOrEqual(admitted);
    const firstFrame = uploaded.size;
    for (let frame = 0; frame < 200 && uploaded.size < admitted; frame += 1) {
      coordinator.beginFrame();
      sync.sync();
    }
    expect(uploaded.size).toBe(admitted);
    // 同 key 仍然只解码一次，没有被逐帧上传放大成多次解码。
    expect(loads).toBe(1);
    expect(coordinator.channelSnapshot("image").started).toBe(1);
    expect(firstFrame).toBeLessThanOrEqual(admitted);
    expect(coordinator.channelSnapshot("image").inFlight).toBe(0);
    sync.dispose();
    coordinator.dispose();
  });

  it("不同资产在 1000 个需求下仍有界排队（默认并发 2）", () => {
    const fixture = createScaleFixture({ count: 1000, assets: "distinct", demand: "dense" });
    const coordinator = new CanvasResourceCoordinator();
    const { project } = scope(fixture, coordinator);
    project();
    let loads = 0;
    const sync = createTextureSync({
      runtime: { setTexture: () => true } as unknown as BevyRuntime,
      getCanvas: () => fixture.canvas,
      residency: coordinator,
      admissionOf: (nodeId) => {
        const tier = coordinator.tierOf(nodeId);
        const purpose = coordinator.purposeOf(nodeId);
        return coordinator.isAdmitted(nodeId) && tier !== null && purpose !== null
          ? { admitted: true as const, purpose, tier }
          : null;
      },
      createCanvas: fakeRaster,
      // 永远不 settle：解码名额不得因为「函数返回」而归还。
      loadImage: () => { loads += 1; return new Promise<HTMLImageElement>(() => undefined); }
    });
    sync.sync();
    const snapshot = coordinator.channelSnapshot("image");
    expect(loads).toBe(coordinator.getPolicy().imageDecodeConcurrency);
    expect(loads).toBe(2);
    expect(snapshot.inFlight).toBe(2);
    expect(snapshot.pending).toBeGreaterThan(0);
    sync.dispose();
    coordinator.dispose();
  });
});

describe("千视频准入", () => {
  it("1000 个视频只为准入名额创建 decoder，重复同步不新建", () => {
    const fixture = createScaleFixture({ count: 1000, kind: "video", demand: "dense" });
    const coordinator = new CanvasResourceCoordinator();
    const { project } = scope(fixture, coordinator);
    project();
    let created = 0;
    const sessions = createVideoFrameSessions({
      runtime,
      getCanvas: () => fixture.canvas,
      residency: coordinator,
      purposeOf: (nodeId) => coordinator.purposeOf(nodeId),
      createVideo: () => { created += 1; return fakeVideo(() => {}); },
      createCanvas: () => ({ width: 0, height: 0, getContext: () => null })
    });
    sessions.sync();
    const first = created;
    const admitted = coordinator.admittedNodeIds().length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(coordinator.getPolicy().videoSessionLimit);
    expect(first).toBeLessThanOrEqual(admitted);
    for (let frame = 0; frame < 20; frame += 1) sessions.sync();
    expect(created).toBe(first);
    sessions.dispose();
    coordinator.dispose();
  });
});

describe("静止帧零创建", () => {
  it("1000 次静止同步不新建纹理/解码/视频会话", async () => {
    const fixture = createScaleFixture({ count: 500, demand: "dense" });
    const coordinator = new CanvasResourceCoordinator();
    const { project } = scope(fixture, coordinator);
    let loads = 0;
    let setTextures = 0;
    const sync = createTextureSync({
      runtime: { setTexture: () => { setTextures += 1; return true; } } as unknown as BevyRuntime,
      getCanvas: () => fixture.canvas,
      residency: coordinator,
      admissionOf: (nodeId) => {
        const tier = coordinator.tierOf(nodeId);
        const purpose = coordinator.purposeOf(nodeId);
        return coordinator.isAdmitted(nodeId) && tier !== null && purpose !== null
          ? { admitted: true as const, purpose, tier }
          : null;
      },
      createCanvas: fakeRaster,
      loadImage: () => { loads += 1; return Promise.resolve(fakeImage()); }
    });
    project();
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    // 先让受每帧 staging 预算约束的上传收敛，再测静止帧：本用例断言的是「静止后不再新建」，
    // 不是「一帧就传完全部准入项」（后者违反 design D3 的每帧 8 MiB 预算）。
    const admitted = coordinator.admittedNodeIds().length;
    for (let frame = 0; frame < 200 && setTextures < admitted; frame += 1) {
      coordinator.beginFrame();
      sync.sync();
    }
    const loadsAfterWarm = loads;
    const uploadsAfterWarm = setTextures;
    const startedAfterWarm = coordinator.channelSnapshot("image").started;
    for (let frame = 0; frame < 1000; frame += 1) {
      project();
      sync.sync();
    }
    expect(loads).toBe(loadsAfterWarm);
    expect(setTextures).toBe(uploadsAfterWarm);
    expect(coordinator.channelSnapshot("image").started).toBe(startedAfterWarm);
    expect(coordinator.channelSnapshot("image").merged).toBe(0);
    sync.dispose();
    coordinator.dispose();
  });
});

describe("删除与失权", () => {
  it("删除全部节点后准入集合与纹理引用都被释放，不复活旧代资源", async () => {
    let fixture = createScaleFixture({ count: 100, demand: "dense" });
    const coordinator = new CanvasResourceCoordinator();
    const contentKeyOfOf = createContentIdentity({});
    const candidatesFor = createResidencyCandidateCache(contentKeyOfOf);
    const project = createResidencyProjector({
      coordinator,
      getCanvas: () => fixture.canvas,
      candidatesFor,
      viewport: () => ({ x: 0, y: 0, zoom: 1 }),
      surface: () => ({ width: 100_000, height: 100_000, pixelRatio: 1 }),
      interactive: () => [],
      pins: () => [],
      pageVisible: () => true
    });
    const sync = createTextureSync({
      runtime: { setTexture: () => true } as unknown as BevyRuntime,
      getCanvas: () => fixture.canvas,
      residency: coordinator,
      admissionOf: (nodeId) => {
        const tier = coordinator.tierOf(nodeId);
        const purpose = coordinator.purposeOf(nodeId);
        return coordinator.isAdmitted(nodeId) && tier !== null && purpose !== null
          ? { admitted: true as const, purpose, tier }
          : null;
      },
      createCanvas: fakeRaster,
      loadImage: () => Promise.resolve(fakeImage())
    });
    project();
    sync.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sync.sync();
    expect(sync.textureNodeIds().size).toBeGreaterThan(0);
    // 切画布 / 删除全部节点：新的画布对象（结构变化）而不是原地改数组。
    const empty = createScaleFixture({ count: 100, demand: "dense", canvasId: fixture.canvas.id });
    fixture = { ...empty, canvas: { ...empty.canvas, document: { ...empty.canvas.document, nodes: [], edges: [] } } };
    project();
    sync.sync();
    expect(coordinator.admittedNodeIds()).toEqual([]);
    expect(sync.textureNodeIds().size).toBe(0);
    // 撤销后重放同样的需求可以重新准入，但旧对象不放回。
    expect(coordinator.diagnostics().revoked).toBeGreaterThan(0);
    sync.dispose();
    coordinator.dispose();
  });
});
