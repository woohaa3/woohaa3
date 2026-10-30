import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { renderPreview } from "./preview-service.js";

describe("内容预览媒体读取 owner", () => {
  it("从权威节点定位解析 owner，而不是让调用方自报", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-30T00:00:00.000Z");
    canvas.document.nodes.push({ id: "owned", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.owned = { extensionId: "test-owner", version: 1 } as never;

    const registry = new ContentContributionRegistry();
    registry.register({ extensionId: "test-owner" });
    const owners: Array<string | undefined> = [];
    const deps = {
      content: registry,
      resolveRoom: async () => ({
        exportCanvas: () => ({ ok: true as const, canvas })
      }),
      contentFrames: {
        matches: (type: string, data: unknown) =>
          type === "composite-asset" &&
          typeof data === "object" &&
          data !== null &&
          (data as { extensionId?: unknown }).extensionId === "test-owner",
        preparePreviewFrame: async (input: { read?: (storageKey: string) => Promise<unknown> }) => {
          await input.read?.("sha256-fixture");
          return { ok: false as const, code: "fixture-stop", message: "停止在读取之后" };
        },
        prepareHistoryFrame: async () => ({ ok: false as const, code: "unused", message: "unused" }),
        identityMatches: () => true
      },
      readMedia: async (_storageKey: string, _canvasId?: string, extensionId?: string) => {
        owners.push(extensionId);
        return { bytes: new Uint8Array([1]), contentType: "image/png" };
      }
    };

    const result = await renderPreview(deps as never, {
      get: () => undefined,
      set: () => undefined
    } as never, { canvasId: "canvas", nodeId: "owned" });

    expect(result).toMatchObject({ ok: false, code: "fixture-stop" });
    expect(owners).toEqual(["test-owner"]);
  });
});
