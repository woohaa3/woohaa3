import { afterEach, expect, it, vi } from "vitest";
import { pollShotCapture } from "./shot-capture-poll.js";
import type { BevyModule } from "./bevy-runtime-types.js";

afterEach(() => vi.useRealTimers());
it("实例更换/销毁取消待返回截图，不访问旧 WASM", async () => {
  vi.useFakeTimers(); let current = true;
  const module = { request_shot_capture: vi.fn(), poll_shot_capture: vi.fn(() => { throw new Error("old realm"); }) } as unknown as BevyModule;
  const capture = pollShotCapture(module, { requestId: 1, nodeId: "n", generation: 1 }, () => current);
  current = false; await vi.advanceTimersByTimeAsync(16);
  expect(await capture).toBeNull(); expect(module.poll_shot_capture).not.toHaveBeenCalled();
});

it("保留 Rust 返回的具体失败码", async () => {
  vi.useFakeTimers();
  const payload = new TextEncoder().encode("capture-readiness-timeout");
  const frame = new Uint8Array(12 + payload.length);
  new DataView(frame.buffer).setUint32(8, 1, true);
  frame.set(payload, 12);
  const module = {
    request_shot_capture: vi.fn(),
    poll_shot_capture: vi.fn(() => frame)
  } as unknown as BevyModule;
  const capture = pollShotCapture(module, { requestId: 2, nodeId: "n", generation: 1 });
  const assertion = expect(capture).rejects.toThrow("capture-readiness-timeout");
  await vi.advanceTimersByTimeAsync(16);
  await assertion;
});

it("无结果时区分前端等待超时与底层失败", async () => {
  vi.useFakeTimers();
  const module = {
    request_shot_capture: vi.fn(),
    poll_shot_capture: vi.fn(() => new Uint8Array())
  } as unknown as BevyModule;
  const assertion = expect(pollShotCapture(module, { requestId: 3, nodeId: "n", generation: 1 }))
    .rejects.toThrow("capture-poll-timeout");
  await vi.advanceTimersByTimeAsync(20016);
  await assertion;
});

it("正常 RGBA 帧仍可返回", async () => {
  vi.useFakeTimers();
  const frame = new Uint8Array(16);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 1, true);
  frame.set([10, 20, 30, 255], 12);
  const module = {
    request_shot_capture: vi.fn(),
    poll_shot_capture: vi.fn(() => frame)
  } as unknown as BevyModule;
  const capture = pollShotCapture(module, { requestId: 4, nodeId: "n", generation: 1 });
  await vi.advanceTimersByTimeAsync(16);
  expect(await capture).toMatchObject({ width: 1, height: 1, rgba: new Uint8Array([10, 20, 30, 255]) });
});
