import { describe, expect, it } from "vitest";
import { createInputSegments } from "./interaction-input-segments.js";
import type { InteractionRecorder } from "./interaction-performance.js";
import { measureInteractionWork, withInteractionTiming } from "../../services/interaction-timing.js";

describe("event-owned edit timings", () => {
  it("subtracts nested work and accumulates repeated segments", () => {
    let now = 0;
    const segments = createInputSegments({ now: () => now } as NonNullable<InteractionRecorder>);
    segments.measure("editSubmitSyncMs", () => withInteractionTiming(segments.measure, () => {
      now += 2;
      measureInteractionWork("historyPlanMs", () => { now += 4; });
      measureInteractionWork("historyPlanMs", () => { now += 3; });
      now += 1;
    }));
    expect(segments.current()).toEqual({ historyPlanMs: 7, editSubmitSyncMs: 3 });
  });
  it("restores ownership after an exception and does not attribute async continuations", async () => {
    let now = 0;
    const segments = createInputSegments({ now: () => now } as NonNullable<InteractionRecorder>);
    expect(() => withInteractionTiming(segments.measure, () => {
      measureInteractionWork("historyPlanMs", () => { now += 2; throw new Error("reject"); });
    })).toThrow("reject");
    measureInteractionWork("historyPlanMs", () => { now += 10; });
    await withInteractionTiming(segments.measure, async () => {
      await Promise.resolve();
      measureInteractionWork("commandWireMs", () => { now += 10; });
    });
    expect(segments.current()).toEqual({ historyPlanMs: 2 });
  });
});
