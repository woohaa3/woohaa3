import { expect, it, vi } from "vitest";
import type { BevyAnimationPlayback } from "@woohaa3/contracts";
import { AnimationPlaybackStore } from "./animation-playback-store.js";

it("重复清空不通知媒体；真实开始、时间变化和停止仍各通知一次", () => {
  const store = new AnimationPlaybackStore();
  const sink = vi.fn(); store.setTimeSink(sink);
  expect(store.set(null)).toBe(false);
  const playback = { nodeId: "film", time: 1, playing: true } as BevyAnimationPlayback;
  expect(store.set(playback)).toBe(true);
  expect(store.set(playback)).toBe(false);
  expect(store.set({ ...playback, time: 2 })).toBe(true);
  expect(store.set(null)).toBe(true);
  expect(store.set(null)).toBe(false);
  expect(sink.mock.calls.map(([value]) => value)).toEqual([
    { nodeId: "film", time: 1, playing: true },
    { nodeId: "film", time: 2, playing: true },
    { nodeId: null, time: 0, playing: false }
  ]);
});
