import { describe, it, expect } from "vitest";
import { HoverPlaybackDelay, HOVER_PLAYBACK_DELAY_MS } from "../src/frontend/hover-delay.js";
function fixture() {
  let time = 0, count = 0;
  const tasks = new Map<number, () => void>();
  let next = 0;
  let key: string | null = "A";
  const delay = new HoverPlaybackDelay(() => { if (delay.sync(key)) count++; }, {
    now: () => time,
    set: run => { tasks.set(++next, run); return next as unknown as ReturnType<typeof setTimeout>; },
    clear: timer => { tasks.delete(timer as unknown as number); }
  });
  return { delay, tasks, key: (value: string | null) => { key = value; return delay.sync(key); },
    at: (value: number) => { time = value; }, ready: () => count,
    fire: () => { const entries = [...tasks.values()]; tasks.clear(); entries.forEach(run => run()); } };
}
describe("stable hover deadline", () => {
  it("preserves deadline on duplicate identity and fills an early callback's remaining time", () => {
    const f = fixture(); f.key("A"); f.at(20); f.key("A");
    expect(f.tasks.size).toBe(1);
    f.at(HOVER_PLAYBACK_DELAY_MS - 1); f.fire();
    expect(f.ready()).toBe(0); expect(f.tasks.size).toBe(1);
    f.at(HOVER_PLAYBACK_DELAY_MS); f.fire();
    expect(f.ready()).toBe(1); expect(f.tasks.size).toBe(0);
  });
  it("rejects cancelled and disposed callbacks even when cancellation arrives too late", () => {
    const f = fixture(); f.key("A"); const old = [...f.tasks.values()][0];
    const switched = HOVER_PLAYBACK_DELAY_MS - 80;
    const deadline = switched + HOVER_PLAYBACK_DELAY_MS;
    f.at(switched); f.key("B"); f.at(HOVER_PLAYBACK_DELAY_MS); old(); expect(f.ready()).toBe(0);
    f.at(deadline - 1); expect(f.key("B")).toBe(false); f.at(deadline); f.fire(); expect(f.ready()).toBe(1);
    f.key("C"); const pending = [...f.tasks.values()][0]; f.delay.dispose(); f.at(4000); pending();
    expect(f.ready()).toBe(1); expect(f.tasks.size).toBe(0);
  });
  it("revalidates identity at a delayed callback and restarts eligibility from zero", () => {
    const f = fixture(); f.key("A"); f.at(900); f.key(null); f.key("A");
    f.at(900 + HOVER_PLAYBACK_DELAY_MS - 1); expect(f.key("A")).toBe(false);
    f.at(900 + HOVER_PLAYBACK_DELAY_MS); f.fire(); expect(f.ready()).toBe(1);
  });
});
