import { expect, it, vi } from "vitest";
import { createNativeViewportChannel } from "./native-viewport-channel.js";

function setup() {
  const requests: { json: string; sequence: number; signal: AbortSignal; resolve(n: number): void; reject(e: unknown): void }[] = [];
  const sync = vi.fn(() => 90), failed = vi.fn(), accepted = vi.fn();
  const channel = createNativeViewportChannel({ sync, failed,
    send: (json, sequence, signal) => new Promise<number>((resolve, reject) => requests.push({ json, sequence, signal, resolve, reject })) });
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { channel, requests, sync, failed, accepted, settle };
}

it("只保留一个在途请求和最新待发值，收到接受前不发布代数", async () => {
  const f = setup(); f.channel.queue("first", f.accepted); await f.settle();
  for (let i = 0; i < 100; i++) f.channel.queue(`next-${i}`, f.accepted);
  expect(f.requests).toHaveLength(1); expect(f.accepted).not.toHaveBeenCalled();
  f.requests[0].resolve(12); await f.settle();
  expect(f.accepted).toHaveBeenCalledWith(12);
  expect(f.requests).toHaveLength(2); expect(f.requests[1].json).toBe("next-99");
  f.requests[1].resolve(13); await f.settle();
  expect(f.accepted).toHaveBeenLastCalledWith(13); expect(f.channel.flush()).toBeNull();
});

it("点击前同步结算最新视口；迟到的旧接受或错误不能覆盖新代数", async () => {
  const f = setup(); f.channel.queue("old", f.accepted); await f.settle();
  f.channel.queue("latest", f.accepted);
  expect(f.channel.flush()).toBe(90);
  expect(f.sync).toHaveBeenCalledWith("latest", 3);
  expect(f.requests[0].signal.aborted).toBe(true);
  f.requests[0].resolve(10); await f.settle();
  expect(f.accepted.mock.calls).toEqual([[90]]); expect(f.failed).not.toHaveBeenCalled();
});

it("完整场景取消旧导航，旧回包与错误不能污染新场景", async () => {
  const f = setup(); f.channel.queue("old-base", f.accepted); await f.settle();
  f.channel.cancel(); f.channel.queue("new-base", f.accepted); await f.settle();
  f.requests[0].reject(new Error("stale base")); f.requests[1].resolve(21); await f.settle();
  expect(f.accepted.mock.calls).toEqual([[21]]); expect(f.failed).not.toHaveBeenCalled();
});

it("真实异步拒绝进入故障路径，销毁后不再发送或发布迟到结果", async () => {
  const f = setup(); f.channel.queue("bad", f.accepted); await f.settle();
  f.requests[0].reject(new Error("rejected")); await f.settle();
  expect(f.failed).toHaveBeenCalledOnce(); expect(() => f.channel.flush()).toThrow("rejected");
  const other = setup(); other.channel.queue("pending", other.accepted); await other.settle();
  other.channel.dispose(); other.requests[0].resolve(99); await other.settle();
  expect(other.accepted).not.toHaveBeenCalled(); expect(() => other.channel.queue("late", other.accepted)).toThrow("disposed");
});
