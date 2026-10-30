import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { ContentContributionRegistry } from "./content-contribution.js";
import { decideContentAction } from "./content-interaction.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";

const policy = {
  isManagedNode: (type: string, data: unknown) => type === "group" && (data as { lock?: unknown }).lock === true,
  selectionActions: (action: "delete" | "copy" | "cut" | "rename" | "group" | "download" | "convert") =>
    action === "delete" || action === "copy" || action === "cut"
      ? { allowed: false as const, reason: "protected" }
      : { allowed: true as const },
  hoverPlaybackTarget: () => null,
  doubleClickTarget: () => null
};

function registry(): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register({ extensionId: "test-interaction", interaction: policy });
  return result;
}

function canvas() {
  const result = createEmptyWoohaa3ServerCanvas("canvas");
  result.document.nodes.push({ id: "node", type: "composite-asset", position: { x: 0, y: 0 } });
  result.document.nodes.push({ id: "group", type: "group", position: { x: 0, y: 0 } });
  result.nodeData.node = { extensionId: "test-interaction" };
  result.nodeData.group = { lock: true };
  return result;
}

describe("content interaction policy", () => {
  it("routes managed nodes to the owner policy and leaves others generic", () => {
    expect(decideContentAction(registry(), "copy", "group", { lock: true })).toEqual({ allowed: false, reason: "protected" });
    expect(decideContentAction(registry(), "rename", "group", { lock: true })).toEqual({ allowed: true });
    expect(decideContentAction(registry(), "copy", "group", {})).toEqual({ allowed: true });
  });

  it("keeps a released owner group read-only while its locator is retained", () => {
    const content = new ContentContributionRegistry();
    const release = content.register({ extensionId: "test.group", ownerLocators: [{ nodeTypes: ["group"], fields: ["testGroup"] }] });
    release();
    expect(decideContentAction(content, "delete", "group", { testGroup: {} })).toEqual({
      allowed: false,
      reason: "content-owner-unavailable"
    });
    expect(decideContentAction(content, "delete", "group", {})).toEqual({ allowed: true });
  });

  it("keeps an unregistered composite node read-only for delete/copy", () => {
    expect(decideContentAction(registry(), "copy", "composite-asset", { extensionId: "missing" })).toEqual({
      allowed: false,
      reason: "content-owner-unavailable"
    });
  });

  it("rejects a direct delete command for a protected node", () => {
    const result = applyCanvasCommands(canvas(), [{ type: "node.remove", nodeIds: ["group"] }], { content: registry() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("content-interaction-rejected");
  });
});

describe("owner declared hover and double-click targets", () => {
  it("returns owner/entity targets without kernel business ids", async () => {
    const { resolveContentDoubleClickTarget, resolveContentHoverPlaybackTarget } = await import("./content-interaction.js");
    const registry = new ContentContributionRegistry();
    registry.register({
      extensionId: "test-interaction",
      interaction: {
        ...policy,
        isManagedNode: (type) => type === "test-preview",
        hoverPlaybackTarget: () => ({ ownerNodeId: "owner", entityId: "entity" }),
        doubleClickTarget: () => ({ kind: "test-preview", nodeId: "owner", entityId: "entity" })
      }
    });
    expect(resolveContentHoverPlaybackTarget(registry, "test-preview", {})).toEqual({ ownerNodeId: "owner", entityId: "entity" });
    expect(resolveContentDoubleClickTarget(registry, "test-preview", {})).toEqual({ kind: "test-preview", nodeId: "owner", entityId: "entity" });
    expect(resolveContentHoverPlaybackTarget(registry, "unknown", {})).toBeNull();
  });
});
