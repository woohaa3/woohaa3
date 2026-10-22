import { nativeFilmSetFrame } from "../src/preview/backend/native-frame.js";
/**
 * 镜头参考冻结与登记测试（任务 8.6 / design D9）。
 *
 * 覆盖：未就绪只等待、就绪时幂等登记资产与 sourceAssetIds、失效映射明确跳过、不写预览节点。
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
  type CanvasNodeData,
  type ServerCanvas
} from "@woohaa3/contracts";
import { freezeFilmSetRecording, planFilmSetRecordingCommit } from "../src/authoring/backend/recording-compile.js";
import { ShotReferenceVersionCache, hydrateShotReferenceCacheFromCanvas } from "../src/authoring/browser/shot-reference-version-cache.js";
import { planShotReferenceFreeze } from "../src/authoring/browser/shot-reference-canonical.js";

const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

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
    { id: previewId, type: "film-set-shot-preview", position: { x: 50, y: 50 } } as never,
    { id: "video", type: "composite-asset", position: { x: 200, y: 0 } } as never
  );
  canvas.document.edges.push({ id: "e1", source: previewId, target: "video", data: { kind: "shot-reference", schemaVersion: 1 } } as never);
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData>;
  nodeData.film = canonicalFilmSetFields(snapshot) as unknown as CanvasNodeData;
  nodeData[previewId] = canonicalShotPreviewFields({
    shotPreview: { schemaVersion: SHOT_PREVIEW_SCHEMA_VERSION, filmSetNodeId: "film", clipId }
  }) as unknown as CanvasNodeData;
  nodeData.video = { inputMapping: [{ slotId: "slot-1", sourceNodeId: previewId, role: "shot_reference", sortKey: "0" }] } as unknown as CanvasNodeData;
  return { canvas, clipId, previewId, nodeData };
}

describe("planShotReferenceFreeze（冻结与登记）", () => {
  it("原生参考成片按下游身份回填，刷新后可冻结且不再等待", () => {
    const { canvas, clipId, nodeData } = fixture();
    const frozen = freezeFilmSetRecording({ prepareFrame: nativeFilmSetFrame,
      request: { requestId: "native-reference", purpose: "reference", canvasId: canvas.id,
        nodeId: "film", clipId, profileKey: "" },
      nodeData: nodeData.film!, assets: [], canvasRevision: 1, sourceIncarnation: "i1"
    });
    if (!frozen.ok) throw new Error(frozen.message);
    const committed = planFilmSetRecordingCommit({ request: {
      requestId: "native-reference", purpose: "reference", canvasId: canvas.id, nodeId: "film", clipId, title: "参考",
      sourceIncarnation: "i1", contentIdentity: "native-worker-content-identity",
      profileKey: frozen.snapshot.profile.profileKey, referenceIdentity: frozen.referenceIdentity,
      artifact: { storageKey: STORAGE_KEY, checksum: CHECKSUM, mimeType: "video/mp4", sizeBytes: 9,
        width: 1280, height: 720, durationSeconds: 4, frameRate: 30, hasAudio: false }
    }, now: () => "2026-10-18T00:00:00.000Z" });
    if (!committed.ok) throw new Error(committed.message);
    expect(committed.commands).toHaveLength(1);
    for (const command of committed.commands) if (command.type === "asset.upsert") canvas.assets.push(command.asset);
    const cache = new ShotReferenceVersionCache();
    expect(hydrateShotReferenceCacheFromCanvas(cache, JSON.parse(JSON.stringify(canvas)))).toBe(1);
    const plan = planShotReferenceFreeze({ canvas, readyAsset: ref => cache.readyAsset(ref), now: () => "t" });
    expect(plan.waiting).toHaveLength(0);
    expect(plan.commands.filter(command => command.type === "asset.upsert")).toHaveLength(0);
    const patch = plan.commands.find(command => command.type === "nodeData.patch");
    expect(patch?.type === "nodeData.patch" && patch.value?.inputMapping?.[0]?.sourceAssetIds).toEqual([canvas.assets[0]!.id]);
  });

  it("未就绪只等待，不产出任何命令", () => {
    const { canvas } = fixture();
    const plan = planShotReferenceFreeze({ canvas, readyAsset: () => null, now: () => "t" });
    expect(plan.commands).toHaveLength(0);
    expect(plan.waiting).toHaveLength(1);
    expect(plan.invalid).toHaveLength(0);
  });

  it("就绪时登记资产并写入 sourceAssetIds，重复规划幂等", () => {
    const { canvas, nodeData, previewId } = fixture();
    const ready = () => ({ storageKey: STORAGE_KEY, checksum: CHECKSUM, mediaType: "video/mp4", size: 9 });
    const plan = planShotReferenceFreeze({ canvas, readyAsset: ready, now: () => "2026-10-17T00:00:00.000Z" });
    expect(plan.waiting).toHaveLength(0);
    const upsert = plan.commands.find((command) => command.type === "asset.upsert");
    const patch = plan.commands.find((command) => command.type === "nodeData.patch");
    expect(upsert).toBeDefined();
    expect(patch).toBeDefined();
    if (upsert?.type === "asset.upsert") {
      expect(upsert.asset.mediaKind).toBe("video");
      expect(upsert.asset.status).toBe("ready");
      expect(upsert.asset.metadata?.storageKey).toBe(STORAGE_KEY);
      expect(upsert.asset.metadata?.checksum).toBe(CHECKSUM);
      expect(upsert.asset.id).toContain("shot-reference-video:");
    }
    if (patch?.type === "nodeData.patch" && upsert?.type === "asset.upsert") {
      const mapping = (patch.value as CanvasNodeData).inputMapping!.find((entry) => entry.slotId === "slot-1");
      expect(mapping?.sourceAssetIds).toEqual([upsert.asset.id]);
    }
    // 预览节点不被改写。
    expect(canvas.nodeData[previewId]).toBe(nodeData[previewId]);
  });

  it("已冻结的映射不再产出命令（幂等）", () => {
    const { canvas, clipId } = fixture();
    const ready = () => ({ storageKey: STORAGE_KEY, checksum: CHECKSUM, mediaType: "video/mp4", size: 9 });
    const first = planShotReferenceFreeze({ canvas, readyAsset: ready, now: () => "t" });
    // 模拟命令已提交：应用 patch 与 asset。
    for (const command of first.commands) {
      if (command.type === "nodeData.patch" && command.value) (canvas.nodeData as Record<string, CanvasNodeData>)[command.nodeId] = command.value;
      if (command.type === "asset.upsert") canvas.assets.push(command.asset);
    }
    const second = planShotReferenceFreeze({ canvas, readyAsset: ready, now: () => "t" });
    expect(second.commands).toHaveLength(0);
    void clipId;
  });

  it("来源不是预览节点时明确跳过", () => {
    const { canvas, nodeData, previewId } = fixture();
    (nodeData.video as { inputMapping: Array<Record<string, unknown>> }).inputMapping[0]!.sourceNodeId = "not-preview";
    const plan = planShotReferenceFreeze({ canvas, readyAsset: () => null, now: () => "t" });
    expect(plan.waiting).toHaveLength(0);
    expect(plan.invalid).toHaveLength(1);
    void previewId;
  });

  it("没有镜头参考映射的画布不产出命令", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c2") as ServerCanvas;
    canvas.document.nodes.push({ id: "plain", type: "custom", position: { x: 0, y: 0 } } as never);
    const plan = planShotReferenceFreeze({ canvas, readyAsset: () => null, now: () => "t" });
    expect(plan).toEqual({ commands: [], waiting: [], invalid: [] });
  });
});
