/**
 * 镜头参考服务端解析与校验测试（任务 8.6 / 8.7 / design D9）。
 *
 * 覆盖：归属校验、等待态、真实视频资产要求、版本信息一致、角色转成 reference_video，以及
 * `resolveNodeReferenceInputs` 端到端把镜头参考映射排入 `inputs`。
 */
import { describe, expect, it } from "vitest";
import {
  canonicalFilmSetFields,
  canonicalShotPreviewFields,
  createFilmSetSnapshot,
  createFilmSetGroupMarker,
  createEmptyWoohaa3ServerCanvas,
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
  freezeShotImageReferences, shotImageReferenceAssetId, createMotionSnapshot, type FrozenShotImageReference,
  SHOT_PREVIEW_SCHEMA_VERSION,
  shotPreviewNodeId,
  shotReferenceAssetMetadata,
  type CanvasNodeData,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { resolveNodeReferenceInputs } from "../task/input-resolution.js";
import {
  readShotReferenceLink,
  resolveShotReferenceAsset,
  verifyShotReferenceOwnership,
  withFrozenShotImages
} from "../task/shot-reference-resolution.js";

describe("authoritative static image input resolution", () => {
  function still() {
    const h = fixture(), decoded = decodeFilmSetNodeData(h.nodeData.film);
    if (!decoded.ok) throw new Error(decoded.reason);
    const animation = decoded.value, clip = animation.filmSetAnimations!.clips[0]!;
    animation.filmSetAnimations!.clips[0] = { ...clip, kind: "static", timeline: { duration: 0, loop: false }, bindings: [], cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }) };
    h.nodeData.film = canonicalFilmSetFields(animation) as never; h.mapping.role = "shot_image_reference";
    const refs = freezeShotImageReferences(h.canvas, "video", "#ffffff") as FrozenShotImageReference[], ref = refs[0]!;
    const asset: StoredAsset = { id: shotImageReferenceAssetId(ref), title: "PNG", source: "generated", mediaKind: "image", status: "ready", createdAt: "2026-10-23T00:00:00Z", metadata: { storageKey: "images/a.png", checksum: "a".repeat(64), contentType: "image/png", width: 1280, height: 720, background: "#ffffff", shotImageReference: ref } };
    h.canvas.assets.push(asset); h.mapping.sourceAssetIds = [asset.id];
    return { ...h, ref, refs, asset, animation };
  }
  const bindings = [{ field: "images", semantic: "reference-image" as const, roles: ["reference_image"], mediaKinds: ["image" as const], mediaTypes: ["image/png"], maxItems: 2, valueFormat: "reference" as const }];
  it("passes the registered PNG through the existing reference_image attachment channel", () => {
    const h = still();
    const result = resolveNodeReferenceInputs({ canvas: h.canvas, nodeId: "video", bindings });
    expect(result.blockingReasons).toEqual([]);
    expect(result.inputs).toEqual([{ assetId: h.asset.id, role: "reference_image", storageKey: "images/a.png", mediaType: "image/png", mediaKind: "image" }]);
  });
  it.each(["checksum", "storageKey", "width", "contentType", "mediaKind", "ownership"])("rejects invalid %s without passing a texture or preview identity", field => {
    const h = still();
    if (field === "mediaKind") h.asset.mediaKind = "video";
    else if (field === "ownership") (h.asset.metadata!.shotImageReference as Record<string, unknown>).filmSetNodeId = "wrong";
    else h.asset.metadata![field] = field === "width" ? 1 : field === "storageKey" ? "blob:temporary" : "invalid";
    const result = resolveNodeReferenceInputs({ canvas: h.canvas, nodeId: "video", bindings });
    expect(result.inputs).toEqual([]); expect(result.blockingReasons.length).toBeGreaterThan(0);
  });
  it("frozen A remains exact after B, never writes mappings and rejects reconnection or source deletion", () => {
    const h = still(), before = structuredClone(h.canvas.nodeData.video);
    h.animation.filmSetAnimations!.clips[0]!.initialCamera.azimuth += 1;
    h.canvas.nodeData.film = canonicalFilmSetFields(h.animation) as never;
    expect(resolveNodeReferenceInputs({ canvas: h.canvas, nodeId: "video", bindings }).inputs).toEqual([]);
    const execution = withFrozenShotImages(h.canvas, "video", h.refs); expect(typeof execution).toBe("object");
    if (typeof execution !== "string") expect(resolveNodeReferenceInputs({ canvas: execution, nodeId: "video", bindings, frozenShotImages: h.refs }).inputs[0]?.assetId).toBe(h.asset.id);
    expect(h.canvas.nodeData.video).toEqual(before);
    h.mapping.sourceNodeId = "another"; expect(typeof withFrozenShotImages(h.canvas, "video", h.refs)).toBe("string");
    h.mapping.sourceNodeId = h.previewId; h.canvas.document.nodes = h.canvas.document.nodes.filter(node => node.id !== "film");
    expect(typeof withFrozenShotImages(h.canvas, "video", h.refs)).toBe("string");
  });
});

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("c1") as ServerCanvas;
  const snapshot = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: `scene.box({ id: "body" });`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: `motion.model.rotate("body", { speed: 1 });`,
    timeline: { duration: 4, loop: false }
  });
  const decoded = decodeFilmSetNodeData(canonicalFilmSetFields(snapshot));
  if (!decoded.ok) throw new Error(decoded.reason);
  const clipId = filmSetAnimationsOf(decoded.value).clips[0]!.id;
  const previewId = shotPreviewNodeId("film", clipId);
  canvas.document.nodes.push(
    { id: "film", type: "composite-asset", position: { x: 0, y: 0 } } as never,
    { id: previewId, type: "film-set-shot-preview", position: { x: 100, y: 100 } } as never,
    { id: "video", type: "composite-asset", position: { x: 300, y: 0 } } as never
  );
  canvas.document.edges.push({ id: "e1", source: previewId, target: "video", data: { kind: "shot-reference", schemaVersion: 1 } } as never);
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData>;
  nodeData.film = canonicalFilmSetFields(snapshot) as unknown as CanvasNodeData;
  nodeData[previewId] = canonicalShotPreviewFields({
    shotPreview: { schemaVersion: SHOT_PREVIEW_SCHEMA_VERSION, filmSetNodeId: "film", clipId }
  }) as unknown as CanvasNodeData;
  const mapping = { slotId: "slot-1", sourceNodeId: previewId, role: "shot_reference", sortKey: "0", sourceAssetIds: [] as string[] };
  nodeData.video = { inputMapping: [mapping] } as unknown as CanvasNodeData;
  return { canvas, clipId, previewId, mapping, nodeData };
}

/** 片场组迁移后的镜头卡片：owner-managed 的 image/video 节点，不再写 `shotPreview`。 */
function managedFixture(nodeType: "video" | "image" = "video") {
  const owned = fixture();
  const film = owned.canvas.document.nodes.find((entry) => entry.id === "film")!;
  film.type = "group";
  owned.nodeData.film = { filmSetGroup: createFilmSetGroupMarker({ clips: [{ id: owned.clipId, duration: 4 }] }) } as never;
  const node = owned.canvas.document.nodes.find((entry) => entry.id === owned.previewId)!;
  node.type = nodeType;
  owned.nodeData[owned.previewId] = {
    managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "film", entityId: owned.clipId, lifecycle: "owner-managed" },
    mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: "film", clipId: owned.clipId } }
  } as never;
  return owned;
}

function videoAsset(id: string, link: { filmSetNodeId: string; clipId: string; contentIdentity: string; profileKey: string }): StoredAsset {
  return {
    id,
    title: "镜头参考",
    mediaKind: "video",
    source: "generated",
    status: "ready",
    createdAt: "2026-10-17T00:00:00.000Z",
    metadata: { storageKey: `${id}.mp4`, contentType: "video/mp4", ...shotReferenceAssetMetadata(link) }
  };
}

describe("verifyShotReferenceOwnership（归属校验）", () => {
  it("合法预览归属通过", () => {
    const { canvas, nodeData, previewId, clipId } = fixture();
    const result = verifyShotReferenceOwnership({ canvas, nodeData, sourceNodeId: previewId });
    expect(result).toEqual({ ok: true, filmSetNodeId: "film", clipId });
  });

  it("非预览来源、片场缺失、镜头删失都明确失败", () => {
    const { canvas, nodeData, previewId } = fixture();
    expect(verifyShotReferenceOwnership({ canvas, nodeData, sourceNodeId: "video" }).ok).toBe(false);
    const missingFilmSet = JSON.parse(JSON.stringify(canvas)) as ServerCanvas;
    missingFilmSet.document.nodes = missingFilmSet.document.nodes.filter((node) => node.id !== "film");
    expect(verifyShotReferenceOwnership({ canvas: missingFilmSet, nodeData, sourceNodeId: previewId }).ok).toBe(false);
  });

  it("片场组浮出的 owner-managed 镜头节点同样通过归属校验", () => {
    const { canvas, nodeData, previewId, clipId } = managedFixture();
    expect(verifyShotReferenceOwnership({ canvas, nodeData, sourceNodeId: previewId }))
      .toEqual({ ok: true, filmSetNodeId: "film", clipId });
    expect(resolveShotReferenceAsset({ canvas, nodeData, mapping: { slotId: "slot-1", sourceNodeId: previewId, role: "shot_reference", sortKey: "0", sourceAssetIds: [] } }))
      .toMatchObject({ ok: false, waiting: true });
  });

  it("托管节点类型与镜头 kind 不一致或缺少托管归属时明确失败", () => {
    const wrongType = managedFixture("image");
    expect(verifyShotReferenceOwnership({ canvas: wrongType.canvas, nodeData: wrongType.nodeData, sourceNodeId: wrongType.previewId }).ok).toBe(false);
    // 普通 image 节点 + 伪造 managedBy（mediaContent 不是 film-set.shot）不是镜头来源。
    const fake = managedFixture();
    fake.nodeData[fake.previewId] = { managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "film", entityId: fake.clipId, lifecycle: "owner-managed" } } as never;
    expect(verifyShotReferenceOwnership({ canvas: fake.canvas, nodeData: fake.nodeData, sourceNodeId: fake.previewId }).ok).toBe(false);
  });
});

describe("resolveShotReferenceAsset（等待/失败语义）", () => {
  it("尚无 sourceAssetIds 视为等待录制，不是硬失败", () => {
    const { canvas, nodeData, mapping } = fixture();
    const result = resolveShotReferenceAsset({ canvas, nodeData, mapping });
    expect(result).toMatchObject({ ok: false, waiting: true });
  });

  it("资产缺失/未就绪/非视频/缺少版本都硬失败，不偷换版本", () => {
    const { canvas, nodeData, mapping, clipId } = fixture();
    expect(resolveShotReferenceAsset({ canvas, nodeData, mapping: { ...mapping, sourceAssetIds: ["missing"] } })).toMatchObject({ ok: false, waiting: false });
    const link = { filmSetNodeId: "film", clipId, contentIdentity: "id-a", profileKey: "v1-1280x720@30" };
    canvas.assets.push({ ...videoAsset("a1", link), status: "generating" });
    expect(resolveShotReferenceAsset({ canvas, nodeData, mapping: { ...mapping, sourceAssetIds: ["a1"] } })).toMatchObject({ ok: false, waiting: false });
    canvas.assets.push({ ...videoAsset("a2", link), mediaKind: "image" });
    expect(resolveShotReferenceAsset({ canvas, nodeData, mapping: { ...mapping, sourceAssetIds: ["a2"] } })).toMatchObject({ ok: false, waiting: false });
    canvas.assets.push({ ...videoAsset("a3", link), metadata: { storageKey: "a3.mp4" } });
    expect(resolveShotReferenceAsset({ canvas, nodeData, mapping: { ...mapping, sourceAssetIds: ["a3"] } })).toMatchObject({ ok: false, waiting: false });
  });

  it("归属不一致的资产被拒绝", () => {
    const { canvas, nodeData, mapping, clipId } = fixture();
    canvas.assets.push(videoAsset("a4", { filmSetNodeId: "film", clipId: "other", contentIdentity: "id-a", profileKey: "p" }));
    expect(resolveShotReferenceAsset({ canvas, nodeData, mapping: { ...mapping, sourceAssetIds: ["a4"] } })).toMatchObject({ ok: false, waiting: false });
    void clipId;
  });

  it("就绪的同版本视频资产解析成功并带回版本信息", () => {
    const { canvas, nodeData, mapping, clipId } = fixture();
    const link = { filmSetNodeId: "film", clipId, contentIdentity: "id-a", profileKey: "v1-1280x720@30" };
    canvas.assets.push(videoAsset("a5", link));
    const result = resolveShotReferenceAsset({ canvas, nodeData, mapping: { ...mapping, sourceAssetIds: ["a5"] } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.asset.id).toBe("a5");
      expect(readShotReferenceLink(result.asset)).toEqual(link);
    }
  });
});

describe("resolveNodeReferenceInputs（端到端）", () => {
  const bindings = [{ field: "videoUrls", semantic: "reference-video" as const, roles: ["reference_video"], mediaKinds: ["video" as const], mediaTypes: ["video/mp4"], maxItems: 2, valueFormat: "reference" as const }];

  it("等待录制时给出阻塞原因且不产出输入", () => {
    const { canvas } = fixture();
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "video", bindings });
    expect(resolution.inputs).toHaveLength(0);
    expect(resolution.blockingReasons.join()).toContain("录制完成");
  });

  it("就绪时转成 reference_video 输入", () => {
    const { canvas, nodeData, mapping, clipId } = fixture();
    const link = { filmSetNodeId: "film", clipId, contentIdentity: "id-a", profileKey: "v1-1280x720@30" };
    canvas.assets.push(videoAsset("a6", link));
    (nodeData.video as { inputMapping: Array<Record<string, unknown>> }).inputMapping[0]!.sourceAssetIds = ["a6"];
    const resolution = resolveNodeReferenceInputs({ canvas, nodeId: "video", bindings });
    expect(resolution.blockingReasons).toHaveLength(0);
    expect(resolution.inputs).toHaveLength(1);
    expect(resolution.inputs[0]).toMatchObject({ assetId: "a6", role: "reference_video", mediaType: "video/mp4", mediaKind: "video" });
    void mapping;
  });
});
