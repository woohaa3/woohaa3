import { describe, expect, it } from "vitest";
import { adapterSupportsReasoningEffort, projectReasoningCapability, resolveReasoningEffort } from "./reasoning.js";

describe("Agent adapter reasoning 映射", () => {
  it("每个引擎只公开能映射的 canonical 档位", () => {
    expect(["low", "medium", "high"].every((effort) => adapterSupportsReasoningEffort("codex-agent-sdk", effort as never))).toBe(true);
    expect(adapterSupportsReasoningEffort("codex-agent-sdk", "ultra")).toBe(false);
    expect(adapterSupportsReasoningEffort("gemini-agent-adk", "medium")).toBe(false);
    expect(resolveReasoningEffort("dsh-agent-sdk", "none")).toEqual({ level: "off", wire: "none" });
    expect(resolveReasoningEffort("dsh-agent-sdk", "high")).toEqual({ level: "high", wire: "high" });
    expect(resolveReasoningEffort("dsh-agent-sdk", "ultra")).toBeNull();
  });

  it("目录只保留 adapter 可执行档位，全部不可映射时保留 supported 无档位", () => {
    const capability = { state: "supported" as const, source: "provider" as const, revision: "r", efforts: [{ id: "ultra" as const }, { id: "high" as const }] };
    expect(projectReasoningCapability("gemini-agent-adk", capability)).toMatchObject({ state: "supported", efforts: [{ id: "high" }] });
    expect(projectReasoningCapability("codex-agent-sdk", capability).efforts).toEqual([{ id: "high" }]);
  });
});
