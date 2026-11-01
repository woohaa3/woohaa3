import { describe, expect, it } from "vitest";
import {
  addVec3,
  createFilmSetGroupMarker,
  filmSetDisplayTransform,
  groupBadgeRect,
  groupModelProjection,
  mapFilmSetSceneCamera,
  shotCameraPosition,
  shotPreviewNodeId,
  staticShotCameraMotion,
  worldToCanvasPoint,
  type ServerCanvas,
  type SceneV2Op
} from "@woohaa3/contracts";
import { buildShotPreviewSceneInput, shotPreviewLinkOrigin } from "./shot-preview-scene-input.js";
import {
  filmSetDisplayRotation,
  filmSetDisplayScale,
  modelBounds,
  type FocusTargetInput
} from "./model-focus-session.js";

// 「主用」画布上的真实片场徽标（组结构底边中点向下 40 画布单位）。
const badge = { center: { x: 747.875, y: 4237.37 } };

describe("shotPreviewLinkOrigin", () => {
  it("优先取镜头相机标记投影，而不是汇到整个模型（徽标）中心", () => {
    // 相机悬在场景上方（y 3707），徽标中心在 4237；虚线应接到小相机上。
    expect(shotPreviewLinkOrigin(badge, { x: 858, y: 3707 })).toEqual({ x: 858, y: 3707 });
  });

  it("相机标记不可用时退回徽标中心，仍保留归属可读", () => {
    expect(shotPreviewLinkOrigin(badge, null)).toEqual({ x: 747.875, y: 4237.37 });
  });

  it("没有外部徽标时只用相机姿态投影", () => {
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

  /**
   * 与 Bevy `filmset_camera` 的小相机同一份「场景→显示」姿态（Rust `sampled_camera_pose`）：
   * 用它核对归属线起点确实落在该镜头的小模型上。
   */
  const cameraMarkerPoint = (
    target: FocusTargetInput,
    camera: { azimuth: number; elevation: number; distance: number; focusOffset: { x: number; y: number; z: number } }
  ) => {
    const bounds = modelBounds(target);
    const transform = filmSetDisplayTransform({
      scale: filmSetDisplayScale(target),
      yaw: filmSetDisplayRotation(target)
    });
    if (!bounds || !transform.ok) throw new Error("fixture 应有可投影的相机标记");
    const mapped = mapFilmSetSceneCamera(transform.value, bounds.center, camera);
    if (!mapped) throw new Error("fixture 应有可映射的相机");
    const position = shotCameraPosition(
      addVec3(bounds.center, mapped.focusOffset),
      mapped.azimuth,
      mapped.distance,
      camera.elevation
    );
    const point = worldToCanvasPoint(position);
    return { x: point.x, y: point.y };
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

  it("线头落在该镜头的小相机上，而不是整个模型（徽标）中心", () => {
    const target = targetOf(1);
    const projection = groupModelProjection({
      sceneVersion: target.sceneVersion,
      ops: target.ops as never,
      extent: target.extent,
      aabb: target.aabb ?? undefined,
      placement: target.placement,
      badgeTopAnchored: true
    })!;
    const badgeRect = groupBadgeRect({ x: 100, y: 60, width: 320, height: 240 }, projection)!;

    const origin = originOf(1)!;
    const marker = cameraMarkerPoint(target, {
      azimuth: 0,
      elevation: 0.35,
      distance: 4,
      focusOffset: { x: 0, y: 0, z: 0 }
    });
    // 起点就是场景里那台小相机的投影，不再汇到徽标（整个模型）中心。
    expect(origin.x).toBeCloseTo(marker.x, 5);
    expect(origin.y).toBeCloseTo(marker.y, 5);
    expect(
      Math.hypot(origin.x - badgeRect.center.x, origin.y - badgeRect.center.y)
    ).toBeGreaterThan(50);
  });

  it("镜头距离按场景→显示变换缩放，倍率越大相机标记越远", () => {
    const base = originOf(1)!;
    const scaled = originOf(3)!;
    // 焦点不变、距离 × 3：投影沿同一方向远离，仍不使用徽标中心。
    expect(
      Math.hypot(scaled.x - base.x, scaled.y - base.y)
    ).toBeGreaterThan(50);
  });

  it("聚焦目标 placement 缺省时仍按共享单位，不虚构取景", () => {
    const implicit = originOf(1, [{ ...targetOf(1), placement: null }])!;
    const explicit = originOf(1)!;
    expect(implicit.x).toBeCloseTo(explicit.x, 5);
    expect(implicit.y).toBeCloseTo(explicit.y, 5);
  });

  it("模型资源未就绪时不画线，而不是用固定框或徽标占位", () => {
    expect(originOf(1, [])).toBeNull();
  });
});
