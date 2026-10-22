import { describe, expect, it, vi } from "vitest";
import { beginInteractionProfile, endInteractionProfile, measureInteractionPhase, measureVideoPhase, recordVideoTransition } from "./interaction-phase-profiler.js";
describe("interaction phase profiler", () => {
  it("attributes nested work without double counting and resets each recording", () => {
    beginInteractionProfile();
    let time = 0; const now = () => time;
    measureInteractionPhase("frame", () => {
      time += 2;
      measureInteractionPhase("submission", () => { time += 5; }, now);
      time += 3;
    }, now);
    const result = endInteractionProfile();
    expect(result.phases.frame).toMatchObject({ totalMs: 10, selfMs: 5 });
    expect(result.slowFrames[0]).toMatchObject({ totalMs: 10, phases: { submission: 5, frame: 5 } });
    beginInteractionProfile(); expect(endInteractionProfile().phases).toEqual({});
  });
  it("retains bounded slow frames, records failures and does not sample when stopped", () => {
    beginInteractionProfile(); let time = 0; const now = () => time;
    for (let i = 1; i <= 12; i++) measureInteractionPhase("frame", () => { time += i; }, now);
    expect(() => measureInteractionPhase("failure", () => { time++; throw Error("x"); }, now)).toThrow("x");
    const result = endInteractionProfile(); expect(result.slowFrames).toHaveLength(8);
    expect(result.slowFrames[0].totalMs).toBe(12); expect(result.phases.failure.calls).toBe(1);
    measureInteractionPhase("stopped", () => {}, () => { throw Error("should not time"); });
  });
});

it("captures bounded video events with relative timing, resets and ignores idle work", () => {
  let time = 100;
  const now = vi.spyOn(performance, "now").mockImplementation(() => time);
  try {
    beginInteractionProfile();
    recordVideoTransition("focus-resume", 2);
    measureVideoPhase("read-pixels", "video-node", () => { time += 55; });
    const result = endInteractionProfile();
    expect(result.videoEvents).toEqual([
      { name: "focus-resume", atMs: 0, sessionCount: 2 },
      { name: "read-pixels", nodeId: "video-node", atMs: 0, durationMs: 55 }
    ]);
    expect(result.phases["video.read-pixels"].totalMs).toBe(55);
    beginInteractionProfile();
    for (let i = 0; i < 260; i++) recordVideoTransition("focus-resume", 1);
    expect(endInteractionProfile()).toMatchObject({ videoEventsDropped: 4 });
    beginInteractionProfile();
    expect(endInteractionProfile().videoEvents).toEqual([]);
    now.mockImplementation(() => { throw Error("idle clock"); });
    expect(measureVideoPhase("idle", null, () => 1)).toBe(1);
  } finally { now.mockRestore(); endInteractionProfile(); }
});
