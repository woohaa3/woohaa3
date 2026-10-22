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
  createEmptyWoohaa3ServerCanvas,
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
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
  verifyShotReferenceOwnership
} from "../task/shot-reference-resolution.js";

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
    expect(resolution.blockingReasons.join()).toContain("等待中");
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
