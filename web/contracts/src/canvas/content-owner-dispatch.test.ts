import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { ContentContributionRegistry, type ContentContribution, type ContentNodeDataCodec } from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { normalizeCanvas } from "./domain/normalization.js";
import { sanitizeRuntimeNodeConfigPatch } from "./domain/runtime-node-data.js";
import { planCanvasEdit } from "./edit-plan.js";

function codec(): ContentNodeDataCodec {
  return {
    decode(data) {
      if (typeof data !== "object" || data === null || typeof (data as { widgetToken?: unknown }).widgetToken !== "string") {
        return { ok: false, code: "widget-invalid", reason: "widget-invalid" };
      }
      return { ok: true, value: data };
    },
    validatePatch(_previous, patch) {
      const token = (patch as { widgetToken?: unknown }).widgetToken;
      if (token !== undefined && (typeof token !== "string" || token.length === 0)) return { code: "widget-invalid", reason: "widget-invalid" };
      return null;
    },
    normalize(data) {
      const record = { ...(data as Record<string, unknown>) };
      if (typeof record.widgetToken === "string") record.widgetToken = record.widgetToken.trim();
      return record;
    },
    sanitizeRuntime(data) {
      const record = { ...(data as Record<string, unknown>) };
      delete record.transientCursor;
      return record;
    },
    copy(data) {
      return { data: { ...(data as Record<string, unknown>) }, assetRefs: ["asset-owner"], remap: {} };
    },
    diff(before, after) {
      return { ok: true, forward: after, inverse: before };
    }
  };
}

function registry(): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  const contribution: ContentContribution = { extensionId: "test-widget", nodeData: codec() };
  result.register(contribution);
  return result;
}

function canvas() {
  const result = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-28T00:00:00.000Z");
  result.document.nodes.push({ id: "node", type: "composite-asset", position: { x: 0, y: 0 } });
  result.nodeData.node = { extensionId: "test-widget", widgetToken: " a " };
  return result;
}

describe("composite asset owner dispatch", () => {
  it("allows a registered owner to create and patch a composite node", () => {
    const created = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("empty"), [{
      type: "node.add",
      node: { id: "n", type: "composite-asset", position: { x: 0, y: 0 } },
      nodeData: { extensionId: "test-widget", widgetToken: "tok" }
    }], { content: registry() });
    expect(created.ok).toBe(true);

    const patched = applyCanvasCommands(canvas(), [{
      type: "nodeData.patch",
      nodeId: "node",
      value: { widgetToken: " b " }
    }], { content: registry() });
    expect(patched.ok).toBe(true);
    if (patched.ok) expect(patched.canvas.nodeData.node.widgetToken).toBe("b");
  });

  it("keeps an unregistered owner read-only and rejects writes with a stable code", () => {
    const source = canvas();
    const result = applyCanvasCommands(source, [{ type: "nodeData.patch", nodeId: "node", value: { widgetToken: "next" } }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("content-owner-unavailable");
    expect(source.nodeData.node.widgetToken).toBe(" a ");
    expect(normalizeCanvas(source).nodeData.node.widgetToken).toBe(" a ");
  });

  it("rejects an invalid owner patch without half-writing", () => {
    const source = canvas();
    const result = applyCanvasCommands(source, [{ type: "nodeData.patch", nodeId: "node", value: { widgetToken: 7 } }], { content: registry() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("content-patch-rejected");
    expect(source.nodeData.node.widgetToken).toBe(" a ");
  });

  it("routes runtime sanitization to the owner codec instead of a kernel field list", () => {
    const sanitized = sanitizeRuntimeNodeConfigPatch(
      { extensionId: "test-widget", widgetToken: "tok", transientCursor: { x: 1 } },
      { content: registry() }
    );
    expect(sanitized).toEqual({ ok: true, value: { extensionId: "test-widget", widgetToken: "tok" } });
    expect(sanitizeRuntimeNodeConfigPatch({ extensionId: "test-widget", transientCursor: { x: 1 } })).toEqual({
      ok: false,
      reason: "nodeData patch 不含任何允许字段"
    });
  });
});

describe("owner diff history", () => {
  function diffRegistry(fail = false): ContentContributionRegistry {
    const registry = new ContentContributionRegistry();
    registry.register({
      extensionId: "test-widget",
      nodeData: {
        ...codec(),
        diff(before, after) {
          if (fail) return { ok: false, code: "diff-refused", reason: "diff-refused" };
          return {
            ok: true,
            forward: { ...(after as Record<string, unknown>), ownerDiff: "forward" },
            inverse: { ...(before as Record<string, unknown>), ownerDiff: "inverse" }
          };
        }
      }
    });
    return registry;
  }

  it("uses owner forward/inverse and restores nodeData exactly", () => {
    const content = diffRegistry();
    const plan = planCanvasEdit(canvas(), [{ type: "nodeData.patch", nodeId: "node", value: { widgetToken: "b" } }], { content });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.forward.operations).toEqual([
      { kind: "node-data-set", nodeId: "node", value: { extensionId: "test-widget", widgetToken: "b", ownerDiff: "forward" } }
    ]);
    const applied = applyCanvasCommands(canvas(), [{
      type: "edit.apply",
      preconditions: plan.forward.preconditions,
      operations: plan.forward.operations
    }], { content });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const undone = applyCanvasCommands(applied.canvas, [{
      type: "edit.apply",
      preconditions: plan.inverse.preconditions,
      operations: plan.inverse.operations
    }], { content });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.canvas.nodeData.node).toEqual({
      extensionId: "test-widget",
      widgetToken: "a",
      ownerDiff: "inverse"
    });
  });

  it("fails planning when the owner diff rejects", () => {
    const plan = planCanvasEdit(canvas(), [{ type: "nodeData.patch", nodeId: "node", value: { widgetToken: "b" } }], { content: diffRegistry(true) });
    expect(plan).toEqual({ ok: false, reason: "diff-refused" });
  });
});
