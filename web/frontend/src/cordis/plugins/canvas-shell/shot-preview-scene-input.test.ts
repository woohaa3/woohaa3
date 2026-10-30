import { describe, expect, it } from "vitest";
import { createFilmSetGroupMarker, shotPreviewNodeId, staticShotCameraMotion, type ServerCanvas } from "@woohaa3/contracts";
import { buildContentPresentationSceneInput, shotPreviewLinkOrigin } from "./shot-preview-scene-input.js";

// 「主用」画布上的真实片场徽标（group 高 2017.25、倍率 12.63 → 1110×808，画布坐标）。
const badge = { center: { x: 747.875, y: 4237.37 } };

describe("shotPreviewLinkOrigin", () => {
  it("片场 group 的归属线起点取徽标中心，不跟随相机姿态", () => {
    // 相机悬在场景上方，投影落在徽标上方的组气泡里（y 3707，徽标上缘 3833）。
    expect(shotPreviewLinkOrigin(badge, { x: 858, y: 3707 })).toEqual({ x: 747.875, y: 4237.37 });
  });

  it("相机投影缺失时仍能给出起点（徽标就是场景入口）", () => {
    expect(shotPreviewLinkOrigin(badge, null)).toEqual({ x: 747.875, y: 4237.37 });
  });

  it("没有外部徽标的复合资产片场退回相机姿态投影", () => {
    expect(shotPreviewLinkOrigin(null, { x: 120, y: -40 })).toEqual({ x: 120, y: -40 });
  });

  it("既无徽标也无相机投影时不画线", () => {
    expect(shotPreviewLinkOrigin(null, null)).toBeNull();
  });
});

describe("buildContentPresentationSceneInput 归属线起点", () => {
  const groupId = "film-group";
  const clipId = "clip-1";
  const previewId = shotPreviewNodeId(groupId, clipId);
  const marker = createFilmSetGroupMarker({
    sceneBindings: [],
    cameras: [{ id: `camera:${clipId}`, name: "运镜", azimuth: 0, elevation: 0.35, distance: 4, focusOffset: { x: 0, y: 0, z: 0 }, aspect: "16:9" }],
    clips: [{ id: clipId, name: "运镜", cameraId: `camera:${clipId}`, duration: 4, loop: false, cameraMotion: staticShotCameraMotion(), bindings: [] }],
    activeClip: clipId
  });
  const canvas = {
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [
        { id: groupId, type: "group", position: { x: 100, y: 60 }, width: 320, height: 240 },
        { id: previewId, type: "video", position: { x: 560, y: 60 }, width: 240, height: 167 }
      ],
      edges: [],
      updatedAt: "2026-10-15T00:00:00.000Z"
    },
    nodeData: {
      [groupId]: { filmSetGroup: marker },
      [previewId]: {
        managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: groupId, entityId: clipId, lifecycle: "owner-managed" },
        mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: groupId, clipId } }
      }
    }
  } as unknown as ServerCanvas;

  const originOf = (badgeScaleOverrides?: ReadonlyMap<string, number>) => {
    const input = buildContentPresentationSceneInput({ canvas, playback: null, targets: [], badgeScaleOverrides });
    const origin = input.entityAnchorProjection(groupId, clipId);
    expect(origin).not.toBeNull();
    return origin!;
  };

  it("线头固定在徽标中心：水平中线不变，倍率只沿中线向下扩展", () => {
    const base = originOf();
    const scaled = originOf(new Map([[groupId, 2]]));
    expect(scaled.x).toBeCloseTo(base.x, 5);
    expect(scaled.y).toBeGreaterThan(base.y);
  });

  it("拖动中的倍率预览立即移动线头，不必等提交回 nodeData", () => {
    const committed = { ...(canvas.nodeData[groupId] as Record<string, unknown>) };
    const before = originOf();
    (canvas.nodeData as Record<string, unknown>)[groupId] = { ...committed, groupBadgeScale: 2 };
    expect(originOf()).toEqual(originOf(new Map([[groupId, 2]])));
    (canvas.nodeData as Record<string, unknown>)[groupId] = committed;
    expect(originOf().y).toBeCloseTo(before.y, 5);
  });
});
