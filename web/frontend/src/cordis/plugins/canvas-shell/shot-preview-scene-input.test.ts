import { describe, expect, it } from "vitest";
import {
  createFilmSetGroupMarker,
  groupBadgeRect,
  groupModelProjection,
  shotPreviewNodeId,
  staticShotCameraMotion,
  type ServerCanvas,
  type SceneV2Op
} from "@woohaa3/contracts";
import { buildShotPreviewSceneInput, shotPreviewLinkOrigin } from "./shot-preview-scene-input.js";
import type { FocusTargetInput } from "./model-focus-session.js";

// 「主用」画布上的真实片场徽标（组结构底边中点向下 40 画布单位）。
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

describe("buildShotPreviewSceneInput 归属线起点", () => {
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

  const box = (size: [number, number, number]): SceneV2Op =>
    ({ t: "box", id: "b", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size, color: "#ffffff" }) as SceneV2Op;

  const targetOf = (scale = 1): FocusTargetInput => ({
    canvas,
    nodeId: groupId,
    viewport: { x: 0, y: 0, zoom: 1 },
    surface: { width: 1000, height: 800 },
    sceneVersion: "woohaa-model-scene-ir-v2",
    ops: [box([1, 1, 1])],
    extent: 2,
    placement: { offset: { x: 0, y: 0, z: 0 }, scale, yaw: 0 }
  });

  const originOf = (scale = 1, targets: readonly FocusTargetInput[] = [targetOf(scale)]) => {
    const input = buildShotPreviewSceneInput({ canvas, playback: null, targets });
    return input.shotPreviewCameraProjection(groupId, clipId);
  };

  it("镜头来源变化时立即显示实时预览，直到对应版本媒体就绪", () => {
    let sourceIdentity = "before";
    let status: "ready" | "pending" = "ready";
    let cachedIdentity = "before";
    const mediaContent = {
      describe: () => ({ sourceIdentity, mediaKind: "video", dependencyNodeIds: [] }),
      state: () => ({ status, sourceIdentity: cachedIdentity, asset: { id: "asset", status: "ready" } })
    } as unknown as import("../../../extension-api/media-content.js").MediaContentService;
    const state = () => buildShotPreviewSceneInput({ canvas, playback: null, targets: [], mediaContent }).shotPreviews.get(previewId)?.state;
    expect(state()).toBe("ready");
    sourceIdentity = "after";
    expect(state()).toBe("stale");
    cachedIdentity = "after";
    status = "pending";
    expect(state()).toBe("stale");
    status = "ready";
    expect(state()).toBe("ready");
  });

  it("线头固定在徽标中心：片场组与普通组同一单位，越大倍率越高", () => {
    const target = targetOf(1);
    const projection = groupModelProjection({
      sceneVersion: target.sceneVersion,
      ops: target.ops as never,
      extent: target.extent,
      aabb: target.aabb ?? undefined,
      placement: target.placement,
      badgeTopAnchored: true
    })!;
    const expected = groupBadgeRect({ x: 100, y: 60, width: 320, height: 240 }, projection)!;

    const base = originOf(1)!;
    const scaled = originOf(3)!;
    expect(expected.y).toBeCloseTo(60 + 240 + 40, 5);
    expect(base.x).toBeCloseTo(expected.center.x, 5);
    expect(base.y).toBeCloseTo(expected.center.y, 5);
    // 不再按组宽取景：placement.scale 直接参与徽标尺寸，倍率 3 的徽标高 3 倍、锚点随之下移。
    const triple = groupBadgeRect({ x: 100, y: 60, width: 320, height: 240 },
      groupModelProjection({
        sceneVersion: target.sceneVersion,
        ops: target.ops as never,
        extent: target.extent,
        aabb: target.aabb ?? undefined,
        placement: { ...target.placement!, scale: 3 },
        badgeTopAnchored: true
      })!)!;
    expect(triple.height).toBeCloseTo(projection.height * 3, 5);
    expect(scaled.x).toBeCloseTo(base.x, 5);
    expect(scaled.y).toBeCloseTo(triple.center.y, 5);
  });

  it("聚焦目标 placement 缺省时仍按共享单位，不虚构取景", () => {
    const target = { ...targetOf(1), placement: null };
    const projection = groupModelProjection({
      sceneVersion: target.sceneVersion,
      ops: target.ops as never,
      extent: target.extent,
      aabb: target.aabb ?? undefined,
      placement: null,
      badgeTopAnchored: true
    })!;
    const expected = groupBadgeRect({ x: 100, y: 60, width: 320, height: 240 }, projection)!;
    const origin = originOf(1, [target])!;
    expect(expected.y).toBeCloseTo(60 + 240 + 40, 5);
    expect(origin.x).toBeCloseTo(expected.center.x, 5);
    expect(origin.y).toBeCloseTo(expected.center.y, 5);
  });

  it("模型资源未就绪时不画线，而不是用固定框或相机姿态占位", () => {
    expect(originOf(1, [])).toBeNull();
  });
});
