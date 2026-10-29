/**
 * 镜头参考录制 dirty 集与触发边界测试
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.3 / design D9）。
 *
 * 覆盖：聚焦内只标脏、退出聚焦触发、非聚焦权威更新/缺缓存恢复/下游请求补排立即可录、重命名/
 * 布局/缩放/hover 不触发、静态/非法镜头不排、串行执行与失败可重试。
 */
import { describe, expect, it } from "vitest";
import type { BackgroundActivityJob } from "@woohaa3/contracts";
import {
  canonicalFilmSetFields,
  createFilmSetSnapshot,
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
  type ServerCanvas
} from "@woohaa3/contracts";
import { ShotReferenceActivity } from "../src/authoring/browser/shot-reference-activity.js";
import { ShotReferenceRecordingQueue } from "../src/authoring/browser/shot-reference-recording-queue.js";
import { observeFilmSets, shotReferenceJobForClip } from "../src/authoring/browser/shot-reference-observation.js";
import { ShotReferenceRecordingScheduler } from "../src/authoring/browser/shot-reference-recording-scheduler.js";

function filmSetCanvas(options: { motionScript?: string; duration?: number; extraClips?: number; canvasId?: string; mixed?: boolean } = {}): ServerCanvas {
  const snapshot = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: options.motionScript ?? `motion.model.rotate("body", { speed: 1 });`,
    timeline: { duration: options.duration ?? 4, loop: false }
  });
  const canvas = {
    id: options.canvasId ?? "c1",
    title: "画布",
    revision: 0,
    document: { nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }], edges: [] },
    nodeData: { film: canonicalFilmSetFields(snapshot) },
    assets: [],
    jobs: []
  } as unknown as ServerCanvas;
  if (options.extraClips) {
    const decoded = decodeFilmSetNodeData(canvas.nodeData.film);
    if (!decoded.ok) throw new Error(decoded.reason);
    const first = filmSetAnimationsOf(decoded.value).clips[0]!;
    const clips = [first, ...Array.from({ length: options.extraClips }, (_, index) => ({
      ...structuredClone(first), id: `clip-${index + 2}`, name: `镜头 ${index + 2}`
    }))];
    (canvas.nodeData.film as { filmSetAnimations: { clips: unknown[] } }).filmSetAnimations.clips = clips;
  }
  if (options.mixed) {
    const data = canvas.nodeData.film as unknown as { filmSetAnimations: { clips: Array<Record<string, unknown>> } };
    const first = structuredClone(data.filmSetAnimations.clips[0]!);
    data.filmSetAnimations.clips.push({ ...first, id: "static-1", kind: "static", name: "静态", timeline: { duration: 0, loop: false }, bindings: [], cameraMotion: { ...(first.cameraMotion as object), motionScript: "" } });
  }
  return canvas;
}

function renameFirstClip(canvas: ServerCanvas, name: string): ServerCanvas {
  const clone = structuredClone(canvas) as ServerCanvas;
  const animations = (clone.nodeData.film as { filmSetAnimations: { clips: Array<{ name: string }> } }).filmSetAnimations;
  animations.clips[0]!.name = name;
  return clone;
}

describe("ShotReferenceRecordingQueue（dirty 集与触发边界，任务 8.3）", () => {
  it("聚焦内只标脏、退出聚焦后才可录", () => {
    const queue = new ShotReferenceRecordingQueue();
    queue.observe("c1", [{ filmSetNodeId: "film", focused: true, clips: [{ clipId: "clip-1", contentIdentity: "id-a", profileKey: "p" }] }]);
    expect(queue.nextJob()).toBeNull(); // 聚焦内不取走
    expect(queue.snapshot().dirty).toHaveLength(1); // 但已标脏
    queue.setFocused(null);
    const drained = queue.nextJob();
    expect(drained).toMatchObject({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-a" });
  });

  it("内容未变化不重复入队；命中已记录版本直接清除", () => {
    const queue = new ShotReferenceRecordingQueue();
    const observe = () => queue.observe("c1", [{ filmSetNodeId: "film", focused: false, clips: [{ clipId: "clip-1", contentIdentity: "id-a", profileKey: "p" }] }]);
    observe();
    const job = queue.nextJob();
    expect(job).toBeDefined();
    queue.complete(job!);
    // 已 ready 的同版本：重算不再排。
    observe();
    expect(queue.snapshot().dirty).toHaveLength(0);
    expect(queue.nextJob()).toBeNull();
  });

  it("内容变化使旧 in-flight 结果失效并重新排队", () => {
    const queue = new ShotReferenceRecordingQueue();
    queue.observe("c1", [{ filmSetNodeId: "film", focused: false, clips: [{ clipId: "clip-1", contentIdentity: "id-a", profileKey: "p" }] }]);
    const job = queue.nextJob();
    expect(job).toBeDefined();
    // 录制进行中内容变为 id-b：旧 in-flight 完成后不得冒充新版本。
    queue.observe("c1", [{ filmSetNodeId: "film", focused: false, clips: [{ clipId: "clip-1", contentIdentity: "id-b", profileKey: "p" }] }]);
    queue.complete(job!); // 迟到的旧结果
    const retried = queue.nextJob();
    expect(retried).not.toBeNull();
    expect(retried!.contentIdentity).toBe("id-b");
  });

  it("下游补排幂等：同版本重复请求只排一次", () => {
    const queue = new ShotReferenceRecordingQueue();
    const job = { canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-a", profileKey: "p" };
    queue.enqueue(job);
    queue.enqueue(job);
    expect(queue.snapshot().dirty).toHaveLength(1);
    expect(queue.nextJob()).not.toBeNull();
  });

  it("失败保留 dirty 以便重试", () => {
    const queue = new ShotReferenceRecordingQueue();
    queue.observe("c1", [{ filmSetNodeId: "film", focused: false, clips: [{ clipId: "clip-1", contentIdentity: "id-a", profileKey: "p" }] }]);
    const job = queue.nextJob();
    queue.fail(job!);
    expect(queue.nextJob()).not.toBeNull();
  });

  it("非可录镜头（静态/缺失）不排任务", () => {
    const queue = new ShotReferenceRecordingQueue();
    queue.observe("c1", [{ filmSetNodeId: "film", focused: false, clips: [{ clipId: "static-1", contentIdentity: null, profileKey: "p" }] }]);
    expect(queue.snapshot().dirty).toHaveLength(0);
    expect(queue.nextJob()).toBeNull();
  });

  it("录制期间缓存回填不结算 in-flight，成功由 complete 收尾", () => {
    const queue = new ShotReferenceRecordingQueue();
    const job = { canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-a", profileKey: "p" };
    queue.observe("c1", [{ filmSetNodeId: "film", focused: false, clips: [{ clipId: "clip-1", contentIdentity: "id-a", profileKey: "p" }] }]);
    const taken = queue.nextJob()!;
    // 录制成功先发布资产 → 画布回填缓存时该 key 仍在录制中：不能当成「已不在录」。
    queue.markRecorded(job);
    expect(queue.snapshot().inflight).toHaveLength(1);
    expect(queue.snapshot().dirty).toHaveLength(0);
    queue.complete(taken);
    expect(queue.snapshot().inflight).toHaveLength(0);
  });

  it("isRecorded 只对已 ready 且不在 dirty/in-flight 的同版本为真", () => {
    const queue = new ShotReferenceRecordingQueue();
    const job = { canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: "id-a", profileKey: "p" };
    expect(queue.isRecorded(job)).toBe(false);
    queue.markRecorded(job);
    expect(queue.isRecorded(job)).toBe(true);
    // 内容变化后旧版本不再算 ready。
    expect(queue.isRecorded({ ...job, contentIdentity: "id-b" })).toBe(false);
    // 同版本再次标脏（依赖失效）后也不算 ready。
    queue.enqueue({ ...job, contentIdentity: "id-b" });
    expect(queue.isRecorded({ ...job, contentIdentity: "id-b" })).toBe(false);
  });
});

describe("observeFilmSets（内容身份驱动，任务 8.3）", () => {
  it("重命名不产生新内容身份（不触发录制）", () => {
    const before = observeFilmSets(filmSetCanvas(), null);
    const after = observeFilmSets(renameFirstClip(filmSetCanvas(), "换了名字"), null);
    expect(after[0]!.clips[0]!.contentIdentity).toBe(before[0]!.clips[0]!.contentIdentity);
  });

  it("动作变化产生新内容身份（触发录制）", () => {
    const before = observeFilmSets(filmSetCanvas({ motionScript: `motion.model.rotate("body", { speed: 1 });` }), null);
    const after = observeFilmSets(filmSetCanvas({ motionScript: `motion.model.rotate("body", { speed: 2 });` }), null);
    expect(after[0]!.clips[0]!.contentIdentity).not.toBe(before[0]!.clips[0]!.contentIdentity);
  });

  it("观察所有片场，只有传入的聚焦片场被标记为 focused", () => {
    const canvas = filmSetCanvas({ extraClips: 1 });
    const observed = observeFilmSets(canvas, "film");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.focused).toBe(true);
    expect(observed[0]!.clips).toHaveLength(2);
    expect(observeFilmSets(canvas, null)[0]!.focused).toBe(false);
  });

  it("下游补排：动态镜头返回当前版本 job，静态/缺失返回 null", () => {
    const canvas = filmSetCanvas({ mixed: true });
    const job = shotReferenceJobForClip("c1", canvas, "film", "clip-1");
    expect(job).toMatchObject({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1" });
    expect(job!.contentIdentity).toBeTruthy();
    expect(shotReferenceJobForClip("c1", canvas, "film", "missing")).toBeNull();
    expect(shotReferenceJobForClip("c1", canvas, "film", "static-1")).toBeNull();
    expect(observeFilmSets(canvas, null)[0]!.clips.find(clip => clip.clipId === "static-1")?.contentIdentity).toBeNull();
    expect(shotReferenceJobForClip("c1", null, "film", "clip-1")).toBeNull();
  });
});

describe("ShotReferenceRecordingScheduler（串行执行与触发，任务 8.3）", () => {
  function makeScheduler(options: {
    canvas: ServerCanvas | null;
    focused?: string | null;
    recorder?: ((job: import("../src/authoring/browser/shot-reference-recording-queue.js").ShotReferenceRecordingJob) => Promise<{ ok: true } | { ok: false; error: string }>) | null;
  }) {
    let canvas = options.canvas;
    let focused = options.focused ?? null;
    const scheduler = new ShotReferenceRecordingScheduler({
      canvasId: () => canvas?.id ?? "",
      canvas: () => canvas as never,
      focusedFilmSetId: () => focused,
      recorder: options.recorder === undefined ? null : options.recorder
    });
    return { scheduler, setCanvas: (next: ServerCanvas | null) => { canvas = next; }, setFocused: (next: string | null) => { focused = next; } };
  }

  it("版本缓存已就绪（刷新恢复）时同版本不再排队", () => {
    // 刷新后内存缓存归零：控制器先从画布冻结资产回填，再让调度器判断 `isCachedReady`。
    let cached = false;
    const scheduler = new ShotReferenceRecordingScheduler({
      canvasId: () => "c1",
      canvas: () => filmSetCanvas() as never,
      focusedFilmSetId: () => null,
      recorder: null,
      isCachedReady: () => cached
    });
    scheduler.reconcile();
    const [job] = scheduler.snapshot().dirty;
    expect(job).toBeDefined();
    cached = true;
    scheduler.reconcile();
    expect(scheduler.snapshot().dirty).toHaveLength(0);
    expect(scheduler.isRecorded(job!)).toBe(true);
  });

  it("recorder 为 null 时只标脏、不空转", async () => {
    const { scheduler } = makeScheduler({ canvas: filmSetCanvas() });
    scheduler.reconcile();
    expect(scheduler.snapshot().dirty).toHaveLength(1);
    expect(scheduler.snapshot().busy).toBe(false);
  });

  it("非聚焦权威更新立即可录（缺缓存恢复）", async () => {
    const recorded: string[] = [];
    const { scheduler } = makeScheduler({ canvas: filmSetCanvas(), recorder: async (job) => { recorded.push(job.clipId); return { ok: true }; } });
    scheduler.reconcile();
    await Promise.resolve();
    expect(recorded).toEqual(["clip-1"]);
    expect(scheduler.snapshot().dirty).toHaveLength(0);
  });

  it("聚焦内不录，退出聚焦后触发一次", async () => {
    const recorded: string[] = [];
    const { scheduler, setFocused } = makeScheduler({ canvas: filmSetCanvas(), focused: "film", recorder: async (job) => { recorded.push(job.clipId); return { ok: true }; } });
    scheduler.reconcile();
    await Promise.resolve();
    expect(recorded).toEqual([]);
    expect(scheduler.snapshot().dirty).toHaveLength(1);
    setFocused(null);
    scheduler.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    expect(recorded).toEqual(["clip-1"]);
    expect(scheduler.snapshot().dirty).toHaveLength(0);
  });

  it("录制失败保留 dirty 并在下次 reconcile 重试", async () => {
    let attempt = 0;
    const { scheduler } = makeScheduler({ canvas: filmSetCanvas(), recorder: async () => { attempt += 1; return attempt === 1 ? { ok: false, error: "编码失败" } : { ok: true }; } });
    scheduler.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.snapshot().lastError).toBe("编码失败");
    expect(scheduler.snapshot().dirty).toHaveLength(1);
    scheduler.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.snapshot().dirty).toHaveLength(0);
    expect(scheduler.snapshot().lastError).toBeNull();
  });

  it("下游请求补排动态镜头可录、静态镜头不排", async () => {
    const recorded: string[] = [];
    const { scheduler } = makeScheduler({ canvas: filmSetCanvas({ mixed: true }), recorder: async (job) => { recorded.push(job.clipId); return { ok: true }; } });
    scheduler.requestRecord("film", "clip-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(recorded).toEqual(["clip-1"]);
    scheduler.requestRecord("film", "static-1");
    await Promise.resolve();
    expect(recorded).toEqual(["clip-1"]);
  });

  it("mixed fixture exits focus without static jobs; converting the active dynamic aborts and drops late success", async () => {
    let canvas = filmSetCanvas({ mixed: true });
    let focused: string | null = "film", signal: AbortSignal | undefined;
    let finish!: (result: { ok: true }) => void;
    const recorded: string[] = [];
    const scheduler = new ShotReferenceRecordingScheduler({ canvasId: () => "c1", canvas: () => canvas,
      focusedFilmSetId: () => focused, recorder: (job, abort) => { recorded.push(job.clipId); signal = abort; return new Promise(resolve => { finish = resolve; }); } });
    scheduler.reconcile(); expect(recorded).toEqual([]);
    expect(scheduler.snapshot().dirty.map(job => job.clipId)).toEqual(["clip-1"]);
    focused = null; scheduler.reconcile(); expect(recorded).toEqual(["clip-1"]);
    const original = scheduler.snapshot().dirty[0]!;
    canvas = structuredClone(canvas);
    const collection = (canvas.nodeData.film as unknown as { filmSetAnimations: { clips: Array<Record<string, unknown>> } }).filmSetAnimations;
    const still = collection.clips.find(clip => clip.id === "static-1")!;
    collection.clips[0] = { ...structuredClone(still), id: "clip-1" };
    scheduler.reconcile(); expect(signal?.aborted).toBe(true);
    finish({ ok: true }); await Promise.resolve(); await Promise.resolve();
    expect(scheduler.isRecorded(original)).toBe(false);
    expect(scheduler.snapshot().dirty).toEqual([]);
    scheduler.requestRecord("film", "static-1"); expect(recorded).toEqual(["clip-1"]);
    scheduler.dispose();
  });

  it("录制中发布资产回填缓存：活动投影结算为成功，不投影成取消", async () => {
    const canvas = filmSetCanvas();
    const emitted: BackgroundActivityJob[] = [];
    const activity = new ShotReferenceActivity(
      { titleOf: () => "片场 · 镜头 1", emit: (record) => emitted.push(record) }
    );
    let cached = false;
    let scheduler!: ShotReferenceRecordingScheduler;
    scheduler = new ShotReferenceRecordingScheduler({
      canvasId: () => "c1",
      canvas: () => canvas as never,
      focusedFilmSetId: () => null,
      // 录制结束前先发布资产：控制器 reconcile 会回填缓存，把 job 移出 dirty 集。
      isCachedReady: () => cached,
      recorder: async (job) => {
        activity.start(job);
        cached = true;
        scheduler.reconcile();
        const result = { ok: true as const };
        activity.finish(job, result);
        return result;
      },
      onStateChange: () => {
        const snapshot = scheduler.snapshot();
        activity.syncQueued(snapshot.dirty, snapshot.inflight);
      }
    });
    scheduler.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    expect(emitted.some((record) => record.status === "cancelled")).toBe(false);
    expect(activity.records().map((record) => record.status)).toEqual(["succeeded"]);
  });

  it("无画布时不排任何任务", async () => {
    const recorded: string[] = [];
    const { scheduler } = makeScheduler({ canvas: null, recorder: async (job) => { recorded.push(job.clipId); return { ok: true }; } });
    scheduler.reconcile();
    await Promise.resolve();
    expect(recorded).toEqual([]);
    expect(scheduler.snapshot().dirty).toHaveLength(0);
  });
});

describe("ShotReferenceRecordingScheduler 失败后的有界自动重试", () => {
  /**
   * 进入画布时渲染器/媒体常常还没就绪，第一次录制必然失败；没有自动重试时旧画布会永远
   * 缺录制数据（2026-10-17 缺陷修复）。这里用注入的假计时器验证退避、上限与归零。
   */
  function makeRetryScheduler(recorder: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    const timers: { run: () => void; delayMs: number; canceled: boolean }[] = [];
    const scheduler = new ShotReferenceRecordingScheduler({
      canvasId: () => "c1",
      canvas: () => filmSetCanvas() as never,
      focusedFilmSetId: () => null,
      recorder,
      scheduleRetry: (run, delayMs) => {
        const timer = { run, delayMs, canceled: false };
        timers.push(timer);
        return timer;
      },
      cancelRetry: (handle) => { (handle as { canceled: boolean }).canceled = true; }
    });
    return { scheduler, timers };
  }

  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  it("失败后按指数退避排重试，成功后停止并归零", async () => {
    let attempt = 0;
    const recording = makeRetryScheduler(async () => {
      attempt += 1;
      return attempt === 1 ? { ok: false, error: "画布渲染器未就绪，请稍后重试" } : { ok: true };
    });
    recording.scheduler.reconcile();
    await settle();
    expect(recording.timers.map((timer) => timer.delayMs)).toEqual([2000]);
    expect(recording.scheduler.snapshot().retryAttempt).toBe(1);

    recording.timers[0]!.run();
    await settle();
    expect(attempt).toBe(2);
    expect(recording.scheduler.snapshot().dirty).toHaveLength(0);
    expect(recording.scheduler.snapshot().retryAttempt).toBe(0);
    expect(recording.timers).toHaveLength(1);
  });

  it("连续失败按 2s→4s→8s… 退避，达到上限后不再排", async () => {
    const recording = makeRetryScheduler(async () => ({ ok: false, error: "镜头捕捉失败或超时" }));
    recording.scheduler.reconcile();
    await settle();
    for (let index = 0; index < 5; index++) {
      const timer = recording.timers[index];
      expect(timer).toBeDefined();
      timer!.run();
      await settle();
    }
    expect(recording.timers.map((timer) => timer.delayMs)).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(recording.scheduler.snapshot().retryAttempt).toBe(5);
    // 上限用尽：仍有 dirty 但不再排新重试。
    expect(recording.scheduler.snapshot().dirty).toHaveLength(1);
    expect(recording.timers).toHaveLength(5);
  });

  it("外部 reconcile 取消待触发重试并归零预算", async () => {
    const recording = makeRetryScheduler(async () => ({ ok: false, error: "画布渲染器未就绪，请稍后重试" }));
    recording.scheduler.reconcile();
    await settle();
    expect(recording.timers).toHaveLength(1);
    recording.scheduler.reconcile();
    await settle();
    expect(recording.timers[0]!.canceled).toBe(true);
    expect(recording.scheduler.snapshot().retryAttempt).toBe(1);
  });

  it("聚焦片场只标脏时不排重试", async () => {
    const timers: number[] = [];
    const scheduler = new ShotReferenceRecordingScheduler({
      canvasId: () => "c1",
      canvas: () => filmSetCanvas() as never,
      focusedFilmSetId: () => "film",
      recorder: async () => ({ ok: true }),
      scheduleRetry: (_run, delayMs) => { timers.push(delayMs); return delayMs; }
    });
    scheduler.reconcile();
    await settle();
    expect(scheduler.snapshot().dirty).toHaveLength(1);
    expect(timers).toEqual([]);
  });

  it("dispose 取消待触发重试", async () => {
    const recording = makeRetryScheduler(async () => ({ ok: false, error: "画布渲染器未就绪，请稍后重试" }));
    recording.scheduler.reconcile();
    await settle();
    recording.scheduler.dispose();
    expect(recording.timers[0]!.canceled).toBe(true);
  });
});
