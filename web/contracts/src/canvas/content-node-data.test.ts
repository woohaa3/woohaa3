import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, type ContentNodeDataCodec } from "./content-contribution.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { normalizeCanvas } from "./domain/normalization.js";

const codec: ContentNodeDataCodec = {
  decode: data => ({ ok: true, value: data }),
  validatePatch: (_previous, patch) => typeof (patch as { recipe?: unknown })?.recipe === "number"
    ? null : { code: "recipe-invalid", reason: "recipe-invalid" },
  normalize: data => ({ ...(data as object), normalized: true }),
  sanitizeRuntime: data => data,
  copy: data => ({ data, assetRefs: [], remap: {} }),
  diff: (before, after) => ({ ok: true, forward: after, inverse: before })
};
function canvas() {
  const value = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-30T00:00:00.000Z");
  value.document.nodes = [{ id: "owned", type: "composite-asset", position: { x: 0, y: 0 } }];
  value.nodeData.owned = { extensionId: "test-recipe", recipe: 1 };
  return value;
}
function registry(implementation = codec) {
  const content = new ContentContributionRegistry();
  content.register({ extensionId: "test-recipe", nodeData: implementation });
  return content;
}
describe("registered node data owner", () => {
  it("validates and normalizes an arbitrary registered composite on patch", () => {
    const result = applyCanvasCommands(canvas(), [{ type: "nodeData.patch", nodeId: "owned", value: { recipe: 2 } }], { content: registry() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canvas.nodeData.owned).toEqual({ extensionId: "test-recipe", recipe: 2, normalized: true });
  });
  it("keeps owner fields through final commit normalization", () => {
    const result = applyCanvasCommands(canvas(), [{ type: "nodeData.patch", nodeId: "owned", value: { recipe: 2, filmSetContent: { opaque: true } } }], { content: registry() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canvas.nodeData.owned.filmSetContent).toEqual({ opaque: true });
  });
  it("rejects absent owners and identity replacement atomically", () => {
    const original = canvas();
    const unknown = applyCanvasCommands(original, [{ type: "nodeData.patch", nodeId: "owned", value: { recipe: 2 } }], { content: new ContentContributionRegistry() });
    expect(unknown).toMatchObject({ ok: false, rejection: { code: "content-owner-unavailable" } });
    const replacement = applyCanvasCommands(original, [{ type: "nodeData.patch", nodeId: "owned", value: { extensionId: "other", recipe: 2 } }], { content: registry() });
    expect(replacement).toMatchObject({ ok: false, rejection: { code: "content-owner-unavailable" } });
    expect(original.nodeData.owned.recipe).toBe(1);
  });
  it("cannot bypass owner availability or full validation through field removal", () => {
    const original = canvas();
    original.nodeData.owned.projectStorageKey = "project-key";
    const command = { type: "edit.apply" as const, preconditions: [], operations: [{ kind: "node-data-unset" as const, nodeId: "owned", fields: ["projectStorageKey" as const] }] };
    expect(applyCanvasCommands(original, [command], { content: new ContentContributionRegistry() })).toMatchObject({ ok: false, rejection: { code: "content-owner-unavailable" } });
    const required: ContentNodeDataCodec = { ...codec, validatePatch: () => null, decode: data => (data as Record<string, unknown>).projectStorageKey !== undefined
      ? { ok: true, value: data } : { ok: false, code: "recipe-content-required", reason: "recipe-content-required" } };
    expect(applyCanvasCommands(original, [command], { content: registry(required) })).toMatchObject({ ok: false, rejection: { code: "content-command-rejected", message: "recipe-content-required" } });
    expect(original.nodeData.owned.projectStorageKey).toEqual("project-key");
  });
  it("allows owner-approved removal without merging back deleted fields", () => {
    const original = canvas();
    original.nodeData.owned.projectStorageKey = "project-key";
    const command = { type: "edit.apply" as const, preconditions: [], operations: [{ kind: "node-data-unset" as const, nodeId: "owned", fields: ["projectStorageKey" as const] }] };
    const result = applyCanvasCommands(original, [command], { content: registry({ ...codec, validatePatch: () => null }) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canvas.nodeData.owned).not.toHaveProperty("projectStorageKey");
  });
  it("cannot bypass owner validation by creating a node", () => {
    const result = applyCanvasCommands(canvas(), [{ type: "node.add", node: { id: "new", type: "composite-asset", position: { x: 0, y: 0 } }, nodeData: { extensionId: "test-recipe", recipe: "wrong" } }], { content: registry() });
    expect(result).toMatchObject({ ok: false, rejection: { code: "content-command-rejected", message: "recipe-invalid" } });
  });
  it("normalizes owner content without requiring a built-in business field", () => {
    expect(normalizeCanvas(canvas(), { content: registry() }).nodeData.owned).toEqual({ extensionId: "test-recipe", recipe: 1, normalized: true });
  });
  it("does not invoke a composite owner on unrelated node types", () => {
    const original = canvas();
    original.document.nodes[0]!.type = "image";
    original.nodeData.owned.filmSetContent = { opaque: true };
    original.nodeData.owned.extensionId = "film-set";
    const throwing = { ...codec, normalize: () => { throw Error("private diagnostic"); } };
    const content = new ContentContributionRegistry();
    content.register({ extensionId: "film-set", nodeData: throwing });
    const normalized = normalizeCanvas(original, { content });
    expect(normalized.nodeData.owned).not.toHaveProperty("filmSetContent");
    expect(normalized.nodeData.owned.recipe).toBe(1);
  });
  it("preserves unknown and failed owner data when reading", () => {
    expect(normalizeCanvas(canvas(), { content: new ContentContributionRegistry() }).nodeData.owned).toEqual(canvas().nodeData.owned);
    const throwing = { ...codec, normalize: () => { throw Error("private diagnostic"); } };
    expect(normalizeCanvas(canvas(), { content: registry(throwing) }).nodeData.owned).toEqual(canvas().nodeData.owned);
  });
  it("requires the merged normalized state to pass the owner decoder", () => {
    const invalid: ContentNodeDataCodec = { ...codec,
      validatePatch: () => null,
      decode: () => ({ ok: false, code: "recipe-shape-invalid", reason: "private diagnostic" })
    };
    expect(applyCanvasCommands(canvas(), [{ type: "nodeData.patch", nodeId: "owned", value: { recipe: 2 } }], { content: registry(invalid) }))
      .toMatchObject({ ok: false, rejection: { code: "content-command-rejected", message: "recipe-shape-invalid" } });
  });
  it("protects original nested data when a failing codec mutates its input", () => {
    const original = canvas();
    original.nodeData.owned.config = { count: 1 };
    const mutating: ContentNodeDataCodec = {
      ...codec,
      validatePatch(previous) {
        (previous as { config: { count: number } }).config.count = 99;
        throw Error("private diagnostic");
      }
    };
    expect(applyCanvasCommands(original, [{ type: "nodeData.patch", nodeId: "owned", value: { recipe: 2 } }], { content: registry(mutating) }).ok).toBe(false);
    expect(original.nodeData.owned.config).toEqual({ count: 1 });
  });
  it("rejects non-JSON output from a trusted codec", () => {
    const invalid = { ...codec, normalize: () => ({ extensionId: "test-recipe", recipe: new Date() }) };
    expect(applyCanvasCommands(canvas(), [{ type: "nodeData.patch", nodeId: "owned", value: { recipe: 2 } }], { content: registry(invalid) })).toMatchObject({ ok: false, rejection: { code: "content-codec-failed" } });
  });
  it("contains owner exceptions and rejects invalid normalized identity", () => {
    for (const implementation of [
      { ...codec, validatePatch: () => { throw Error("private diagnostic"); } },
      { ...codec, normalize: () => ({ extensionId: "other" }) }
    ]) {
      const result = applyCanvasCommands(canvas(), [{ type: "nodeData.patch", nodeId: "owned", value: { recipe: 2 } }], { content: registry(implementation) });
      expect(result).toMatchObject({ ok: false, rejection: { code: "content-codec-failed" } });
      expect(JSON.stringify(result)).not.toContain("private diagnostic");
    }
  });
});
