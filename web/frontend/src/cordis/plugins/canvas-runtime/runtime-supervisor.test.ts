import { afterEach, expect, it, vi } from "vitest";
import { RuntimeSupervisor, readRuntimeHealth } from "./runtime-supervisor.js";
import { RuntimeIssues } from "./runtime-issues.js";

afterEach(() => vi.useRealTimers());
function fixture(recover = vi.fn(async () => {})) {
  vi.useFakeTimers();
  let time = 0;
  const issues = new RuntimeIssues();
  const invalidate = vi.fn();
  const supervisor = new RuntimeSupervisor({ issues, recover, invalidate, now: () => time, timeout: 100 });
  return { supervisor, issues, recover, invalidate, time: (value: number) => { time = value; } };
}

it("静止场景不触发 watchdog；后台计时重置；待处理渲染停滞才恢复", async () => {
  const f = fixture();
  f.time(1000); f.supervisor.sample({ updates: 0, renders: 0, appliedRevision: 0 }, true);
  expect(f.recover).not.toHaveBeenCalled();
  f.supervisor.accepted(2);
  f.time(5000); f.supervisor.sample({ updates: 1, renders: 0, appliedRevision: 2 }, false);
  f.time(5050); f.supervisor.sample({ updates: 1, renders: 0, appliedRevision: 2 }, true);
  expect(f.supervisor.phase).toBe("running");
  f.time(5200); f.supervisor.sample({ updates: 1, renders: 0, appliedRevision: 2 }, true);
  expect(f.supervisor.phase).toBe("recovering");
  await vi.runAllTimersAsync();
  expect(f.recover).toHaveBeenCalledTimes(1);
  expect(f.invalidate).toHaveBeenCalledTimes(1);
  expect(f.issues.getSnapshot()).toEqual([]);
  f.supervisor.dispose();
});

it("应用 revision 不能冒充渲染进度；渲染完成后清除待处理工作", () => {
  const f = fixture();
  f.supervisor.accepted(5);
  f.supervisor.sample({ updates: 1, renders: 0, appliedRevision: 5 }, true);
  expect(f.supervisor.snapshot().pendingRevision).toBe(5);
  f.supervisor.sample({ updates: 2, renders: 1, appliedRevision: 5 }, true);
  expect(f.supervisor.snapshot().pendingRevision).toBeNull();
  f.time(10000); f.supervisor.sample({ updates: 2, renders: 1, appliedRevision: 5 }, true);
  expect(f.supervisor.phase).toBe("running");
  f.supervisor.dispose();
});

it("连续故障只自动重建两次，手动恢复可继续，有界诊断不包含场景", async () => {
  const f = fixture(vi.fn(async () => { throw new Error("GPU unavailable"); }));
  f.supervisor.fail("context-lost");
  await vi.runAllTimersAsync();
  expect(f.recover).toHaveBeenCalledTimes(2);
  expect(f.supervisor.phase).toBe("degraded");
  f.supervisor.fail("late"); await vi.runAllTimersAsync();
  expect(f.recover).toHaveBeenCalledTimes(2);
  f.recover.mockResolvedValue(undefined);
  f.supervisor.retry(); await vi.runAllTimersAsync();
  expect(f.supervisor.phase).toBe("running");
  for (let i = 0; i < 200; i++) f.supervisor.record("texture-isolated");
  expect(f.supervisor.snapshot().history).toHaveLength(64);
  expect(f.supervisor.snapshot().counts["texture-isolated"]).toBe(200);
  f.supervisor.dispose();
});

it("真实致命问题只在健康重建成功后清除，迟到恢复不得改写已销毁实例", async () => {
  let finish!: () => void;
  const f = fixture(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
  f.issues.report({ key: "runtime:trap", scope: "runtime", operation: "set_scene", recoverable: false, message: "trap", detail: "" });
  f.issues.clear("runtime:trap");
  expect(f.issues.getSnapshot()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(250);
  f.supervisor.dispose(); finish(); await Promise.resolve();
  expect(f.supervisor.phase).toBe("disposed");
  expect(f.invalidate).not.toHaveBeenCalled();
});

it("dispose 在退避期间取消重建", async () => {
  const f = fixture(); f.supervisor.fail("async-error"); f.supervisor.dispose();
  await vi.runAllTimersAsync(); expect(f.recover).not.toHaveBeenCalled();
});

it("同 revision 的新视口需要对应 generation 的应用和 render 确认", () => {
  const f = fixture(); f.supervisor.accepted(0, 10);
  f.supervisor.sample({ updates: 1, renders: 1, appliedRevision: 0, appliedGeneration: 10, renderedGeneration: 9 }, true);
  expect(f.supervisor.snapshot().pendingGeneration).toBe(10);
  f.supervisor.sample({ updates: 2, renders: 2, appliedRevision: 0, appliedGeneration: 10, renderedGeneration: 10 }, true);
  expect(f.supervisor.snapshot().pendingRevision).toBeNull();
  f.supervisor.dispose();
});

it("健康协议版本不匹配或数据非法必须明确拒绝", () => {
  expect(() => readRuntimeHealth('{"updates":1}')).toThrow("协议不匹配");
  const health = { version: "woohaa-runtime-health-v1", updates: 1, renders: 1, appliedRevision: 0, appliedGeneration: 2, renderedGeneration: 2 };
  expect(readRuntimeHealth(JSON.stringify(health)).renderedGeneration).toBe(2);
  expect(() => readRuntimeHealth(JSON.stringify({ ...health, renders: -1 }))).toThrow();
});

it("重建成功后的观察者异常不能触发重复重建", async () => {
  const f = fixture(); f.invalidate.mockImplementation(() => { throw new Error("observer"); });
  f.supervisor.fail("context-lost"); await vi.runAllTimersAsync();
  expect(f.supervisor.phase).toBe("running"); expect(f.recover).toHaveBeenCalledOnce();
  expect(f.supervisor.snapshot().counts["observer-failed"]).toBe(1);
  f.supervisor.dispose();
});
