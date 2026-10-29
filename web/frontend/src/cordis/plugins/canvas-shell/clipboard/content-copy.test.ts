import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, createEmptyWoohaa3ServerCanvas, type ContentNodeDataCodec } from "@woohaa3/contracts";
import { buildCanvasCopyPayload } from "./payload.js";
import { planCanvasPaste } from "./planner.js";

function codec(seen: string[] = []): ContentNodeDataCodec {
  return {
    decode: (data) => ({ ok: true, value: data }),
    validatePatch: () => null,
    normalize: (data) => data,
    sanitizeRuntime: (data) => data,
    copy(nodeData, context) {
      seen.push([...context.nodeIds.values()].join(","));
      return {
        data: { ...(nodeData as object), mediaAssetId: "asset-1", copiedId: context.createId("copy", 0) },
        assetRefs: ["asset-1"],
        remap: {}
      };
    },
    diff: (before, after) => ({ ok: true, forward: after, inverse: before })
  };
}

function registry(codecImpl = codec()): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register({ extensionId: "test-copy", nodeData: codecImpl });
  return result;
}

function canvas() {
  const result = createEmptyWoohaa3ServerCanvas("source");
  result.document.nodes.push({ id: "node", type: "composite-asset", position: { x: 0, y: 0 } });
  result.nodeData.node = { extensionId: "test-copy", name: "x" };
  result.assets.push({ id: "asset-1", kind: "image", storageKey: "media/asset-1.png", createdAt: "2026-10-28T00:00:00.000Z" } as never);
  return result;
}

describe("owner copy and paste", () => {
  it("carries owner assetRefs and re-applies copy with the real new id", () => {
    const seen: string[] = [];
    const content = registry(codec(seen));
    const payload = buildCanvasCopyPayload(canvas(), ["node"], content)!;
    expect(payload.assets?.map((asset) => asset.id)).toEqual(["asset-1"]);
    expect(payload.nodeData.node).toMatchObject({ extensionId: "test-copy", mediaAssetId: "asset-1" });

    const target = createEmptyWoohaa3ServerCanvas("target");
    const plan = planCanvasPaste({
      canvas: target,
      payload,
      content,
      anchor: { kind: "point", position: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 },
      createId: (prefix, index) => `${prefix}-${index}`
    })!;
    const added = plan.commands.find((command) => command.type === "node.add");
    expect(added?.type).toBe("node.add");
    if (added?.type === "node.add") {
      expect(added.node.id).toBe(plan.newNodeIds[0]);
      expect(added.nodeData).toMatchObject({ copiedId: "copy-0", mediaAssetId: "asset-1" });
    }
    expect(seen).toEqual(["node", plan.newNodeIds[0]]);
  });

  it("refuses an unknown owner and a denied interaction without touching the clipboard", () => {
    const unknown = buildCanvasCopyPayload(canvas(), ["node"], new ContentContributionRegistry());
    expect(unknown).toBeNull();
    const denied = new ContentContributionRegistry();
    denied.register({
      extensionId: "test-copy",
      nodeData: codec(),
      interaction: {
        isManagedNode: () => true,
        selectionActions: () => ({ allowed: false, reason: "protected" }),
        hoverPlaybackTarget: () => null,
        doubleClickTarget: () => null
      }
    });
    expect(buildCanvasCopyPayload(canvas(), ["node"], denied)).toBeNull();
  });
});
