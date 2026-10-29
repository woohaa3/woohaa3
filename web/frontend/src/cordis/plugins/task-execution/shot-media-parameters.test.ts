import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createFilmSetGroupMarker,
  createWoohaa3CanvasNode,
  filmSetGroupData,
  shotPreviewNodeId,
  toWoohaa3CanvasDocument,
  type CanvasNodeData,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { readShotMediaParameters } from "./shot-media-parameters.js";

const NOW = "2026-10-29T00:00:00.000Z";
const GROUP_ID = "film";
const VIDEO_CLIP_ID = "clip-video";
const IMAGE_CLIP_ID = "clip-image";

function shotNodeId(clipId: string): string {
  return shotPreviewNodeId(GROUP_ID, clipId);
}

function shotNodeData(clipId: string): CanvasNodeData {
  return {
    managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: GROUP_ID, entityId: clipId, lifecycle: "owner-managed" },
    mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: GROUP_ID, clipId } }
  };
}

function canvasFixture(options: { videoType?: "image" | "video"; imageType?: "image" | "video"; assets?: StoredAsset[] } = {}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-test", NOW);
  return {
    ...base,
    document: toWoohaa3CanvasDocument(
      {
        nodes: [
          createWoohaa3CanvasNode("group", { x: 0, y: 0 }, GROUP_ID),
          createWoohaa3CanvasNode(options.videoType ?? "video", { x: 0, y: 0 }, shotNodeId(VIDEO_CLIP_ID)),
          createWoohaa3CanvasNode(options.imageType ?? "image", { x: 0, y: 0 }, shotNodeId(IMAGE_CLIP_ID))
        ],
        edges: []
      },
      NOW
    ),
    nodeData: {
      [GROUP_ID]: filmSetGroupData(createFilmSetGroupMarker({
        cameras: [
          { id: "camera-video", azimuth: 0, elevation: 0.35, distance: 4, focusOffset: { x: 0, y: 0, z: 0 }, aspect: "9:16" },
          { id: "camera-image", azimuth: 0, elevation: 0.35, distance: 4, focusOffset: { x: 0, y: 0, z: 0 }, aspect: "16:9" }
        ],
        clips: [
          { id: VIDEO_CLIP_ID, name: "运镜", cameraId: "camera-video", duration: 3, loop: true },
          { id: IMAGE_CLIP_ID, name: "定妆照", cameraId: "camera-image", duration: 0, loop: false }
        ],
        activeClip: VIDEO_CLIP_ID
      }), { title: "片场" }),
      [shotNodeId(VIDEO_CLIP_ID)]: shotNodeData(VIDEO_CLIP_ID),
      [shotNodeId(IMAGE_CLIP_ID)]: shotNodeData(IMAGE_CLIP_ID)
    },
    assets: options.assets ?? []
  };
}

describe("片场镜头节点参数", () => {
  it("动态镜头输出视频参数：分辨率、画幅、时长、帧率与循环", () => {
    expect(readShotMediaParameters(canvasFixture(), shotNodeId(VIDEO_CLIP_ID))).toEqual({
      kind: "video",
      title: "运镜",
      width: 720,
      height: 1280,
      aspect: "9:16",
      durationSeconds: 3,
      frameRate: 30,
      loop: true
    });
  });

  it("静态镜头输出图片参数，不带时长与帧率", () => {
    expect(readShotMediaParameters(canvasFixture(), shotNodeId(IMAGE_CLIP_ID))).toEqual({
      kind: "image",
      title: "定妆照",
      width: 1280,
      height: 720,
      aspect: "16:9",
      durationSeconds: 0,
      frameRate: 0,
      loop: false
    });
  });

  it("非托管镜头节点不接管", () => {
    const canvas = canvasFixture();
    delete canvas.nodeData[shotNodeId(VIDEO_CLIP_ID)];
    expect(readShotMediaParameters(canvas, shotNodeId(VIDEO_CLIP_ID))).toBeNull();
    expect(readShotMediaParameters(canvas, "other")).toBeNull();
    expect(readShotMediaParameters(null, shotNodeId(VIDEO_CLIP_ID))).toBeNull();
  });

  it("节点类型与镜头静态/动态不一致时不展示猜测参数", () => {
    expect(readShotMediaParameters(canvasFixture({ videoType: "image" }), shotNodeId(VIDEO_CLIP_ID))).toBeNull();
    expect(readShotMediaParameters(canvasFixture({ imageType: "video" }), shotNodeId(IMAGE_CLIP_ID))).toBeNull();
  });
});
