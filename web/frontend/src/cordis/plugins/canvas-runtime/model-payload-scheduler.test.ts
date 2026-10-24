/**
 * 有界模型 payload 准备调度
 * （change: 2026-10-23-scale-canvas-media-residency，design D3 / 任务 6.1）。
 *
 * 这些用例锁定「预算按帧结算」与「失败只隔离该内容」两条硬约束，与 `bevy-runtime` 的集成
 * 用例互补：这里不经过 WASM 边界，只验证调度本身。
 */
import { describe, expect, it } from "vitest";
import { ModelPayloadScheduler } from "./model-payload-scheduler.js";

function scheduler(overrides: Partial<ConstructorParameters<typeof ModelPayloadScheduler>[0]> = {}) {
  const prepared: string[] = [];
  const failed: Array<{ key: string; error: unknown }> = [];
  let clock = 0;
  const resident = new Set<string>();
  const content = new Set<string>();
  const instance = new ModelPayloadScheduler({
    now: () => clock,
    concurrency: 2,
    budgetMs: 100,
    isResident: (key) => resident.has(key),
    hasContent: (key) => content.has(key),
    wanted: () => null,
    prepare: (key) => { prepared.push(key); resident.add(key); },
    onFailed: (key, error) => { failed.push({ key, error }); },
    ...overrides
  });
  return {
    instance,
    prepared,
    failed,
    content,
    resident,
    advance: (ms: number) => { clock += ms; }
  };
}

describe("ModelPayloadScheduler", () => {
  it("每帧最多推进 concurrency 项，其余留到后续帧", () => {
    const h = scheduler({ concurrency: 2 });
    for (const key of ["a", "b", "c", "d"]) { h.content.add(key); h.instance.enqueue(key); }
    h.instance.beginFrame();
    expect(h.instance.drain()).toBe(2);
    expect(h.prepared).toEqual(["a", "b"]);
    // 同一帧再次 drain 不会突破并发上限（预算按帧累计，不按调用次数重置）。
    expect(h.instance.drain()).toBe(0);
    h.instance.beginFrame();
    expect(h.instance.drain()).toBe(2);
    expect(h.prepared).toEqual(["a", "b", "c", "d"]);
    expect(h.instance.pendingCount()).toBe(0);
  });

  it("累计耗时超过片段预算后停到下一帧，但单项超预算仍会各帧推进一项", () => {
    // 每次准备耗掉 20ms（远超 6ms 片段预算）：本帧做完一项就停到下一帧，不会被预算永久阻塞。
    const h = scheduler({ concurrency: 32, budgetMs: 6, prepare: (key) => { h.prepared.push(key); h.advance(20); } });
    for (const key of ["slow-1", "slow-2", "slow-3"]) { h.content.add(key); h.instance.enqueue(key); }
    h.instance.beginFrame();
    expect(h.instance.drain()).toBe(1);
    h.instance.beginFrame();
    expect(h.instance.drain()).toBe(1);
    h.instance.beginFrame();
    expect(h.instance.drain()).toBe(1);
    expect(h.prepared).toHaveLength(3);
  });

  it("单项失败只回调该内容，不中断队列里的其它模型", () => {
    const h = scheduler({
      concurrency: 4,
      prepare: (key) => {
        if (key === "bad") throw new Error("payload too large");
        h.resident.add(key);
      }
    });
    for (const key of ["good-1", "bad", "good-2"]) { h.content.add(key); h.instance.enqueue(key); }
    h.instance.beginFrame();
    expect(h.instance.drain()).toBe(3);
    // 失败项不算驻留：重新取得需求时可以再次准备（显式重试语义）。
    expect(h.instance.pendingCount()).toBe(0);
    expect(h.failed).toHaveLength(1);
    expect(h.failed[0].key).toBe("bad");
  });

  it("已驻留或无内容的内容身份不入队，重复入队幂等", () => {
    const h = scheduler();
    h.content.add("a");
    h.instance.enqueue("a");
    h.instance.enqueue("a");
    expect(h.instance.pendingCount()).toBe(1);
    // 无内容（例如 provider 尚未派生）不入队，避免堆积永远无法执行的项。
    h.instance.enqueue("missing");
    expect(h.instance.pendingCount()).toBe(1);
    h.resident.add("resident");
    h.instance.enqueue("resident");
    expect(h.instance.pendingCount()).toBe(1);
  });

  it("投影后放弃已不在需求内的待办，避免离屏内容返回时补做重活", () => {
    const wanted = new Set(["a"]);
    const h = scheduler({ wanted: () => wanted, concurrency: 1 });
    for (const key of ["a", "b", "c"]) { h.content.add(key); h.instance.enqueue(key); }
    expect(h.instance.pendingCount()).toBe(3);
    h.instance.beginFrame();
    h.instance.drain();
    expect(h.prepared).toEqual(["a"]);
    // 本帧未推进的离屏项被直接放弃（不是留到下一帧再补做）。
    expect(h.instance.pendingCount()).toBe(0);
  });

  it("注入预算只收紧不放宽，非法值被忽略", () => {
    const h = scheduler({ concurrency: 2, budgetMs: 6 });
    h.instance.configure({ concurrency: Number.POSITIVE_INFINITY, budgetMs: Number.NaN });
    expect(h.instance.budget()).toEqual({ concurrency: 2, budgetMs: 6 });
    h.instance.configure({ concurrency: 1000, budgetMs: 99999 });
    // 硬上界：注入值不能把一帧变成无界装配。
    expect(h.instance.budget()).toEqual({ concurrency: 32, budgetMs: 1000 });
    h.instance.configure({ concurrency: 0, budgetMs: -5 });
    expect(h.instance.budget()).toEqual({ concurrency: 1, budgetMs: 1 });
  });
});
