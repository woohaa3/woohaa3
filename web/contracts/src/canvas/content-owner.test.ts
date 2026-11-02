import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { ContentContributionRegistry, decideContentWrite, type ContentNodeDataCodec } from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { normalizeCanvas } from "./domain/normalization.js";
import { sanitizeNodeDataForClipboard } from "./domain/runtime-node-data.js";
import { filmSetNodeDataCodec, filmSetContentContribution } from "./film-set-content.js";
import { createFilmSetGroupMarker } from "./film-set-group.js";
import { decodeAnimationPayload } from "./node-history/codec.js";

function filmCanvas(content: unknown) {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-27T00:00:00.000Z");
  canvas.document.nodes = [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, measured: undefined, data: {} } as never];
  canvas.nodeData = { film: { extensionId: "film-set", filmSetContent: content } as never };
  return canvas;
}

describe("owner codec 分派", () => {
  it("注册片场 codec 后，规范化结果与缺省路径一致", () => {
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    const valid = { schemaVersion: 4, items: [] };
    const invalid = { schemaVersion: 99, items: [] };
    expect(normalizeCanvas(filmCanvas(valid), { content: registry }).nodeData.film).toEqual(normalizeCanvas(filmCanvas(valid)).nodeData.film);
    expect(normalizeCanvas(filmCanvas(invalid), { content: registry }).nodeData.film).toEqual(normalizeCanvas(filmCanvas(invalid)).nodeData.film);
    expect(normalizeCanvas(filmCanvas(invalid)).nodeData.film).not.toHaveProperty("filmSetContent");
  });

  it("未知或伪造身份稳定拒绝，codec 异常不带出异常文本", () => {
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    expect(decideContentWrite("creature-video-assets", {}, { filmSetContent: { schemaVersion: 4, items: [] } }, registry)).toEqual({
      ok: false,
      extensionId: "creature-video-assets",
      code: "content-owner-unavailable"
    });
    const rejected = decideContentWrite("film-set", {}, { filmSetContent: { schemaVersion: 99 } }, registry);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("film-set-content-invalid");
    const throwing: ContentNodeDataCodec = {
      decode: () => ({ ok: true, value: {} }),
      validatePatch: () => { throw new Error("secret decoder detail"); },
      normalize: (data) => data,
      sanitizeRuntime: (data) => data,
      copy: (data) => ({ data, assetRefs: [], remap: {} }),
      diff: (before, after) => ({ ok: true, forward: after, inverse: before })
    };
    const broken = new ContentContributionRegistry();
    broken.register({ extensionId: "film-set", nodeData: throwing });
    expect(decideContentWrite("film-set", {}, {}, broken)).toEqual({ ok: false, extensionId: "film-set", code: "content-codec-failed" });
  });

  it("片场 group marker 形状由 owner codec 拒绝，合法 marker 仍要过归属检查", () => {
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    expect(filmSetNodeDataCodec.validatePatch({}, { filmSetGroup: { schemaVersion: 99, sceneBindings: [] } })).toEqual({
      code: "film-set-group-invalid",
      reason: "film-set-group-invalid"
    });
    expect(filmSetNodeDataCodec.validatePatch({}, { filmSetGroup: createFilmSetGroupMarker() })).toBeNull();

    const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-27T00:00:00.000Z");
    canvas.document.nodes = [{ id: "group", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300 }];
    const illegal = applyCanvasCommands(canvas, [{
      type: "nodeData.patch",
      nodeId: "group",
      value: { filmSetGroup: { schemaVersion: 99, sceneBindings: [] } as never }
    }], { content: registry });
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.rejection).toEqual({ code: "content-command-rejected", message: "film-set-group-invalid" });

    const forged = applyCanvasCommands(canvas, [{
      type: "nodeData.patch",
      nodeId: "group",
      value: { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "bad", sourceNodeId: "outside", kind: "model3d", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "k" }] }) }
    }], { content: registry });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.rejection.code).toBe("invalid-film-set-group");
  });

  it("复制片场 group 时重写来源和镜头，并丢掉已脱离的绑定", () => {
    const playback = { startTime: 0, duration: 1, timeScale: 1, loop: false };
    const marker = createFilmSetGroupMarker({
      sceneBindings: [
        { bindingId: "leg", sourceNodeId: "model", kind: "model3d", transform: { x: 1, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "k" },
        { bindingId: "gone", sourceNodeId: "outside", kind: "image", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "k", detached: true }
      ],
      clips: [{ id: "clip-a", duration: 1, bindings: [
        { itemId: "leg", playback },
        { itemId: "gone", playback }
      ] }],
      activeClip: "clip-a",
      migration: { version: 1, commandId: "cmd-1", sourceNodeId: "legacy" }
    });
    const copied = filmSetNodeDataCodec.copy({ filmSetGroup: marker }, {
      nodeIds: new Map([["model", "model-2"]]),
      createId: (prefix, index) => `${prefix}-${index}`
    });
    const group = (copied.data as { filmSetGroup: ReturnType<typeof createFilmSetGroupMarker> }).filmSetGroup;
    expect(group.sceneBindings).toEqual([
      expect.objectContaining({ bindingId: "film-binding-0", sourceNodeId: "model-2" })
    ]);
    expect(group.clips?.[0]).toEqual(expect.objectContaining({
      id: "clip-0",
      bindings: [expect.objectContaining({ itemId: "film-binding-0" })]
    }));
    expect(group.activeClip).toBe("clip-0");
    expect(group.migration).toBeUndefined();
    expect(copied.remap).toEqual({ "binding:leg": "film-binding-0", "clip:clip-a": "clip-0" });
    expect(() => filmSetNodeDataCodec.copy({ filmSetGroup: marker }, {
      nodeIds: new Map(),
      createId: (prefix, index) => `${prefix}-${index}`
    })).toThrow("content-copy-source-missing");
  });

  it("历史里的片场 group 由 owner codec 解码，owner 失败不再回退内核", () => {
    const marker = createFilmSetGroupMarker();
    expect(filmSetNodeDataCodec.decode({ filmSetGroup: marker }).ok).toBe(true);
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    expect(decodeAnimationPayload({ schemaVersion: 4, filmSetGroup: marker }, { content: registry })).toEqual({
      schemaVersion: 4,
      filmSetGroup: marker
    });
    const rejecting = new ContentContributionRegistry();
    rejecting.register({
      extensionId: "film-set",
      nodeData: { ...filmSetNodeDataCodec, decode: () => { throw new Error("secret history detail"); } }
    });
    expect(decodeAnimationPayload({ schemaVersion: 4, filmSetGroup: marker }, { content: rejecting })).toBeNull();
    expect(decodeAnimationPayload({ schemaVersion: 4, filmSetGroup: { schemaVersion: 99, sceneBindings: [] } }, { content: registry })).toBeNull();

    const legacy = {
      schemaVersion: 3,
      scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      sceneCamera: { azimuth: 0, elevation: 0.4, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
      filmSetContent: { schemaVersion: 4, items: [] },
      filmSetAnimations: { schemaVersion: 3, defaultClipId: null, clips: [] }
    };
    const kernel = decodeAnimationPayload(legacy);
    expect(kernel?.schemaVersion).toBe(3);
    expect(decodeAnimationPayload(legacy, { content: registry })).toEqual(kernel);
    const throwingContent = new ContentContributionRegistry();
    throwingContent.register({
      extensionId: "film-set",
      nodeData: { ...filmSetNodeDataCodec, decode: () => { throw new Error("secret schema3 detail"); } }
    });
    expect(decodeAnimationPayload(legacy, { content: throwingContent })).toBeNull();
  });

  it("传入片场 codec 时，新建旧 composite 与对象容器由 owner 拒绝", () => {
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-11-02T00:00:00.000Z");
    const add = (nodeData: Record<string, unknown>, content: ContentContributionRegistry = registry) => applyCanvasCommands(canvas, [{
      type: "node.add",
      node: { id: "film", type: "composite-asset", position: { x: 0, y: 0 } },
      nodeData: nodeData as never
    }], { content });
    const legacy = add({ extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [] } });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.rejection).toEqual({ code: "content-command-rejected", message: "film-set-legacy-retired" });
    const container = add({
      extensionId: "film-set",
      compositeAssetRole: "object-container",
      filmSetObject: { schemaVersion: 1, filmSetNodeId: "film", itemId: "actor" }
    });
    expect(container.ok).toBe(false);
    if (!container.ok) expect(container.rejection).toEqual({ code: "content-command-rejected", message: "film-set-legacy-retired" });
    const kernel = applyCanvasCommands(canvas, [{
      type: "node.add",
      node: { id: "film", type: "composite-asset", position: { x: 0, y: 0 } },
      nodeData: { extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [] } }
    }]);
    expect(kernel.ok).toBe(false);
    if (!kernel.ok) expect(kernel.rejection.code).toBe("invalid-self-contained-node");

    const existing = createEmptyWoohaa3ServerCanvas("canvas", "2026-11-02T00:00:00.000Z");
    existing.document.nodes = [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, measured: undefined, data: {} } as never];
    existing.nodeData = { film: { extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [] } } as never };
    const patched = applyCanvasCommands(existing, [{ type: "nodeData.patch", nodeId: "film", value: { title: "changed" } }], { content: registry });
    expect(patched.ok).toBe(false);
    if (!patched.ok) expect(patched.rejection).toEqual({ code: "content-command-rejected", message: "film-set-legacy-retired" });

    const group = applyCanvasCommands(canvas, [{
      type: "node.add",
      node: { id: "group", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300 },
      nodeData: { filmSetGroup: createFilmSetGroupMarker() }
    }], { content: registry });
    expect(group.ok).toBe(true);

    const throwing = new ContentContributionRegistry();
    throwing.register({
      extensionId: "film-set",
      nodeData: { ...filmSetNodeDataCodec, rejectLegacy: () => { throw new Error("secret legacy detail"); } }
    });
    const failed = add({ extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [] } }, throwing);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.rejection).toEqual({ code: "content-codec-failed", message: "content-codec-failed" });
      expect(JSON.stringify(failed.rejection)).not.toContain("secret");
    }
  });

  it("传入片场 codec 时，剪贴板丢掉迁移标记和已脱离的绑定", () => {
    const playback = { startTime: 0, duration: 1, timeScale: 1, loop: false };
    const marker = createFilmSetGroupMarker({
      sceneBindings: [
        { bindingId: "leg", sourceNodeId: "model", kind: "model3d", transform: { x: 1, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "k" },
        { bindingId: "gone", sourceNodeId: "outside", kind: "image", transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true, contentKey: "k", detached: true }
      ],
      clips: [{ id: "clip-a", duration: 1, bindings: [
        { itemId: "leg", playback },
        { itemId: "gone", playback }
      ] }],
      activeClip: "clip-a",
      migration: { version: 1, commandId: "cmd-1", sourceNodeId: "legacy" }
    });
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    const cleaned = sanitizeNodeDataForClipboard({ filmSetGroup: marker, activeRunId: "run" }, { content: registry });
    const group = cleaned.filmSetGroup as ReturnType<typeof createFilmSetGroupMarker>;
    expect(group.migration).toBeUndefined();
    expect(group.sceneBindings.map((binding) => binding.bindingId)).toEqual(["leg"]);
    expect(group.clips?.[0]?.bindings?.map((binding) => binding.itemId)).toEqual(["leg"]);
    expect(group.activeClip).toBe("clip-a");
    expect(cleaned).not.toHaveProperty("activeRunId");
    const kernel = sanitizeNodeDataForClipboard({ filmSetGroup: marker, activeRunId: "run" });
    expect(kernel.filmSetGroup).toMatchObject({ migration: marker.migration });
    expect((kernel.filmSetGroup as { sceneBindings: unknown[] }).sceneBindings).toHaveLength(2);

    const throwing = new ContentContributionRegistry();
    throwing.register({
      extensionId: "film-set",
      nodeData: {
        ...filmSetNodeDataCodec,
        sanitizeRuntime: () => { throw new Error("secret clipboard detail"); }
      }
    });
    expect(() => sanitizeNodeDataForClipboard({ filmSetGroup: marker }, { content: throwing })).toThrow(/^content-codec-failed$/);
  });

  it("传入片场 codec 时，剪贴板丢掉非法的旧 filmSetContent", () => {
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    const cleaned = sanitizeNodeDataForClipboard({
      extensionId: "film-set",
      title: "片场",
      filmSetContent: { schemaVersion: 99, items: [] }
    }, { content: registry });
    expect(cleaned).not.toHaveProperty("filmSetContent");
    expect(cleaned).toMatchObject({ extensionId: "film-set", title: "片场" });
    const valid = { extensionId: "film-set", filmSetContent: { schemaVersion: 4, items: [] } };
    expect(sanitizeNodeDataForClipboard(valid, { content: registry })).toEqual(filmSetNodeDataCodec.normalize(valid));
  });
});
