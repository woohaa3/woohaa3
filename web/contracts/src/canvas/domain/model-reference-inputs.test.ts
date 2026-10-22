/**
 * 3D 模型节点前序参考输入解析（change: add-model-mcp-reference-inputs）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "./index.js";
import { mediaPublicUrlFor, resolveModelReferenceInputs } from "./model-reference-inputs.js";

const NOW = "2026-09-26T00:00:00.000Z";
const STORAGE = "sha256-" + "a".repeat(64);

function mediaAsset(id: string, mediaKind: "image" | "video" | "audio", status: StoredAsset["status"] = "ready"): StoredAsset {
  const contentType = mediaKind === "image" ? "image/png" : mediaKind === "video" ? "video/mp4" : "audio/mpeg";
  const extension = mediaKind === "image" ? "png" : mediaKind === "video" ? "mp4" : "mp3";
  return {
    id,
    title: id,
    mediaKind,
    source: "generated",
    status,
    createdAt: NOW,
    metadata: { storageKey: `${STORAGE}.${extension}`, checksum: "a".repeat(64), contentType, size: 4 }
  };
}

function textAsset(id: string, text: string): StoredAsset {
  return { id, title: id, mediaKind: "text", source: "generated", status: "ready", text, createdAt: NOW, metadata: {} };
}

function canvasWith(sources: Array<{ id: string; type: string; assetId?: string; role?: string }>): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({ id: "model-1", type: "model3d", position: { x: 0, y: 0 } });
  for (const source of sources) {
    canvas.document.nodes.push({ id: source.id, type: source.type, position: { x: 200, y: 0 } });
    canvas.document.edges.push({ id: `e-${source.id}`, source: source.id, target: "model-1", data: {} });
    canvas.nodeData[source.id] = source.assetId ? { outputAssetId: source.assetId } : {};
  }
  canvas.nodeData["model-1"] = {
    inputMapping: sources.map((source, index) => ({
      slotId: `slot-${source.id}`,
      sourceNodeId: source.id,
      role: source.role ?? (source.type === "text" ? "text_prompt" : "reference_image"),
      sortKey: String(index)
    }))
  };
  return canvas;
}

describe("resolveModelReferenceInputs", () => {
  it("解析图片引用为稳定 asset 与同源 URL", () => {
    const canvas = canvasWith([{ id: "img", type: "image", assetId: "a1" }]);
    canvas.assets.push(mediaAsset("a1", "image"));
    const result = resolveModelReferenceInputs(canvas, "model-1");
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({
      slotId: "slot-img",
      kind: "image",
      sourceNodeId: "img"
    });
    expect(result.references[0]!.asset).toMatchObject({
      assetId: "a1",
      mediaType: "image/png",
      mediaKind: "image",
      url: `${mediaPublicUrlFor("")}${STORAGE}.png`
    });
    expect(result.references[0]!.asset!.url.startsWith("/api/media/")).toBe(true);
  });

  it("文本引用带权威文字内容", () => {
    const canvas = canvasWith([{ id: "txt", type: "text", assetId: "t1" }]);
    canvas.assets.push(textAsset("t1", "一只银色的猫"));
    const result = resolveModelReferenceInputs(canvas, "model-1");
    expect(result.references[0]).toMatchObject({ kind: "text", text: "一只银色的猫" });
    expect(result.references[0]!.asset).toBeUndefined();
  });

  it("视频与音频按类型识别", () => {
    const canvas = canvasWith([
      { id: "v", type: "video", assetId: "v1", role: "reference_video" },
      { id: "a", type: "audio", assetId: "a1", role: "voice_sample" }
    ]);
    canvas.assets.push(mediaAsset("v1", "video"), mediaAsset("a1", "audio"));
    const kinds = resolveModelReferenceInputs(canvas, "model-1").references.map((reference) => reference.kind);
    expect(kinds).toEqual(["video", "audio"]);
  });

  it("上游未就绪输出产生 pendingReason 且不静默消失", () => {
    const canvas = canvasWith([{ id: "img", type: "image", assetId: "a1" }]);
    canvas.assets.push(mediaAsset("a1", "image", "generating"));
    const result = resolveModelReferenceInputs(canvas, "model-1");
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.asset).toBeUndefined();
    expect(result.references[0]!.pendingReason).toContain("还没有可用输出");
  });

  it("保持 mapping 稳定顺序", () => {
    const canvas = canvasWith([
      { id: "b", type: "image", assetId: "b1" },
      { id: "a", type: "image", assetId: "a1" }
    ]);
    canvas.assets.push(mediaAsset("b1", "image"), mediaAsset("a1", "image"));
    // 显式重排：a 先于 b。
    canvas.nodeData["model-1"] = {
      inputMapping: [
        { slotId: "slot-a", sourceNodeId: "a", role: "reference_image", sortKey: "0" },
        { slotId: "slot-b", sourceNodeId: "b", role: "reference_image", sortKey: "1" }
      ]
    };
    const order = resolveModelReferenceInputs(canvas, "model-1").references.map((reference) => reference.sourceNodeId);
    expect(order).toEqual(["a", "b"]);
  });

  it("没有连入输入时返回空数组", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("c2", NOW);
    canvas.document.nodes.push({ id: "model-1", type: "model3d", position: { x: 0, y: 0 } });
    expect(resolveModelReferenceInputs(canvas, "model-1").references).toEqual([]);
  });

  it("历史误标为 text_prompt 的视频源仍按视频解析（2026-10-06，任务 1.2/R）", () => {
    // 复现案例：视频节点连线已存在，但 mapping role 被存为 text_prompt。
    const canvas = canvasWith([{ id: "v", type: "video", assetId: "v1", role: "text_prompt" }]);
    canvas.assets.push(mediaAsset("v1", "video"));
    const reference = resolveModelReferenceInputs(canvas, "model-1").references[0]!;
    expect(reference.kind).toBe("video");
    expect(reference.asset).toMatchObject({ mediaKind: "video", mediaType: "video/mp4" });
    expect(reference.pendingReason).toBeUndefined();
  });

  it("历史误标的图片/音频源也按实际类型解析", () => {
    const canvas = canvasWith([
      { id: "img", type: "image", assetId: "i1", role: "text_prompt" },
      { id: "a", type: "audio", assetId: "a1", role: "text_prompt" }
    ]);
    canvas.assets.push(mediaAsset("i1", "image"), mediaAsset("a1", "audio"));
    const kinds = resolveModelReferenceInputs(canvas, "model-1").references.map((reference) => reference.kind);
    expect(kinds).toEqual(["image", "audio"]);
  });

  it("真正的文本源仍解析为文本", () => {
    const canvas = canvasWith([{ id: "txt", type: "text", assetId: "t1", role: "text_prompt" }]);
    canvas.assets.push(textAsset("t1", "提示词"));
    expect(resolveModelReferenceInputs(canvas, "model-1").references[0]!.kind).toBe("text");
  });
});
