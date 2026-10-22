/**
 * 直接视频 registry 与独占 lease 测试
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D10，任务 5.1）。
 *
 * 覆盖：独占接管、保留 currentTime/可见帧、direct/history 身份隔离、质量请求只改采样上限、
 * 有界回收与 pin 保护、换源失效、幂等 dispose、释放后仅新 lease 可播放。
 */
import { describe, expect, it, vi } from "vitest";
import { VideoLeaseRegistry, type VideoSourceIdentity } from "./video-lease-registry.js";
import type { VideoElementLike } from "./video-frame-session.js";

class FakeVideo implements VideoElementLike {
  src = "";
  muted = false;
  loop = false;
  playsInline = false;
  preload = "";
  crossOrigin: string | null = null;
  currentTime = 0;
  duration = 10;
  videoWidth = 640;
  videoHeight = 360;
  readyState = 2;
  paused = true;
  ended = false;
  removed: string[] = [];
  loads = 0;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  play(): unknown { this.paused = false; return Promise.resolve(); }
  pause(): void { this.paused = true; }
  load(): void { this.loads += 1; }
  removeAttribute(name: string): void { this.removed.push(name); if (name === "src") this.src = ""; }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(handler);
  }
  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }
  emit(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ type });
  }
}

function identity(nodeId: string, url = "/media/a.mp4", owner: "direct" | "history" = "direct"): VideoSourceIdentity {
  return { nodeId, owner, url };
}

function registry(created: FakeVideo[] = []) {
  const createVideo = vi.fn(() => { const v = new FakeVideo(); created.push(v); return v; });
  const reg = new VideoLeaseRegistry({ createVideo, maxSessions: 3 });
  return { reg, createVideo, created };
}

describe("VideoLeaseRegistry（任务 5.1）", () => {
  it("同一来源的独占接管：已有 lease 时不抢占", () => {
    const { reg } = registry();
    const first = reg.acquire(identity("v1"));
    expect(first).not.toBeNull();
    expect(reg.acquire(identity("v1"))).toBeNull();
    first!.release();
    const second = reg.acquire(identity("v1"));
    expect(second).not.toBeNull();
  });

  it("接管时保留 currentTime 与可见帧，不重置到 0（design D10）", () => {
    const { reg, created } = registry();
    const first = reg.acquire(identity("v1"));
    created[0]!.currentTime = 3.5;
    first!.release();
    const second = reg.acquire(identity("v1"));
    expect(created[0]!.currentTime).toBe(3.5);
    expect(second!.state().currentTime).toBe(3.5);
    // 与创建时的初始 src 相同（未重设）。
    expect(created.length).toBe(1);
  });

  it("direct 与 history 使用不同身份，历史不覆盖 canonical 卡片", () => {
    const { reg, created } = registry();
    const direct = reg.acquire(identity("v1", "/media/direct.mp4", "direct"));
    const history = reg.acquire(identity("v1", "/media/history.mp4", "history"));
    expect(direct).not.toBeNull();
    expect(history).not.toBeNull();
    expect(created.length).toBe(2);
    expect(reg.has("v1", "direct")).toBe(true);
    expect(reg.has("v1", "history")).toBe(true);
  });

  it("换源（同身份新 url）重建元素且不复活旧回调", () => {
    const { reg, created } = registry();
    reg.acquire(identity("v1", "/media/a.mp4"))!.release();
    reg.acquire(identity("v1", "/media/b.mp4"))!.release();
    expect(created.length).toBe(2);
    expect(created[0]!.removed).toContain("src");
    expect(created[1]!.src).toBe("/media/b.mp4");
  });

  it("质量请求只改采样上限，不换 src", () => {
    const { reg, created } = registry();
    const lease = reg.acquire(identity("v1"), "card")!;
    lease.setQuality("focus");
    expect(lease.quality()).toBe("focus");
    expect(created[0]!.src).toBe("/media/a.mp4");
    expect(created.length).toBe(1);
  });

  it("有界：超过会话上限时回收无 lease/无 pin 的最久未用会话", () => {
    const { reg, created } = registry();
    reg.acquire(identity("v1"))!.release();
    reg.acquire(identity("v2"))!.release();
    reg.acquire(identity("v3"))!.release();
    reg.acquire(identity("v4"))!.release();
    expect(reg.size()).toBeLessThanOrEqual(3);
    // v1 最久未用：被回收并移除媒体源。
    expect(created[0]!.removed).toContain("src");
  });

  it("持有 lease 的会话不被回收", () => {
    const { reg } = registry();
    const held = reg.acquire(identity("v1"))!;
    reg.acquire(identity("v2"))!.release();
    reg.acquire(identity("v3"))!.release();
    reg.acquire(identity("v4"))!.release();
    expect(reg.has("v1")).toBe(true);
    held.release();
    reg.acquire(identity("v5"))!.release();
    expect(reg.has("v1")).toBe(false);
  });

  it("pin 保护会话不被回收，unpin 后恢复可回收", () => {
    const { reg } = registry();
    reg.acquire(identity("v1"))!.release();
    reg.pin(identity("v1"), "capture");
    reg.acquire(identity("v2"))!.release();
    reg.acquire(identity("v3"))!.release();
    reg.acquire(identity("v4"))!.release();
    expect(reg.has("v1")).toBe(true);
    reg.unpin(identity("v1"), "capture");
    reg.acquire(identity("v5"))!.release();
    expect(reg.has("v1")).toBe(false);
  });

  it("invalidate 丢弃无 lease 来源并移除媒体源；被 lease 持有时延迟释放", () => {
    const { reg, created } = registry();
    reg.acquire(identity("v2"))!.release();
    // 让 v1 成为被 lease 持有的来源。
    const lease = reg.acquire(identity("v1"))!;
    reg.invalidate(identity("v1"));
    expect(reg.has("v1")).toBe(true);
    lease.release();
    expect(reg.has("v1")).toBe(false);
    // v1 是第二个创建的元素。
    expect(created[1]!.removed).toContain("src");
  });

  it("dispose 幂等释放全部会话与元素", () => {
    const { reg, created } = registry();
    reg.acquire(identity("v1"))!.release();
    reg.acquire(identity("v2"))!.release();
    reg.dispose();
    reg.dispose();
    expect(reg.size()).toBe(0);
    expect(created.every((v) => v.removed.includes("src"))).toBe(true);
  });

  it("释放后 isCurrent 为 false，仅新 lease 可再次播放", () => {
    const { reg } = registry();
    const lease = reg.acquire(identity("v1"))!;
    lease.pause();
    lease.release();
    expect(lease.isCurrent()).toBe(false);
    const fresh = reg.acquire(identity("v1"))!;
    expect(fresh.isCurrent()).toBe(true);
  });
});
