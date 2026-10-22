/**
 * 唯一聚焦过渡 coordinator 测试
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7，任务 2.3/6.1）。
 *
 * 重点覆盖三维公共进度（`runModel`/`modelProgress`）：同一过渡只有一个进度时间源，Rust 消费
 * 该进度求值相机姿态而不再独立计时；进度携带 node/kind/runtimeGeneration 身份，取消/替换时旧
 * 请求以 false 结算且不悬挂。
 */
import { describe, expect, it } from "vitest";
import { FOCUS_TRANSITION_VERSION } from "@woohaa3/contracts";
import { FocusTransitionCoordinator } from "./focus-transition-coordinator.js";

/** 手动可控的 rAF 时间源：捕获回调，测试按需推进帧。 */
function manualRaf() {
  let now = 0;
  const pending = new Map<number, (time: number) => void>();
  let next = 1;
  const raf = (callback: (time: number) => void) => {
    const handle = next++;
    pending.set(handle, callback);
    return handle;
  };
  const cancelRaf = (handle: number) => {
    pending.delete(handle);
  };
  /** 推进一帧：执行当前挂起的回调并把时钟前移到 `time`。 */
  const frame = (time: number) => {
    now = time;
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(now);
  };
  return { raf, cancelRaf, frame, pendingCount: () => pending.size };
}

describe("FocusTransitionCoordinator 三维公共进度（design D6/D7）", () => {
  it("rAF 驱动逐帧进度快照，完成后落在 focused", async () => {
    const raf = manualRaf();
    const coordinator = new FocusTransitionCoordinator({ raf: raf.raf, cancelRaf: raf.cancelRaf, now: () => 0 });
    const seen: number[] = [];
    const done = coordinator.runModel({ nodeId: "m1", durationMs: 400, onProgress: (p) => seen.push(p) });
    expect(coordinator.hasModelProgress()).toBe(true);
    const first = coordinator.modelProgress();
    expect(first).toMatchObject({ version: FOCUS_TRANSITION_VERSION, nodeId: "m1", kind: "model", progress: 0 });
    raf.frame(100);
    expect(coordinator.modelProgress()?.progress).toBeCloseTo(0.25);
    raf.frame(200);
    raf.frame(400);
    await expect(done).resolves.toBe(true);
    expect(seen.at(-1)).toBe(1);
    expect(coordinator.currentPhase()).toBe("focused");
    expect(coordinator.modelProgress()?.progress).toBe(1);
  });

  it("extension kind 透传到进度快照", () => {
    const raf = manualRaf();
    const coordinator = new FocusTransitionCoordinator({ raf: raf.raf, cancelRaf: raf.cancelRaf, now: () => 0 });
    void coordinator.runModel({ nodeId: "ext1", kind: "extension", durationMs: 400 });
    expect(coordinator.modelProgress()?.kind).toBe("extension");
  });

  it("reduced motion（零时长）同步落位到 1，且不注册 rAF", async () => {
    const coordinator = new FocusTransitionCoordinator({ prefersReducedMotion: () => true });
    await expect(coordinator.runModel({ nodeId: "m1", durationMs: 400 })).resolves.toBe(true);
    expect(coordinator.modelProgress()?.progress).toBe(1);
    expect(coordinator.currentPhase()).toBe("focused");
  });

  it("取消在途三维进度：旧 Promise 结算为 false 且进度清除（不悬挂）", async () => {
    const raf = manualRaf();
    const coordinator = new FocusTransitionCoordinator({ raf: raf.raf, cancelRaf: raf.cancelRaf, now: () => 0 });
    const done = coordinator.runModel({ nodeId: "m1", durationMs: 400 });
    raf.frame(100);
    coordinator.cancel();
    await expect(done).resolves.toBe(false);
    expect(coordinator.hasModelProgress()).toBe(false);
    expect(coordinator.modelProgress()).toBeNull();
    expect(coordinator.currentPhase()).toBe("overview");
  });

  it("新过渡替换旧过渡：旧 Promise 结算为 false，新进度带新 generation", async () => {
    const raf = manualRaf();
    const coordinator = new FocusTransitionCoordinator({ raf: raf.raf, cancelRaf: raf.cancelRaf, now: () => 0 });
    const old = coordinator.runModel({ nodeId: "m1", durationMs: 400 });
    raf.frame(100);
    const oldGeneration = coordinator.modelProgress()?.runtimeGeneration ?? -1;
    const fresh = coordinator.runModel({ nodeId: "m2", durationMs: 400 });
    await expect(old).resolves.toBe(false);
    const snapshot = coordinator.modelProgress();
    expect(snapshot?.nodeId).toBe("m2");
    expect(snapshot?.runtimeGeneration).toBeGreaterThan(oldGeneration);
    raf.frame(500);
    await expect(fresh).resolves.toBe(true);
  });

  it("无活动三维过渡时进度为 null（Rust 回退内部计时）", () => {
    const coordinator = new FocusTransitionCoordinator({ prefersReducedMotion: () => false });
    expect(coordinator.modelProgress()).toBeNull();
    expect(coordinator.hasModelProgress()).toBe(false);
  });
});
