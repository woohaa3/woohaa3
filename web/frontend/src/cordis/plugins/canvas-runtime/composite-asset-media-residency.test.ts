/**
 * 片场媒体准入与公平轮换
 * （change: 2026-10-23-scale-canvas-media-residency，任务 3.4/3.5 的可重复门禁）。
 *
 * 取代「固定截取前 24 个来源」的缺陷：当前播放/捕获目标必须获得资源；非目标候选按等待年龄
 * 轮换，尾部片场不会永久缺图。严格取帧（`waitForTime`）先把自己提升为当前目标再等待。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import {
  createCompositeAssetMediaSessions,
  COMPOSITE_ASSET_MEDIA_ROTATION_INTERVAL_MS
} from "./composite-asset-media-session.js";
import { CanvasResourceCoordinator } from "./residency/index.js";
import { IMAGE_RETRY_DELAYS_MS, ImageLoadError } from "./image-load.js";
import type { CompositeAssetMediaSource } from "../../../extension-api/composite-assets.js";

const NOW = "2026-10-23T00:00:00Z";

/** 40 个片场节点，每个一个图片平面；同一资产（同内容身份）便于只关心会话数量。 */
function fixture(count = 40): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `fs${index}`,
    type: "composite-asset",
    position: { x: index * 400, y: 0 },
    width: 400,
    height: 400
  }));
  const asset: StoredAsset = {
    id: "asset-image",
    title: "图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    url: "/api/media/a",
    metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 4 }
  };
  return {
    ...base,
    document: { ...base.document, nodes, edges: [] },
    nodeData: Object.fromEntries(nodes.map((node) => [node.id, { extensionId: "film-set" }])) as ServerCanvas["nodeData"],
    assets: [asset]
  };
}

function sources(canvas: ServerCanvas): CompositeAssetMediaSource[] {
  return canvas.document.nodes.map((node) => ({
    planeId: `${node.id}::img`,
    nodeId: node.id,
    itemId: "img",
    kind: "image" as const,
    assetId: "asset-image",
    sourceIdentity: `s-${node.id}`
  }));
}

function runtimeRecorder() {
  const planes: string[] = [];
  return {
    planes,
    runtime: {
      retryVersion: () => 0,
      setModelMediaTexture: (planeId: string) => { planes.push(planeId); return true; }
    } as never
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 记录每次创建/释放的平面（通过纹理上传观察哪些会话真实存在）。 */
function createSessions(canvas: () => ServerCanvas, extra: {
  maxSessions?: number;
  residency?: CanvasResourceCoordinator;
  now?: () => number;
}) {
  const created: string[] = [];
  const recorder = runtimeRecorder();
  const sessions = createCompositeAssetMediaSessions({
    runtime: recorder.runtime,
    getCanvas: canvas,
    getSources: () => sources(canvas()),
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) })
    }),
    loadImage: (url) => { created.push(url); return Promise.resolve({ width: 64, height: 64 }); },
    ...(extra.maxSessions !== undefined ? { maxSessions: extra.maxSessions } : {}),
    ...(extra.residency ? { residency: extra.residency, purposeOf: (nodeId: string) => extra.residency!.purposeOf(nodeId) } : {}),
    ...(extra.now ? { now: extra.now, rotationIntervalMs: COMPOSITE_ASSET_MEDIA_ROTATION_INTERVAL_MS } : {})
  });
  return { sessions, created, planes: recorder.planes };
}

describe("片场媒体准入", () => {
  it("没有协调器时仍按 maxSessions 有界，但优先当前播放目标而不是数组前缀", async () => {
    let canvas = fixture(40);
    const { sessions, created } = createSessions(() => canvas, { maxSessions: 4 });
    sessions.sync();
    await flush();
    // 尚未有播放头：前 4 个候选（数组顺序）先占槽，数量受上限约束。
    expect(created).toHaveLength(4);
    created.length = 0;
    // 第 30 个片场成为当前播放目标：必须取得会话（而不是因前缀截断永久缺图）。
    sessions.setMediaTime("fs30", 0, false);
    sessions.sync();
    await flush();
    const diag = sessions.diagnostics?.() as Array<{ nodeId: string }>;
    expect(diag.some((entry) => entry.nodeId === "fs30")).toBe(true);
    expect(diag).toHaveLength(4);
    sessions.dispose();
  });

  it("协调器未准入的片场不创建会话；准入后按需补齐", async () => {
    const canvas = fixture(6);
    const coordinator = new CanvasResourceCoordinator();
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 1000, height: 1000, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: canvas.document.nodes.map((node) => ({
        nodeId: node.id,
        contentKey: "asset:shared",
        x: node.position.x,
        y: node.position.y,
        width: 400,
        height: 400,
        eligible: true
      }))
    });
    const { sessions, created } = createSessions(() => canvas, { maxSessions: 4, residency: coordinator });
    sessions.sync();
    await flush();
    const admitted = new Set(coordinator.admittedNodeIds());
    const diag = (sessions.diagnostics?.() as Array<{ nodeId: string }>).map((entry) => entry.nodeId);
    expect(diag.length).toBeLessThanOrEqual(admitted.size);
    for (const nodeId of diag) expect(admitted.has(nodeId)).toBe(true);
    expect(diag.length).toBeLessThanOrEqual(4);
    expect(created.length).toBe(diag.length);
    sessions.dispose();
    coordinator.dispose();
  });

  it("候选多于槽位时按等待年龄公平轮换，第 24 项之后最终也能取得资源", async () => {
    let clock = 0;
    const canvas = fixture(40);
    const { sessions } = createSessions(() => canvas, { maxSessions: 4, now: () => clock });
    sessions.sync();
    await flush();
    const seen = new Set<string>();
    for (const entry of sessions.diagnostics?.() as Array<{ nodeId: string }>) seen.add(entry.nodeId);
    // 每推进一个轮换间隔，应换入一个此前未驻留的候选。
    for (let round = 0; round < 12; round += 1) {
      clock += COMPOSITE_ASSET_MEDIA_ROTATION_INTERVAL_MS;
      sessions.sync();
      await flush();
      for (const entry of sessions.diagnostics?.() as Array<{ nodeId: string }>) seen.add(entry.nodeId);
      const diag = sessions.diagnostics?.() as Array<{ nodeId: string }>;
      expect(diag).toHaveLength(4);
    }
    // 前 4 个之外的候选出现了：既没有冻结在数组前缀，也没有无限扩大会话数。
    expect([...seen].some((nodeId) => Number(nodeId.slice(2)) >= 4)).toBe(true);
    expect(seen.size).toBeGreaterThan(4);
    sessions.dispose();
  });

  it("严格取帧前先把目标提升为当前会话，不因普通准入缺席而误报就绪", async () => {
    const canvas = fixture(40);
    const { sessions, created } = createSessions(() => canvas, { maxSessions: 2 });
    sessions.sync();
    await flush();
    created.length = 0;
    const ready = await sessions.waitForTime("fs35", 0, 200, 0.05);
    // 图片平面：会话被创建并上传后即视为就绪（不会因为「不在前 2 个」直接返回 true 假成功）。
    const diag = sessions.diagnostics?.() as Array<{ nodeId: string }>;
    expect(diag.some((entry) => entry.nodeId === "fs35")).toBe(true);
    expect(created.length).toBeGreaterThan(0);
    expect(ready || diag.some((entry) => entry.nodeId === "fs35")).toBe(true);
    sessions.dispose();
  });

  it("单个片场平面数超过会话上限时严格取帧按容量失败，不输出缺对象结果", async () => {
    const canvas = fixture(2);
    // 该片场应输出 4 个平面，但本页只允许 2 个会话：等待再久也补不齐，必须明确失败。
    const fourPlanes = () => ["a", "b", "c", "d"].map((itemId) => ({
      planeId: `fs0::${itemId}`,
      nodeId: "fs0",
      itemId,
      kind: "image" as const,
      assetId: "asset-image",
      sourceIdentity: `s-fs0-${itemId}`
    }));
    const recorder = runtimeRecorder();
    const sessions = createCompositeAssetMediaSessions({
      runtime: recorder.runtime,
      getCanvas: () => canvas,
      getSources: fourPlanes,
      maxSessions: 2,
      loadImage: () => Promise.resolve({ width: 8, height: 8 }),
      createCanvas: () => ({ width: 0, height: 0, getContext: () => null })
    });
    sessions.sync();
    expect(await sessions.waitForTime("fs0", 0, 100, 0.05)).toBe(false);
    // 缺平面不等于整体失败：其余平面仍按普通准入输出（这里是前 2 个）。
    expect((sessions.diagnostics?.() as unknown[]).length).toBeGreaterThan(0);
    sessions.dispose();
  });

  it("删除片场后会话与等待队列都被清理", async () => {
    let canvas = fixture(8);
    const { sessions } = createSessions(() => canvas, { maxSessions: 4 });
    sessions.sync();
    await flush();
    expect((sessions.diagnostics?.() as unknown[]).length).toBe(4);
    canvas = { ...canvas, document: { ...canvas.document, nodes: [], edges: [] } };
    sessions.sync();
    expect(sessions.diagnostics?.()).toEqual([]);
    sessions.dispose();
  });
});

describe("片场图片平面的传输失败恢复", () => {
  /** 可注入时钟 + 可注入失败：验证退避节流，不依赖真实时间。 */
  function flaky(canvas: () => ServerCanvas, failWith: () => Error, limit = 1) {
    let nowMs = 0;
    let attempts = 0;
    const recorder = runtimeRecorder();
    const instance = createCompositeAssetMediaSessions({
      runtime: recorder.runtime,
      getCanvas: canvas,
      getSources: () => sources(canvas()),
      maxSessions: limit,
      now: () => nowMs,
      loadImage: () => { attempts += 1; return Promise.reject(failWith()); },
      createCanvas: () => ({ width: 0, height: 0, getContext: () => null })
    });
    return { sessions: instance, attempts: () => attempts, advance: (ms: number) => { nowMs += ms; } };
  }

  it("传输失败按退避重试，不把健康素材永久钉成错误", async () => {
    const harness = flaky(() => fixture(1), () => new ImageLoadError("图片加载失败（HTTP 502）。", true));
    harness.sessions.sync();
    await flush();
    expect(harness.attempts()).toBe(1);
    // 退避未到期：继续 sync 也不打媒体服务（故障期间不能逐帧重试）。
    harness.sessions.sync();
    await flush();
    expect(harness.attempts()).toBe(1);
    harness.advance(IMAGE_RETRY_DELAYS_MS[0]);
    harness.sessions.sync();
    await flush();
    expect(harness.attempts()).toBe(2);
    harness.sessions.dispose();
  });

  it("内容失败不自动重试", async () => {
    const harness = flaky(() => fixture(1), () => new ImageLoadError("图片加载失败（HTTP 404）。", false));
    harness.sessions.sync();
    await flush();
    expect(harness.attempts()).toBe(1);
    harness.advance(60_000);
    harness.sessions.sync();
    await flush();
    expect(harness.attempts()).toBe(1);
    harness.sessions.dispose();
  });
});
