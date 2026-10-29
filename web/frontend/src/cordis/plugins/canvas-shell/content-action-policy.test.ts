import { describe, expect, it, vi } from "vitest";
import { ContentContributionRegistry } from "@woohaa3/contracts";
import { describeNodeActions, routeNodeActionHit } from "./node-action-host.js";

function content() {
  const registry = new ContentContributionRegistry();
  registry.register({
    extensionId: "test-content",
    interaction: {
      isManagedNode: (type, data) => type === "composite-asset" && (data as { extensionId?: string })?.extensionId === "test-content",
      selectionActions: (action) => action === "download" || action === "convert"
        ? { allowed: false, reason: "protected-content" }
        : { allowed: true },
      hoverPlaybackTarget: () => null,
      doubleClickTarget: () => null
    }
  });
  return registry;
}

const contribution = {
  id: "download",
  owner: "test",
  order: 0,
  contentAction: "download" as const,
  describe: () => ({ label: "下载", enabled: true }),
  activate: () => {}
};

describe("content interaction in node action toolbars", () => {
  it("renders the action disabled with the owner reason", () => {
    const description = describeNodeActions({
      contributions: [contribution],
      context: { nodeId: "node", nodeType: "composite-asset", writable: true, nodeData: { extensionId: "test-content" }, content: content() }
    });
    expect(description?.presentation.actions[0]).toMatchObject({ id: "download", enabled: false });
  });

  it("does not dispatch a denied activation", () => {
    const activate = vi.fn();
    routeNodeActionHit({
      hit: { nodeId: "node", actionId: "download", menu: false },
      context: { nodeId: "node", nodeType: "composite-asset", writable: true, nodeData: { extensionId: "test-content" }, content: content() },
      contributions: [{ ...contribution, activate }],
      openSettings: () => {}
    });
    expect(activate).not.toHaveBeenCalled();
  });
});
