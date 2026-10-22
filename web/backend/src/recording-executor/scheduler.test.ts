/**
 * 参考录制的 dirty/focus/优先级调度（任务 5.2 / 5.3）。
 *
 * 覆盖：多窗口 focus 只标脏、最后一个 focus 退出才补排、内容版本去重、退避与次数上限、
 * 交互让路及过期恢复、显式导出优先、显式队列幂等。
 */
import { describe, expect, it } from "vitest";
import {
  ExplicitRecordingQueue,
  ReferenceRecordingScheduler,
  referenceClaimKey,
  type ReferenceSourceKey
} from "./scheduler.js";

function key(overrides: Partial<ReferenceSourceKey> = {}): ReferenceSourceKey {
  return {
    canvasId: "c1",
    filmSetNodeId: "film",
    clipId: "clip",
    contentIdentity: "content-1",
    profileKey: "native-v1",
    ...overrides
  };
}

function scheduler(options: Partial<ConstructorParameters<typeof ReferenceRecordingScheduler>[0]> = {}, clock = { now: 1_000 }) {
  return new ReferenceRecordingScheduler({ now: () => clock.now, ...options });
}

describe("ReferenceRecordingScheduler", () => {
  it("builds one stable claim key per content version", () => {
    expect(referenceClaimKey(key())).toBe(
      "reference:c1:film:clip:content-1:native-v1"
    );
    expect(referenceClaimKey(key({ contentIdentity: "content-2" }))).not.toBe(referenceClaimKey(key()));
  });

  it("does not schedule while any window still holds focus", () => {
    const clock = { now: 1_000 };
    const reference = scheduler({ focusLeaseMs: 10_000 }, clock);
    reference.acquireFocus({ canvasId: "c1", filmSetNodeId: "film", holder: "window-a" });
    reference.markDirty(key());
    expect(reference.next()).toBeNull();

    // 第二个窗口也进入 focus：仍然只标脏。
    reference.acquireFocus({ canvasId: "c1", filmSetNodeId: "film", holder: "window-b" });
    expect(reference.next()).toBeNull();

    // 一个窗口退出：仍有另一个 → 不排。
    reference.releaseFocus({ canvasId: "c1", filmSetNodeId: "film", holder: "window-a" });
    expect(reference.next()).toBeNull();

    // 最后一个退出 → 才排。
    reference.releaseFocus({ canvasId: "c1", filmSetNodeId: "film", holder: "window-b" });
    expect(reference.next()?.claimKey).toBe(referenceClaimKey(key()));
  });

  it("resumes after the focus lease expires instead of waiting forever", () => {
    const clock = { now: 1_000 };
    const reference = scheduler({ focusLeaseMs: 2_000 }, clock);
    reference.acquireFocus({ canvasId: "c1", filmSetNodeId: "film", holder: "window-a" });
    reference.markDirty(key());
    expect(reference.next()).toBeNull();
    clock.now += 2_001;
    expect(reference.hasActiveFocus("c1", "film")).toBe(false);
    expect(reference.next()).not.toBeNull();
  });

  it("deduplicates the same missing version across windows", () => {
    const reference = scheduler();
    reference.markDirty(key());
    reference.markDirty(key());
    const first = reference.next();
    expect(first).not.toBeNull();
    // 已有一个活动 claim：不会并行产生第二个。
    expect(reference.next()).toBeNull();
    expect(reference.size()).toBe(1);
  });

  it("keeps different content versions as separate claims", () => {
    const reference = scheduler();
    reference.markDirty(key({ contentIdentity: "v1" }));
    reference.markDirty(key({ contentIdentity: "v2" }));
    const first = reference.next();
    expect(first).not.toBeNull();
    reference.complete(first!.claimKey, { ok: true });
    const second = reference.next();
    expect(second).not.toBeNull();
    expect(second!.key.contentIdentity).not.toBe(first!.key.contentIdentity);
  });

  it("backs off transient failures and gives up after the attempt budget", () => {
    const clock = { now: 0 };
    const reference = scheduler(
      { retryBaseMs: 2_000, retryMaxMs: 30_000, maxAttempts: 3 },
      clock
    );
    reference.markDirty(key());

    const first = reference.next()!;
    reference.complete(first.claimKey, { ok: false, code: "frame-ready", message: "x", transient: true });
    expect(reference.stateOf(key())).toBe("dirty");
    // 退避未到点：不排。
    clock.now = 1_999;
    expect(reference.next()).toBeNull();
    clock.now = 2_000;
    const second = reference.next()!;
    expect(second.attempt).toBe(2);

    reference.complete(second.claimKey, { ok: false, code: "frame-ready", message: "x", transient: true });
    clock.now += 4_000;
    const third = reference.next()!;
    expect(third.attempt).toBe(3);
    reference.complete(third.claimKey, { ok: false, code: "frame-ready", message: "x", transient: true });
    // 达到预算：永久失败，不再自动重试。
    expect(reference.stateOf(key())).toBe("failed");
    clock.now += 1_000_000;
    expect(reference.next()).toBeNull();
    expect(reference.errorOf(key())?.code).toBe("frame-ready");
  });

  it("does not retry permanent failures", () => {
    const reference = scheduler();
    reference.markDirty(key());
    const job = reference.next()!;
    reference.complete(job.claimKey, {
      ok: false,
      code: "recording-source-invalid",
      message: "script",
      transient: false
    });
    expect(reference.stateOf(key())).toBe("failed");
    expect(reference.next()).toBeNull();
  });

  it("yields to interaction and resumes after the interaction lease", () => {
    const clock = { now: 0 };
    const reference = scheduler({ interactionLeaseMs: 1_000 }, clock);
    reference.markDirty(key());
    reference.noteInteraction();
    expect(reference.shouldYield()).toBe(true);
    expect(reference.next()).toBeNull();
    clock.now = 1_001;
    expect(reference.shouldYield()).toBe(false);
    expect(reference.next()).not.toBeNull();
  });

  it("yields to explicit exports", () => {
    const reference = scheduler();
    reference.markDirty(key());
    reference.setExplicitActive(true);
    expect(reference.next()).toBeNull();
    reference.setExplicitActive(false);
    expect(reference.next()).not.toBeNull();
  });

  it("marks ready only for the completed version and forgets removed sources", () => {
    const reference = scheduler();
    reference.markDirty(key());
    const job = reference.next()!;
    reference.complete(job.claimKey, { ok: true });
    expect(reference.stateOf(key())).toBe("ready");
    // 新版本仍需单独录制。
    reference.markDirty(key({ contentIdentity: "new" }));
    expect(reference.stateOf(key({ contentIdentity: "new" }))).toBe("dirty");

    reference.forget(key());
    expect(reference.stateOf(key())).toBe("unknown");
  });

  it("renewal only works for the holder and keeps focus alive", () => {
    const clock = { now: 0 };
    const reference = scheduler({ focusLeaseMs: 1_000 }, clock);
    reference.acquireFocus({ canvasId: "c1", filmSetNodeId: "film", holder: "a" });
    expect(reference.renewFocus({ canvasId: "c1", filmSetNodeId: "film", holder: "b" })).toBe(false);
    clock.now = 900;
    expect(reference.renewFocus({ canvasId: "c1", filmSetNodeId: "film", holder: "a" })).toBe(true);
    clock.now = 1_500;
    expect(reference.hasActiveFocus("c1", "film")).toBe(true);
  });

  it("clears the active claim when the job is forgotten", () => {
    const reference = scheduler();
    reference.markDirty(key());
    expect(reference.next()).not.toBeNull();
    reference.forget(key());
    reference.markDirty(key());
    expect(reference.next()).not.toBeNull();
  });
});

describe("ExplicitRecordingQueue", () => {
  it("is idempotent per requestId and runs one at a time", () => {
    const queue = new ExplicitRecordingQueue();
    expect(queue.enqueue("r1")).toBe(true);
    expect(queue.enqueue("r1")).toBe(false);
    expect(queue.enqueue("r2")).toBe(true);
    expect(queue.next()).toBe("r1");
    expect(queue.next()).toBeNull();
    queue.finish("r1");
    expect(queue.next()).toBe("r2");
    queue.finish("r2");
    expect(queue.next()).toBeNull();
  });

  it("never merges two intentional exports", () => {
    const queue = new ExplicitRecordingQueue();
    queue.enqueue("r1");
    queue.enqueue("r2");
    expect(queue.pendingCount()).toBe(2);
  });

  it("cancels only queued requests", () => {
    const queue = new ExplicitRecordingQueue();
    queue.enqueue("r1");
    queue.enqueue("r2");
    expect(queue.next()).toBe("r1");
    expect(queue.cancel("r1")).toBe(false);
    expect(queue.cancel("r2")).toBe(true);
    expect(queue.activeRequest()).toBe("r1");
    queue.finish("r1");
    expect(queue.next()).toBeNull();
  });
});
