import { describe, expect, it, vi } from "vitest";
import { nextFrame, TimelinePlayback, type PlaybackRange, type PlaybackStep } from "./playback.js";

function range(overrides: Partial<PlaybackRange> = {}): PlaybackRange {
  return { fps: 10, duration: 10, current: 0, workStart: 0, workEnd: 10, ...overrides };
}

/** 可控调度器：手动触发已排队的 tick，避免测试依赖真实计时。 */
function scheduler() {
  const queue = new Map<number, { run: () => void; delay: number }>();
  let next = 0;
  return {
    schedule: (run: () => void, delay: number) => { const id = ++next; queue.set(id, { run, delay }); return id; },
    cancel: (id: number) => { queue.delete(id); },
    pending: () => queue.size,
    delays: () => [...queue.values()].map(entry => entry.delay),
    /** 触发最早排队的 tick。 */
    fire() {
      const [id, entry] = [...queue.entries()][0] ?? [];
      if (id === undefined || !entry) throw new Error("没有待执行的 tick");
      queue.delete(id);
      entry.run();
    }
  };
}

describe("时间轴播放会话", () => {
  it("按帧率排帧、到最后回卷起点，且每步都带请求序号与代际", () => {
    const clock = scheduler();
    const steps: PlaybackStep[] = [];
    let current = 0;
    const playback = new TimelinePlayback({
      generation: () => 7,
      range: () => range({ current }),
      navigate: (step) => { steps.push(step); current = step.frame; return { ok: true }; },
      schedule: clock.schedule,
      cancelSchedule: clock.cancel
    });

    expect(playback.play()).toEqual({ ok: true });
    expect(clock.pending()).toBe(1);
    expect(clock.delays()).toEqual([100]);
    // 触发 11 次：10 → 0 一次回卷，之后再走两帧。
    for (let index = 0; index < 11; index += 1) clock.fire();
    expect(steps.map((step) => step.frame)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1]);
    expect(new Set(steps.map((step) => step.requestId)).size).toBe(steps.length);
    expect(steps.every((step) => step.generation === 7)).toBe(true);
    playback.stop();
    expect(clock.pending()).toBe(0);
  });

  it("重复 play 不会叠加循环，stop 幂等", () => {
    const clock = scheduler();
    let calls = 0;
    const playback = new TimelinePlayback({
      generation: () => 1,
      range: () => range(),
      navigate: () => { calls += 1; return { ok: true }; },
      schedule: clock.schedule,
      cancelSchedule: clock.cancel
    });
    playback.play();
    playback.play();
    expect(clock.pending()).toBe(1);
    clock.fire();
    expect(clock.pending()).toBe(1);
    expect(calls).toBe(1);
    playback.stop();
    playback.stop();
    expect(clock.pending()).toBe(0);
    clock.fire.bind(clock);
    expect(calls).toBe(1);
  });

  it("没有时间轴或帧率非法时拒绝播放并给出原因", () => {
    const none = new TimelinePlayback({ generation: () => 1, range: () => null, navigate: () => ({ ok: true }) });
    expect(none.play()).toEqual({ ok: false, message: "当前文档没有时间轴，请先建立时间轴" });
    expect(none.isPlaying()).toBe(false);

    const badFps = new TimelinePlayback({ generation: () => 1, range: () => range({ fps: 0 }), navigate: () => ({ ok: true }) });
    expect(badFps.play().ok).toBe(false);
    expect(badFps.isPlaying()).toBe(false);
  });

  it("导航失败停止播放并保留原因；代际变化静默停止", () => {
    const clock = scheduler();
    const onState = vi.fn();
    let generation = 3;
    let current = 0;
    const playback = new TimelinePlayback({
      generation: () => generation,
      range: () => range({ current }),
      navigate: (step) => {
        if (step.frame === 2) return { ok: false, message: "帧号超过帧预算" };
        current = step.frame;
        return { ok: true };
      },
      onState,
      schedule: clock.schedule,
      cancelSchedule: clock.cancel
    });
    playback.play();
    clock.fire(); // 1
    clock.fire(); // 2 → 失败
    expect(playback.isPlaying()).toBe(false);
    expect(playback.message()).toBe("帧号超过帧预算");
    expect(onState).toHaveBeenLastCalledWith(false, "帧号超过帧预算");
    expect(clock.pending()).toBe(0);

    // 代际变化（切文档）后即使 tick 已被调度也不再导航。
    const navigations: number[] = [];
    current = 0;
    const second = new TimelinePlayback({
      generation: () => generation,
      range: () => range({ current }),
      navigate: (step) => { navigations.push(step.frame); return { ok: true }; },
      schedule: clock.schedule,
      cancelSchedule: clock.cancel
    });
    second.play();
    generation = 4;
    clock.fire();
    expect(navigations).toEqual([]);
    expect(second.isPlaying()).toBe(false);
  });

  it("工作区范围决定回卷点，且不越界", () => {
    // workEnd 是上界（含首不含尾）：workStart 2、workEnd 5 → 2,3,4 后回卷。
    expect(nextFrame(range({ current: 1, workStart: 2, workEnd: 5 }))).toBe(2);
    expect(nextFrame(range({ current: 2, workStart: 2, workEnd: 5 }))).toBe(3);
    expect(nextFrame(range({ current: 4, workStart: 2, workEnd: 5 }))).toBe(2);
    // 越界工作区被夹到有效帧。
    expect(nextFrame(range({ current: 9, workStart: 0, workEnd: 999 }))).toBe(0);
    expect(nextFrame(range({ duration: 1, current: 0 }))).toBe(0);
    // 时长 0 不至于产生负帧。
    expect(nextFrame(range({ duration: 0, current: 0 }))).toBe(0);
  });
});
