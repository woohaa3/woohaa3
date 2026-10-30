import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { ContentContributionRegistry, type ContentNodeDataCodec } from "./content-contribution.js";

function passthrough(validate: (patch: Record<string, unknown>) => { code: string; reason: string } | null): ContentNodeDataCodec {
  return {
    decode: (data) => ({ ok: true, value: data }),
    validatePatch: (_previous, patch) => (typeof patch === "object" && patch !== null ? validate(patch as Record<string, unknown>) : { code: "invalid", reason: "invalid" }),
    normalize: (data) => data,
    sanitizeRuntime: (data) => data,
    copy: (data) => ({ data, assetRefs: [], remap: {} }),
    diff: (before, after) => ({ ok: true, forward: after, inverse: before })
  };
}

const refShape = (patch: Record<string, unknown>) => {
  const ref = patch.extensionContentRef;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return { code: "ref-invalid", reason: "ref-invalid" };
  const record = ref as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.instanceId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(record.instanceId)) {
    return { code: "ref-invalid", reason: "ref-invalid" };
  }
  if (patch.modelScript !== undefined || patch.modelScriptLanguage !== undefined || patch.modelScriptVersion !== undefined) {
    return { code: "ref-model-mixed", reason: "ref-model-mixed" };
  }
  return null;
};

function owners(): ContentContributionRegistry {
  const registry = new ContentContributionRegistry();
  registry.register({ extensionId: "creature-video-assets", nodeData: passthrough(refShape) });
  registry.register({
    extensionId: "game-furnace",
    nodeData: passthrough((patch) => ("extensionContentRef" in patch ? { code: "ref-forbidden", reason: "ref-forbidden" } : null))
  });
  return registry;
}


describe("复合资产扩展内容引用", () => {
  function canvas(extensionId: string) {
    const result = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-21T00:00:00Z");
    result.document.nodes.push({ id: "node", type: "composite-asset", position: { x: 0, y: 0 } });
    result.nodeData.node = { extensionId };
    return result;
  }
  const ref = { schemaVersion: 1, instanceId: "instance-123456" };
  it("允许内容引用业务 patch，且不虚构模型身份", () => {
    const result = applyCanvasCommands(canvas("creature-video-assets"), [{ type: "nodeData.patch", nodeId: "node", value: { extensionContentRef: ref } }], { content: owners() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canvas.nodeData.node.modelContentVersion).toBeUndefined();
  });
  it.each(["game-furnace", "unknown-extension"])("%s 不能以内容引用绕过自身校验", extensionId => {
    const result = applyCanvasCommands(canvas(extensionId), [{ type: "nodeData.patch", nodeId: "node", value: { extensionContentRef: ref } }], { content: owners() });
    expect(result.ok).toBe(false);
  });
  it("片场不能以内容引用绕过损坏的 items-only 内容", () => {
    const result = applyCanvasCommands(canvas("film-set"), [{ type: "nodeData.patch", nodeId: "node", value: { extensionContentRef: ref, filmSetContent: { version: 999, items: [] } } }], { content: owners() });
    expect(result.ok).toBe(false);
  });
  it.each([{ schemaVersion: 2, instanceId: "instance-123456" }, { schemaVersion: 1, instanceId: "short" }])("拒绝损坏的引用", extensionContentRef => {
    expect(applyCanvasCommands(canvas("creature-video-assets"), [{ type: "nodeData.patch", nodeId: "node", value: { extensionContentRef } }], { content: owners() }).ok).toBe(false);
  });
  it("引用业务不能混入模型内容", () => {
    expect(applyCanvasCommands(canvas("creature-video-assets"), [{ type: "nodeData.patch", nodeId: "node", value: { extensionContentRef: ref, modelScript: "scene.box({});" } }], { content: owners() }).ok).toBe(false);
  });
});
