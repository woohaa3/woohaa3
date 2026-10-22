/**
 * 参考素材 items 投影（change: add-reference-inputs-and-mentions，任务 3.1）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasTaskInputBinding, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import { resolveReferenceItems } from "./reference-items.js";

const NOW = "2026-09-26T00:00:00.000Z";
const STORAGE = "sha256-" + "a".repeat(64);

function mediaAsset(id: string, mediaKind: "image" | "video" | "audio", status: StoredAsset["status"] = "ready", url?: string): StoredAsset {
  const contentType = mediaKind === "image" ? "image/png" : mediaKind === "video" ? "video/mp4" : "audio/mpeg";
  const extension = mediaKind === "image" ? "png" : mediaKind === "video" ? "mp4" : "mp3";
  return {
    id,
    title: id,
    mediaKind,
    source: "generated",
    status,
    createdAt: NOW,
    metadata: { storageKey: `${STORAGE}.${extension}`, checksum: "a".repeat(64), contentType, size: 4 },
    ...(url ? { url } : {})
  };
}

function textAsset(id: string, text: string): StoredAsset {
  return { id, title: id, mediaKind: "text", source: "generated", status: "ready", text, createdAt: NOW, metadata: {} };
}

const BINDINGS: CanvasTaskInputBinding[] = [
  { field: "imageUrls", semantic: "reference-image", roles: ["reference_image"], mediaKinds: ["image"], mediaTypes: ["image/png"], maxItems: 4, valueFormat: "url" }
];

function canvasWith(options: {
  assets?: StoredAsset[];
  assetId?: string;
  role?: string;
  sourceType?: string;
}): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  const sourceType = options.sourceType ?? "image";
  canvas.document.nodes.push(
    { id: "src", type: sourceType, position: { x: 0, y: 0 } },
    { id: "target", type: "image", position: { x: 300, y: 0 } }
  );
  canvas.document.edges.push({ id: "e1", source: "src", target: "target", data: {} });
  canvas.assets.push(...(options.assets ?? []));
  canvas.nodeData.src = options.assetId ? { outputAssetId: options.assetId } : {};
  canvas.nodeData.target = {
    inputMapping: [{ slotId: "slot-a", sourceNodeId: "src", role: options.role ?? "reference_image", sortKey: "0" }]
  };
  return canvas;
}

describe("resolveReferenceItems", () => {
  it("ready 图片映射为 ready item 且带稳定预览", () => {
    const canvas = canvasWith({ assets: [mediaAsset("a1", "image", "ready", "/api/media/x.png")], assetId: "a1" });
    const result = resolveReferenceItems({ canvas, nodeId: "target", bindings: BINDINGS });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      slotId: "slot-a",
      mentionType: "input_image",
      mediaKind: "image",
      status: "ready",
      previewUrl: "/api/media/x.png?canvas=c1",
      assetId: "a1"
    });
    expect(result.blockingReasons).toEqual([]);
  });

  it("上游无输出时显示 waiting 并给出 blocking reason", () => {
    const canvas = canvasWith({ assetId: undefined });
    const result = resolveReferenceItems({ canvas, nodeId: "target", bindings: BINDINGS });
    expect(result.items[0]!.status).toBe("waiting");
    expect(result.items[0]!.blockingReason).toContain("还没有可用输出");
  });

  it("资产未 ready 时显示 waiting", () => {
    const canvas = canvasWith({ assets: [mediaAsset("a1", "image", "generating")], assetId: "a1" });
    const result = resolveReferenceItems({ canvas, nodeId: "target", bindings: BINDINGS });
    expect(result.items[0]!.status).toBe("waiting");
  });

  it("模型不接受该类型时显示 invalid（不静默消失）", () => {
    const canvas = canvasWith({ assets: [mediaAsset("a1", "video")], assetId: "a1", role: "reference_video" });
    const result = resolveReferenceItems({ canvas, nodeId: "target", bindings: BINDINGS });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.status).toBe("invalid");
    expect(result.blockingReasons.length).toBeGreaterThan(0);
  });

  it("文字 source 映射为 input_text item", () => {
    const canvas = canvasWith({ assets: [textAsset("t1", "上游文字")], assetId: "t1", role: "text_prompt", sourceType: "text" });
    const result = resolveReferenceItems({ canvas, nodeId: "target", bindings: BINDINGS });
    expect(result.items[0]).toMatchObject({ mentionType: "input_text", mediaKind: "text", status: "ready" });
  });
});

describe("resolveReferenceItems（镜头参考，任务 8.6）", () => {
  const VIDEO_BINDINGS: CanvasTaskInputBinding[] = [
    { field: "videoUrls", semantic: "reference-video", roles: ["reference_video"], mediaKinds: ["video"], mediaTypes: ["video/mp4"], maxItems: 2, valueFormat: "reference" }
  ];

  function shotCanvas(options: { frozenAssetId?: string } = {}): ServerCanvas {
    const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
    canvas.document.nodes.push(
      { id: "preview", type: "film-set-shot-preview", position: { x: 0, y: 0 } },
      { id: "video", type: "video", position: { x: 300, y: 0 } }
    );
    canvas.document.edges.push({ id: "e1", source: "preview", target: "video", data: { kind: "shot-reference", schemaVersion: 1 } });
    canvas.nodeData.preview = { shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "clip-1" } } as never;
    canvas.nodeData.video = {
      inputMapping: [{
        slotId: "slot-shot",
        sourceNodeId: "preview",
        role: "shot_reference",
        sortKey: "0",
        ...(options.frozenAssetId ? { sourceAssetIds: [options.frozenAssetId] } : {})
      }]
    } as never;
    return canvas;
  }

  it("未录制完成时显示等待镜头参考（视频类型），不是通用上游错误", () => {
    const result = resolveReferenceItems({ canvas: shotCanvas(), nodeId: "video", bindings: VIDEO_BINDINGS });
    expect(result.items[0]).toMatchObject({ mentionType: "input_video", mediaKind: "video", status: "waiting" });
    expect(result.items[0]!.blockingReason).toContain("等待镜头参考");
  });

  it("已冻结的镜头参考按 reference_video 绑定显示 ready", () => {
    const canvas = shotCanvas({ frozenAssetId: "shot-asset" });
    canvas.assets.push(mediaAsset("shot-asset", "video"));
    const result = resolveReferenceItems({ canvas, nodeId: "video", bindings: VIDEO_BINDINGS });
    expect(result.items[0]).toMatchObject({ status: "ready", mediaKind: "video" });
    expect(result.blockingReasons).toHaveLength(0);
  });
});
