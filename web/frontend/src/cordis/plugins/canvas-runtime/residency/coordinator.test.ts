import { describe, expect, it, vi } from "vitest";
import { ResidencyChannelQueue } from "./channel-queue.js";
import {
  DEFAULT_RESIDENCY_POLICY,
  concurrencyLimit,
  resolveResidencyPolicy,
  selectThumbnailTier
} from "./policy.js";
import { CanvasResourceCoordinator } from "./coordinator.js";

/** 手动可控的 deferred，用于断言「函数返回 ≠ 名额归还」。 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("residency policy", () => {
  it("injected budgets are clamped to finite positive limits and never loosen silently", () => {
    const policy = resolveResidencyPolicy({ imageDecodeConcurrency: Number.POSITIVE_INFINITY, videoSessionLimit: -3, previewSlots: 4, modelPrepareBudgetMs: 10_000 });
    // 非法注入被忽略（保留集中默认），不能把并发写成 Infinity/负数绕开预算。
    expect(policy.imageDecodeConcurrency).toBe(DEFAULT_RESIDENCY_POLICY.imageDecodeConcurrency);
    expect(policy.videoSessionLimit).toBe(DEFAULT_RESIDENCY_POLICY.videoSessionLimit);
    expect(policy.previewSlots).toBe(4);
    // 片段预算同样只接受有限的合理值，不能注入 10 秒的主线程占用。
    expect(policy.modelPrepareBudgetMs).toBe(100);
    expect(resolveResidencyPolicy({ previewSlots: 10_000 }).previewSlots).toBe(256);
    expect(concurrencyLimit(policy, "video-frame")).toBe(DEFAULT_RESIDENCY_POLICY.videoFirstFrameConcurrency);
    expect(concurrencyLimit(policy, "upload")).toBe(Number.POSITIVE_INFINITY);
  });

  it("thumbnail tiers follow the physical edge instead of a fixed 1024", () => {
    expect(selectThumbnailTier(40)).toBe(128);
    expect(selectThumbnailTier(120)).toBe(128);
    expect(selectThumbnailTier(200)).toBe(256);
    expect(selectThumbnailTier(900)).toBe(1024);
    expect(selectThumbnailTier(4000)).toBe(1024);
    expect(selectThumbnailTier(Number.NaN)).toBe(128);
  });
});

describe("ResidencyChannelQueue", () => {
  it("holds the slot until the async work really settles, not when the start function returns", async () => {
    const queue = new ResidencyChannelQueue("image", { concurrency: 2 });
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    const running = gates.map((gate, index) => queue.admit({
      key: `k${index}`,
      purpose: "visible",
      run: async () => { started.push(`k${index}`); await gate.promise; return index; }
    }));
    await flush();
    // 只有 2 个真正启动；第 3 个等待，而不是「前两个启动函数返回就放行」。
    expect(started).toEqual(["k0", "k1"]);
    expect(queue.inFlightCount()).toBe(2);
    expect(queue.pendingCount()).toBe(1);
    gates[0].resolve();
    await flush();
    expect(started).toEqual(["k0", "k1", "k2"]);
    expect(queue.inFlightCount()).toBe(2);
    gates[1].resolve();
    gates[2].resolve();
    await flush();
    expect(queue.idle()).toBe(true);
    const outcomes = await Promise.all(running);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["settled", "settled", "settled"]);
  });

  it("merges duplicate in-flight work for the same content key", async () => {
    const queue = new ResidencyChannelQueue("image", { concurrency: 4 });
    const gate = deferred<string>();
    const run = vi.fn(async () => gate.promise);
    const first = queue.admit({ key: "same", purpose: "visible", run });
    const second = queue.admit({ key: "same", purpose: "visible", run });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    gate.resolve("pixels");
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ status: "settled", value: "pixels" });
    expect(b).toEqual({ status: "settled", value: "pixels" });
    expect(queue.snapshot().merged).toBe(1);
  });

  it("non-abortable cancellation drains instead of freeing the slot early", async () => {
    const queue = new ResidencyChannelQueue("video-frame", { concurrency: 1 });
    const gate = deferred<void>();
    const first = queue.admit({ key: "a", purpose: "visible", abortable: false, run: async () => { await gate.promise; } });
    await flush();
    queue.cancelKey("a");
    expect(queue.inFlightCount()).toBe(1);
    expect(queue.snapshot().draining).toBe(1);
    // 取消后不得因「先释放额度」启动同量新任务。
    const secondRun = vi.fn(async () => undefined);
    void queue.admit({ key: "b", purpose: "visible", run: secondRun });
    await flush();
    expect(secondRun).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    // 第一个任务真正终结后才轮到第二个：名额没有在取消时被提前释放。
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(queue.idle()).toBe(true);
    expect((await first).status).toBe("cancelled");
  });

  it("abortable cancellation frees the slot exactly once", async () => {
    const queue = new ResidencyChannelQueue("image", { concurrency: 1 });
    const run = vi.fn(async ({ lease }: { lease: { signal: AbortSignal } }) => {
      await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const outcome = queue.admit({ key: "a", purpose: "visible", run });
    await flush();
    queue.cancelKey("a");
    await flush();
    expect(queue.inFlightCount()).toBe(0);
    expect((await outcome).status).toBe("cancelled");
    const second = vi.fn(async () => 1);
    void queue.admit({ key: "b", purpose: "visible", run: second });
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps same-purpose age fairness and lets interactive work go first", async () => {
    const queue = new ResidencyChannelQueue("model-prepare", { concurrency: 1 });
    const firstGate = deferred<void>();
    void queue.admit({ key: "busy", purpose: "interactive", run: async () => { await firstGate.promise; } });
    await flush();
    const order: string[] = [];
    void queue.admit({ key: "warm-1", purpose: "warm", run: async () => { order.push("warm-1"); } });
    void queue.admit({ key: "visible-2", purpose: "visible", run: async () => { order.push("visible-2"); } });
    void queue.admit({ key: "warm-2", purpose: "warm", run: async () => { order.push("warm-2"); } });
    void queue.admit({ key: "visible-1", purpose: "visible", run: async () => { order.push("visible-1"); } });
    firstGate.resolve();
    await flush();
    await flush();
    // visible 全部先于 warm；同为 visible 保持原始排队年龄。
    expect(order).toEqual(["visible-2", "visible-1", "warm-1", "warm-2"]);
  });

  it("respects byte reservations and reports them in the snapshot", async () => {
    const queue = new ResidencyChannelQueue("upload", { concurrency: 8, byteBudget: 100, perFrameBytes: 100 });
    queue.beginFrame();
    const gate = deferred<void>();
    const big = vi.fn(async () => { await gate.promise; });
    let settled = 0;
    void queue.admit({ key: "big", purpose: "visible", bytes: 90, run: big }).then(() => { settled += 1; });
    await flush();
    expect(queue.reserved()).toBe(90);
    // 剩 10 字节：80 字节的需求必须等待。
    const small = vi.fn(async () => undefined);
    void queue.admit({ key: "small", purpose: "visible", bytes: 80, run: small });
    await flush();
    expect(small).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(small).toHaveBeenCalledTimes(1);
    expect(settled).toBe(1);
  });
});

describe("CanvasResourceCoordinator", () => {
  const nodes = [
    { nodeId: "near", contentKey: "k-near", x: 0, y: 0, width: 200, height: 200, eligible: true },
    { nodeId: "far", contentKey: "k-far", x: 100_000, y: 0, width: 200, height: 200, eligible: true },
    { nodeId: "text", contentKey: "k-text", x: 0, y: 0, width: 200, height: 200, eligible: false }
  ];

  it("admits only visible/interactive/pinned demands and keeps offscreen nodes out", () => {
    const coordinator = new CanvasResourceCoordinator();
    const fresh = coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: nodes
    });
    expect(fresh).toEqual(["near"]);
    expect(coordinator.isAdmitted("far")).toBe(false);
    expect(coordinator.isAdmitted("text")).toBe(false);
    coordinator.dispose();
  });

  it("pauses ordinary prefetch without a surface but keeps explicit pins", () => {
    const coordinator = new CanvasResourceCoordinator();
    coordinator.project({
      viewport: null,
      surface: null,
      pageVisible: true,
      interactive: [],
      pins: ["far"],
      candidates: nodes
    });
    expect(coordinator.admittedNodeIds()).toEqual(["far"]);
    // 恢复有效 surface 后重新计算需求，而不是保留「全量准入」。
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: nodes
    });
    expect(coordinator.admittedNodeIds()).toEqual(["near"]);
    coordinator.dispose();
  });

  it("hidden page keeps interaction but stops new warm work", () => {
    const coordinator = new CanvasResourceCoordinator();
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: false,
      interactive: ["near"],
      pins: [],
      candidates: nodes
    });
    expect(coordinator.admittedNodeIds()).toEqual(["near"]);
    coordinator.dispose();
  });

  it("caps preview-slot admissions and never starves pinned targets", () => {
    // 预览槽只约束需要离屏预览相机的需求（模型/复合资产）；这里全部声明为预览需求。
    const coordinator = new CanvasResourceCoordinator({ policy: { previewSlots: 2 } });
    const many = Array.from({ length: 10 }, (_, index) => ({
      nodeId: `n${index}`, contentKey: `k${index}`, x: index * 10, y: 0, width: 200, height: 200,
      eligible: true, previewSlot: true
    }));
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 2000, height: 600, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: ["n9"],
      candidates: many
    });
    const admitted = new Set(coordinator.admittedNodeIds());
    expect(admitted.size).toBeLessThanOrEqual(3);
    expect(admitted.has("n9")).toBe(true);
    // 裁剪只影响重资源准入，不改变文档节点：候选仍在下一帧参与投影。
    expect(coordinator.diagnostics().deferred).toBeGreaterThan(0);
    coordinator.dispose();
  });

  it("does not spend preview slots on plain media cards", () => {
    // 图片/视频的纹理是卡片贴图，不占离屏预览槽：槽只剩 1 个时仍应准入全部卡片。
    const coordinator = new CanvasResourceCoordinator({ policy: { previewSlots: 1 } });
    const many = Array.from({ length: 10 }, (_, index) => ({
      nodeId: `n${index}`, contentKey: `k${index}`, x: index * 10, y: 0, width: 200, height: 200,
      eligible: true, previewSlot: false
    }));
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 2000, height: 600, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: many
    });
    expect(coordinator.admittedNodeIds()).toHaveLength(10);
    expect(coordinator.diagnostics().deferred).toBe(0);
    coordinator.dispose();
  });

  it("chooses a thumbnail tier from the projected physical size", () => {
    const coordinator = new CanvasResourceCoordinator();
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 0.25 },
      surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: [{ nodeId: "n", contentKey: "k", x: 0, y: 0, width: 512, height: 512, eligible: true }]
    });
    expect(coordinator.tierOf("n")).toBe(128);
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 1600, height: 1200, pixelRatio: 2 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: [{ nodeId: "n", contentKey: "k", x: 0, y: 0, width: 512, height: 512, eligible: true }]
    });
    expect(coordinator.tierOf("n")).toBe(1024);
    coordinator.dispose();
  });

  it("runs media work through the unified channel budget", async () => {
    const coordinator = new CanvasResourceCoordinator({ policy: { videoFirstFrameConcurrency: 1 } });
    const gate = deferred<void>();
    const started: string[] = [];
    void coordinator.admit({ channel: "video-frame", key: "a", purpose: "visible",
      run: async () => { started.push("a"); await gate.promise; } });
    void coordinator.admit({ channel: "video-frame", key: "b", purpose: "visible",
      run: async () => { started.push("b"); } });
    await flush();
    expect(started).toEqual(["a"]);
    expect(coordinator.channelSnapshot("video-frame").pending).toBe(1);
    gate.resolve();
    await flush();
    expect(started).toEqual(["a", "b"]);
    coordinator.dispose();
  });

  it("revokes demands and cancels in-flight work without resurrecting results", async () => {
    const coordinator = new CanvasResourceCoordinator();
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true, interactive: ["near"], pins: [], candidates: nodes
    });
    let published = false;
    void coordinator.admit({
      channel: "image", key: "near", purpose: "interactive",
      run: async ({ lease }) => {
        await new Promise<void>((resolve) => lease.signal.addEventListener("abort", () => resolve(), { once: true }));
        if (!lease.signal.aborted) published = true;
      }
    });
    await flush();
    coordinator.revoke("near");
    await flush();
    expect(coordinator.isAdmitted("near")).toBe(false);
    expect(published).toBe(false);
    expect(coordinator.diagnostics().revoked).toBe(1);
    coordinator.dispose();
  });

  it("dispose cancels everything and rejects later admissions", async () => {
    const coordinator = new CanvasResourceCoordinator();
    const run = vi.fn(async () => 1);
    const outcome = coordinator.admit({ channel: "image", key: "x", purpose: "visible", run });
    // 已启动的工作在 dispose 时被撤销：迟到结果只释放，不算合法完成。
    coordinator.dispose();
    expect((await outcome).status).toBe("cancelled");
    const later = await coordinator.admit({ channel: "image", key: "y", purpose: "visible", run });
    expect(later.status).toBe("cancelled");
    expect(run).toHaveBeenCalledTimes(1);
    expect(coordinator.idle()).toBe(true);
  });

  it("keeps a briefly offscreen node within the grace window instead of dropping it", () => {
    let clock = 0;
    const coordinator = new CanvasResourceCoordinator({ now: () => clock, policy: { offscreenGraceMs: 1500 } });
    const nodes = [{ nodeId: "a", contentKey: "k-a", x: 0, y: 0, width: 200, height: 200, eligible: true }];
    const project = (viewportX: number) => coordinator.project({
      viewport: { x: viewportX, y: 0, zoom: 1 },
      surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true, interactive: [], pins: [], candidates: nodes
    });
    project(0);
    expect(coordinator.admittedNodeIds()).toEqual(["a"]);
    // 视口移开：仍在宽限内，保持驻留（平移抖动不重复解码）。
    clock = 500;
    project(-100_000);
    expect(coordinator.isAdmitted("a")).toBe(true);
    expect(coordinator.diagnostics().revoked).toBe(0);
    // 宽限期内回到原视口：不需要重新准入，也就不重建绑定。
    const revision = coordinator.projectionRevision();
    clock = 900;
    project(0);
    expect(coordinator.isAdmitted("a")).toBe(true);
    expect(coordinator.projectionRevision()).toBe(revision);
    // 再次离开并超过宽限：真正撤销。
    clock = 1_000;
    project(-100_000);
    clock = 3_000;
    project(-100_000);
    expect(coordinator.isAdmitted("a")).toBe(false);
    coordinator.dispose();
  });

  it("never extends the grace window when the surface is gone or the page is hidden", () => {
    let clock = 0;
    const coordinator = new CanvasResourceCoordinator({ now: () => clock });
    const candidates = [{ nodeId: "a", contentKey: "k-a", x: 0, y: 0, width: 200, height: 200, eligible: true }];
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true, interactive: [], pins: [], candidates
    });
    expect(coordinator.admittedNodeIds()).toEqual(["a"]);
    // 无 surface：不是「暂时看不见」，必须立即撤销而不是按 warm 保留。
    clock = 10;
    coordinator.project({ viewport: null, surface: null, pageVisible: true, interactive: [], pins: [], candidates });
    expect(coordinator.admittedNodeIds()).toEqual([]);
    coordinator.dispose();
  });

  it("ranks the prefetch margin below visible cards instead of one flat tier", () => {
    const coordinator = new CanvasResourceCoordinator({ policy: { previewSlots: 2, prefetchMarginFactor: 1 } });
    const at = (nodeId: string, x: number) => ({
      nodeId, contentKey: `k-${nodeId}`, x, y: 0, width: 200, height: 200, eligible: true, previewSlot: true
    });
    // surface 800×600、zoom 1：视口覆盖 x∈[0,800]，余量 1 屏 ⇒ 预热覆盖 x∈[-800,1600]。
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: [at("visible-a", 0), at("visible-b", 400), at("prefetch-a", 1000)]
    });
    // 预览槽只有 2 个：两张视口内的卡片优先，预热余量里的节点让位（design D1「预热首先让位」）。
    expect(coordinator.isAdmitted("visible-a")).toBe(true);
    expect(coordinator.isAdmitted("visible-b")).toBe(true);
    expect(coordinator.isAdmitted("prefetch-a")).toBe(false);
    expect(coordinator.purposeOf("visible-a")).toBe("visible");
    // 余量内的节点确实进入了需求分类（不是被当成视口外丢弃），只是优先级更低。
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 },
      surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true,
      interactive: [],
      pins: [],
      candidates: [at("visible-a", 0), at("prefetch-a", 1000)]
    });
    expect(coordinator.purposeOf("prefetch-a")).toBe("prefetch");
    expect(coordinator.diagnostics().byPurpose.prefetch).toBe(1);
    coordinator.dispose();
  });

  it("budgets per-frame upload staging and lets interactive uploads through", () => {
    const coordinator = new CanvasResourceCoordinator({ policy: { uploadBytesPerFrame: 1000 } });
    // 普通上传受逐帧额度约束：额度用尽后本帧不再上传（留到下一帧，不是失败）。
    expect(coordinator.spendUploadBytes(600)).toBe(true);
    expect(coordinator.spendUploadBytes(600)).toBe(false);
    expect(coordinator.uploadStagingUsedBytes()).toBe(600);
    // 单次超过整帧预算的内容仍能在空额度时上传一次，避免该内容永远无法显示。
    coordinator.beginFrame();
    expect(coordinator.spendUploadBytes(4000)).toBe(true);
    expect(coordinator.spendUploadBytes(4000)).toBe(false);
    // 交互（播放/严格取帧）不受逐帧额度限制：冻结帧内忙等不能让输出饿死。
    coordinator.beginFrame();
    expect(coordinator.spendUploadBytes(900)).toBe(true);
    expect(coordinator.spendUploadBytes(900)).toBe(false);
    expect(coordinator.spendUploadBytes(900, true)).toBe(true);
    expect(coordinator.uploadStagingUsedBytes()).toBe(1800);
    // 诊断按页策略报告预算，估算与真实预算不混淆。
    expect(coordinator.diagnostics().uploadStaging).toEqual({ usedBytes: 1800, budgetBytes: 1000 });
    coordinator.dispose();
  });

  it("exposes an estimation-labelled diagnostics snapshot", () => {
    const coordinator = new CanvasResourceCoordinator();
    coordinator.project({
      viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true, interactive: [], pins: [], candidates: nodes
    });
    const snapshot = coordinator.diagnostics();
    expect(snapshot.demands).toBe(1);
    expect(snapshot.byPurpose.visible).toBe(1);
    expect(snapshot.estimatedGpuBytes).toBeGreaterThan(0);
    expect(snapshot.policy.previewSlots).toBe(DEFAULT_RESIDENCY_POLICY.previewSlots);
    coordinator.dispose();
  });
});
