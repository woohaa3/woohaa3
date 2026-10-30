import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, createEmptyWoohaa3ServerCanvas, type ContentNodeDataCodec } from "@woohaa3/contracts";
import { buildCanvasCopyPayload } from "./payload.js";
const codec: ContentNodeDataCodec = {
  decode: value => ({ ok: true, value }), validatePatch: () => null, normalize: value => value,
  sanitizeRuntime: value => { const result = { ...(value as Record<string, unknown>) }; delete result.secretRuntime; return result; },
  copy: data => ({ data, assetRefs: [], remap: {} }), diff: () => ({ ok: true, forward: {}, inverse: {} })
};
describe("owner clipboard sanitation", () => {
  it("uses the owner sanitizer and refuses unavailable owners or sanitizer failures", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    canvas.document.nodes.push({ id: "owner", type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData.owner = { extensionId: "test.content", secretRuntime: "private", savedValue: "keep" } as never;
    const content = new ContentContributionRegistry();
    const release = content.register({ extensionId: "test.content", nodeData: codec });
    expect(buildCanvasCopyPayload(canvas, ["owner"], { content })?.nodeData.owner).toMatchObject({ savedValue: "keep" });
    expect(buildCanvasCopyPayload(canvas, ["owner"], { content })?.nodeData.owner).not.toHaveProperty("secretRuntime");
    release();
    expect(buildCanvasCopyPayload(canvas, ["owner"], { content })).toBeNull();
    content.register({ extensionId: "test.content", nodeData: { ...codec, sanitizeRuntime: () => { throw Error("private"); } } });
    expect(buildCanvasCopyPayload(canvas, ["owner"], { content })).toBeNull();
    expect(canvas.nodeData.owner).toHaveProperty("secretRuntime", "private");
  });
});
