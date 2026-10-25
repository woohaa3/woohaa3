import { describe, expect, it } from "vitest";
import { ContinuousWheelOwner, WHEEL_OWNER_IDLE_MS } from "./continuous-wheel-owner.js";

describe("ContinuousWheelOwner", () => {
  it("retains the starting owner through changing targets until idle", () => {
    const owner = new ContinuousWheelOwner<string>();
    expect(owner.resolve(10, () => ({ owner: "canvas", target: null })).owner).toBe("canvas");
    expect(owner.resolve(150, () => ({ owner: "native", target: "input" })).owner).toBe("canvas");
    expect(owner.resolve(150 + WHEEL_OWNER_IDLE_MS, () => ({ owner: "native", target: "input" })))
      .toMatchObject({ owner: "native", target: "input", started: true });
  });

  it("can be explicitly cancelled before a replacement session", () => {
    const owner = new ContinuousWheelOwner<string>();
    owner.resolve(1, () => ({ owner: "blocked", target: null }));
    owner.reset();
    expect(owner.resolve(2, () => ({ owner: "canvas", target: null })).owner).toBe("canvas");
  });
});
