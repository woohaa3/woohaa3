import { describe, expect, it } from "vitest";
import { mcpToolOutcome } from "../src/backend/mcp-tool-outcome.js";
describe("MCP transport vs domain result", () => {
  it("does not count completed MCP error as an applied canvas edit", () => {
    expect(mcpToolOutcome({ status: "completed", result: { isError: true, content: [{ text: "stale-clip" }] } })).toEqual({ ok: false, message: "stale-clip" });
    expect(mcpToolOutcome({ status: "completed", result: { structuredContent: { ok: false, message: "目标已删除" } } })).toEqual({ ok: false, message: "目标已删除" });
    expect(mcpToolOutcome({ status: "completed", result: { structuredContent: { ok: true } } }).ok).toBe(true);
  });
});
