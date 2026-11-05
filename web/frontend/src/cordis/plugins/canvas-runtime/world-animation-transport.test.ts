import { describe, expect, it, vi } from "vitest";
import { WorldAnimationTransport } from "./world-animation-transport.js";

function fixture() {
  let now = 0, id = 0;
  const frames = new Map<number, (time: number) => void>();
  const invalidate = vi.fn();
  const player = new WorldAnimationTransport(invalidate, {
    now: () => now,
    request: callback => { frames.set(++id, callback); return id; },
    cancel: frame => { frames.delete(frame); }
  });
  const tick = (seconds: number) => {
    now += seconds * 1000;
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(now));
  };
  const definitions = [
    { nodeId: "a", key: "a-v1", duration: 4, loop: false },
    { nodeId: "b", key: "b-v1", duration: 2, loop: true }
  ];
  player.sync("canvas", definitions, "a");
  return { player, tick, frames, definitions, invalidate };
}

describe("导演区独立时间轴", () => {
  it("starts paused, seeks exactly and resumes from the paused time without a clock jump", () => {
    const { player, tick, frames } = fixture();
    expect(player.snapshot()).toMatchObject({ nodeId: "a", time: 0, playing: false });
    expect(frames.size).toBe(0);
    player.play(); tick(0.75); player.pause(); tick(10);
    expect(player.snapshot().time).toBe(0.75);
    player.seek(2.5); player.play(); tick(0.5);
    expect(player.snapshot()).toMatchObject({ time: 3, playing: true });
    player.seek(Infinity);
    expect(player.snapshot().time).toBe(3);
    player.seek(-1);
    expect(player.snapshot()).toMatchObject({ time: 0, playing: false });
    expect(frames.size).toBe(0);
  });

  it("pauses on director switches, keeps playing after deselection and remembers each playhead", () => {
    const { player, tick, definitions, frames } = fixture();
    player.play(); tick(1);
    player.sync("canvas", definitions, "b");
    expect(player.snapshot()).toMatchObject({ nodeId: "b", time: 0, playing: false, loop: true });
    player.seek(0.5); player.setLoop(false); player.play(); tick(0.25);
    player.sync("canvas", definitions, null);
    expect(player.snapshot()).toMatchObject({ nodeId: "b", playing: true });
    expect(frames.size).toBe(1);
    tick(0.25);
    player.sync("canvas", definitions, "a");
    expect(player.snapshot()).toMatchObject({ time: 1, playing: false });
    player.sync("canvas", definitions, "b");
    expect(player.snapshot()).toMatchObject({ time: 1, loop: false, playing: false });
    expect([...player.sampleTimes()]).toEqual([["a", 1], ["b", 1]]);
  });

  it("continues when selection is cleared or moves to a model, and still stops at the end", () => {
    const { player, tick, definitions, frames } = fixture();
    player.play(); tick(1);
    player.sync("canvas", definitions, null); tick(0.5);
    expect(player.snapshot()).toMatchObject({nodeId:"a",time:1.5,playing:true});
    player.sync("canvas", definitions, "model"); tick(0.5);
    expect(player.snapshot()).toMatchObject({nodeId:"a",time:2,playing:true});
    player.sync("canvas", definitions, "a"); tick(0.5);
    expect(player.snapshot()).toMatchObject({time:2.5,playing:true});
    player.sync("canvas", definitions, null); tick(2);
    expect(player.snapshot()).toMatchObject({time:4,playing:false});
    expect(frames.size).toBe(0);
    player.play(); player.setLoop(true); tick(5);
    expect(player.snapshot()).toMatchObject({nodeId:"a",time:1,playing:true});
    player.sync("canvas", [], null);
    expect(player.snapshot()).toMatchObject({nodeId:null,playing:false});
    expect(frames.size).toBe(0);
  });

  it("holds the exact final pose, restarts at the end and wraps only when loop is enabled", () => {
    const { player, tick, frames } = fixture();
    player.play(); tick(5);
    expect(player.snapshot()).toMatchObject({ time: 4, playing: false });
    expect(player.sampleTimes().get("a")).toBe(4);
    expect(frames.size).toBe(0);
    player.play();
    expect(player.snapshot()).toMatchObject({ time: 0, playing: true });
    tick(1); player.setLoop(true); tick(4.5);
    expect(player.snapshot()).toMatchObject({ time: 1.5, playing: true, loop: true });
    player.setLoop(false); tick(3);
    expect(player.snapshot()).toMatchObject({ time: 4, playing: false });
  });

  it("preserves state across ordinary revisions, resets edited animation and removes deleted areas", () => {
    const { player, tick, definitions, frames } = fixture();
    player.play(); tick(1);
    player.sync("canvas", definitions, "a"); tick(0.5);
    expect(player.snapshot()).toMatchObject({ time: 1.5, playing: true });
    const edited = [{ ...definitions[0]!, key: "a-v2", duration: 1 }];
    player.sync("canvas", edited, "a");
    expect(player.snapshot()).toMatchObject({ time: 0, duration: 1, playing: false });
    expect(player.sampleTimes().has("b")).toBe(false);
    player.play(); player.sync("canvas", [], "a");
    expect(player.snapshot()).toMatchObject({ nodeId: null, time: 0, playing: false });
    expect(frames.size).toBe(0);
  });

  it("clears state on page change and disposal and keeps unchanged external snapshots stable", () => {
    const { player, tick, definitions, frames, invalidate } = fixture();
    const snapshot = player.snapshot(), times = player.sampleTimes();
    const listener = vi.fn(), unsubscribe = player.subscribe(listener);
    invalidate.mockClear();
    player.sync("canvas", definitions, "a");
    expect(player.snapshot()).toBe(snapshot);
    expect(player.sampleTimes()).toBe(times);
    expect(listener).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    player.play(); tick(1); player.sync("other-canvas", definitions, "a");
    expect(player.snapshot()).toMatchObject({ time: 0, playing: false });
    player.play(); player.dispose();
    expect(frames.size).toBe(0);
    expect(player.sampleTimes().size).toBe(0);
    expect(player.snapshot()).toMatchObject({ nodeId: null, time: 0, playing: false });
    unsubscribe(); listener.mockClear(); player.sync("canvas", definitions, "a");
    expect(listener).not.toHaveBeenCalled();
  });
});
