import { describe, expect, it } from "vitest";
import { AGENT_TARGET_MODES, isAgentTargetMode } from "./conversation.js";

describe("Agent target mode ownership", () => {
  it("accepts extension-declared business modes without a kernel whitelist", () => {
    expect(isAgentTargetMode("film-set", ["film-set"])).toBe(true);
    expect(isAgentTargetMode("npc-production", ["npc-production"])).toBe(true);
    expect(isAgentTargetMode("npc-production")).toBe(true);
    expect(AGENT_TARGET_MODES).not.toContain("film-set");
  });

  it("rejects unstable syntax", () => {
    expect(isAgentTargetMode("Film Set")).toBe(false);
    expect(isAgentTargetMode("../film-set", ["../film-set"])).toBe(false);
    expect(isAgentTargetMode("")).toBe(false);
  });
});
