import { describe, expect, it } from "vitest";
import { ContentContributionRegistry } from "@woohaa3/contracts";
import { nodeContextMenuItems, selectionActionDescriptor } from "./plugin.js";

function content() {
  const registry = new ContentContributionRegistry();
  registry.register({
    extensionId: "test-content",
    interaction: {
      isManagedNode: (type, data) => type === "composite-asset" && (data as { extensionId?: string })?.extensionId === "test-content",
      selectionActions: (action) => action === "delete" || action === "rename" || action === "group"
        ? { allowed: false, reason: "protected-content" }
        : { allowed: true },
      hoverPlaybackTarget: () => null,
      doubleClickTarget: () => null
    }
  });
  return registry;
}

const nodes = [{ id: "node", type: "composite-asset" }];
const nodeData = { node: { extensionId: "test-content" } };

describe("content interaction in canvas menus", () => {
  it("disables delete and rename for a protected owner", () => {
    const items = nodeContextMenuItems(nodes, ["node"], true, { nodeData, content: content() });
    expect(items.find((item) => item.id === "delete-node")).toMatchObject({ disabled: true, reason: "protected-content" });
    expect(items.find((item) => item.id === "rename-node")).toMatchObject({ disabled: true, reason: "protected-content" });
  });

  it("disables group for a protected selection", () => {
    const descriptor = selectionActionDescriptor({
      nodes: [...nodes, { id: "other", type: "image" }],
      selectedNodeIds: ["node", "other"],
      writable: true,
      kind: "group",
      nodeData,
      content: content()
    });
    expect(descriptor).toMatchObject({ enabled: false, reason: "protected-content" });
  });
});
