import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { isCanvasCommandSatisfied } from "./command-satisfaction.js";
import { ContentContributionRegistry, type ContentEditPlanner } from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";

function editPlanner(): ContentEditPlanner {
  return {
    plan: () => ({ ok: true, plan: { forward: { preconditions: [], operations: [] }, inverse: { preconditions: [], operations: [] } } }),
    apply({ direction, edit, preconditions, canvas }) {
      const input = edit as { nodeId: string; value: string };
      const expected = preconditions[0] as { value?: string } | undefined;
      const current = canvas.nodeData[input.nodeId] as { value?: string } | undefined;
      if (expected && current?.value !== expected.value) return { ok: false, code: "edit-precondition-failed", reason: "stale" };
      const value = direction === "forward" ? input.value : (edit as { previous?: string }).previous ?? "old";
      return { ok: true, canvas: { ...canvas, nodeData: { ...canvas.nodeData, [input.nodeId]: { ...current, value } } } };
    },
    satisfied({ edit, canvas }) {
      const input = edit as { nodeId: string; value: string };
      return (canvas.nodeData[input.nodeId] as { value?: string } | undefined)?.value === input.value;
    }
  };
}

function registry(edit: ContentEditPlanner = editPlanner()): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register({ extensionId: "test-edit", edit });
  return result;
}

function canvas() {
  const result = createEmptyWoohaa3ServerCanvas("canvas");
  result.document.nodes.push({ id: "node", type: "composite-asset", position: { x: 0, y: 0 } });
  result.nodeData.node = { extensionId: "test-edit", value: "old" };
  return result;
}

describe("extension.edit", () => {
  it("applies forward and inverse edits atomically", () => {
    const forward = applyCanvasCommands(canvas(), [{
      type: "extension.edit",
      extensionId: "test-edit",
      direction: "forward",
      edit: { nodeId: "node", value: "new", previous: "old" },
      preconditions: [{ value: "old" }]
    }], { content: registry() });
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect(forward.canvas.nodeData.node).toEqual({ extensionId: "test-edit", value: "new" });

    const inverse = applyCanvasCommands(forward.canvas, [{
      type: "extension.edit",
      extensionId: "test-edit",
      direction: "inverse",
      edit: { nodeId: "node", value: "new", previous: "old" },
      preconditions: [{ value: "new" }]
    }], { content: registry() });
    expect(inverse.ok).toBe(true);
    if (!inverse.ok) return;
    expect(inverse.canvas.nodeData.node).toEqual({ extensionId: "test-edit", value: "old" });
  });

  it("rejects a stale precondition without changing the canvas", () => {
    const source = canvas();
    const result = applyCanvasCommands(source, [{
      type: "extension.edit",
      extensionId: "test-edit",
      direction: "forward",
      edit: { nodeId: "node", value: "new" },
      preconditions: [{ value: "other" }]
    }], { content: registry() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("content-command-rejected");
    expect(source.nodeData.node).toEqual({ extensionId: "test-edit", value: "old" });
  });

  it("rejects an unregistered owner before any side effect", () => {
    const source = canvas();
    const result = applyCanvasCommands(source, [{
      type: "extension.edit",
      extensionId: "test-edit",
      direction: "forward",
      edit: { nodeId: "node", value: "new" }
    }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("content-owner-unavailable");
    expect(source.nodeData.node).toEqual({ extensionId: "test-edit", value: "old" });
  });

  it("reports satisfaction through the owner", () => {
    const applied = applyCanvasCommands(canvas(), [{
      type: "extension.edit",
      extensionId: "test-edit",
      direction: "forward",
      edit: { nodeId: "node", value: "new" }
    }], { content: registry() });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(isCanvasCommandSatisfied(applied.canvas, {
      type: "extension.edit",
      extensionId: "test-edit",
      direction: "forward",
      edit: { nodeId: "node", value: "new" }
    }, registry())).toBe(true);
  });
});
