/**
 * 上传 → 画布节点规划测试（change: 后续 change 补齐右键菜单「上传」）。
 */
import { describe, expect, it } from "vitest";
import {
  buildUploadedAsset,
  buildUploadedTextAsset,
  planUploadedNode,
  uploadedNodeType,
  type UploadedMedia
} from "../../../extension-api/upload-asset.js";

const CHECKSUM = "a".repeat(64);
const uploaded: UploadedMedia = {
  storageKey: `sha256-${CHECKSUM}`,
  checksum: CHECKSUM,
  contentType: "image/png",
  size: 4,
  url: `/api/media/sha256-${CHECKSUM}`,
  deduplicated: false
};

describe("uploadedNodeType", () => {
  it("按 MIME/扩展名推断节点类型", () => {
    expect(uploadedNodeType({ name: "a.png", type: "image/png", size: 1 })).toBe("image");
    expect(uploadedNodeType({ name: "a.mp4", type: "video/mp4", size: 1 })).toBe("video");
    expect(uploadedNodeType({ name: "a.mp3", type: "audio/mpeg", size: 1 })).toBe("audio");
    expect(uploadedNodeType({ name: "a.md", type: "", size: 1 })).toBe("text");
    expect(uploadedNodeType({ name: "a.bin", type: "application/octet-stream", size: 1 })).toBeNull();
  });
});

describe("planUploadedNode", () => {
  it("先 upsert 资产再 add 节点，nodeData 直接引用已就绪资产", () => {
    const asset = buildUploadedAsset({
      media: uploaded,
      mediaKind: "image",
      file: { name: "photo.png", type: "image/png", size: 4 }
    });
    const commands = planUploadedNode({
      nodeType: "image",
      position: { x: 10, y: 20 },
      file: { name: "photo.png", type: "image/png", size: 4 },
      asset
    });

    expect(commands[0]).toMatchObject({ type: "asset.upsert", asset: { mediaKind: "image", source: "uploaded" } });
    expect(commands[1]).toMatchObject({
      type: "node.add",
      node: { type: "image", position: { x: 10, y: 20 } },
      nodeData: { outputAssetId: asset.id, resourceKind: "image", taskStatus: "successed" }
    });
  });

  it("文本上传把正文写进资产 text 字段（跳过 Media Service）", () => {
    const asset = buildUploadedTextAsset({
      file: { name: "note.md", type: "text/markdown", size: 4 },
      text: "正文"
    });
    expect(asset).toMatchObject({ mediaKind: "text", text: "正文", source: "uploaded" });
    expect(asset.metadata).toEqual({});
  });

  it("拉线上下文上传：同一批次里 asset.upsert + 带连线的 node.add", () => {
    const asset = buildUploadedAsset({
      media: uploaded,
      mediaKind: "image",
      file: { name: "photo.png", type: "image/png", size: 4 }
    });
    const commands = planUploadedNode({
      nodeType: "image",
      position: { x: 0, y: 0 },
      file: { name: "photo.png", type: "image/png", size: 4 },
      asset,
      connectFrom: { nodeId: "n1", nodeType: "text", label: "文本" }
    });
    expect(commands[0]).toMatchObject({ type: "asset.upsert" });
    expect(commands[1]).toMatchObject({
      type: "node.add",
      connect: { fromNodeId: "n1", label: "文本" }
    });
    const nodeAdd = commands[1] as { nodeData?: { inputMapping?: Array<{ sourceNodeId: string }> } };
    expect(nodeAdd.nodeData?.inputMapping?.[0]).toMatchObject({ sourceNodeId: "n1" });
  });
});

// parseUploadResponse 的响应校验测试随 change: adopt-frontend-cordis-plugin-runtime
// 迁入 runtime/remote/remote.test.ts（Media Remote adapter）。

