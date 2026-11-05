/**
 * GLB 上传分类与节点规划回归
 * （change: 2026-10-28-support-glb-model-nodes，任务 2.1 / 4.1）。
 */
import { describe, expect, it } from "vitest";
import type { CanvasNodeData } from "@woohaa3/contracts";
import {
  UPLOAD_ACCEPT,
  buildUploadedAsset,
  planUploadedNode,
  uploadedNodeType,
  type UploadedMedia
} from "./upload-asset.js";

const CHECKSUM = "e".repeat(64);
const MEDIA: UploadedMedia = {
  storageKey: `sha256-${CHECKSUM}`,
  checksum: CHECKSUM,
  contentType: "model/gltf-binary",
  size: 2048,
  url: `/api/media/sha256-${CHECKSUM}`,
  deduplicated: false
};

function file(name: string, type: string): { name: string; type: string; size: number } {
  return { name, type, size: 2048 };
}

describe("GLB 上传分类", () => {
  it("按扩展名优先识别 GLB（空 MIME / octet-stream 也可），明确拒绝 .gltf", () => {
    expect(uploadedNodeType(file("model.glb", ""))).toBe("model3d");
    expect(uploadedNodeType(file("MODEL.GLB", "application/octet-stream"))).toBe("model3d");
    expect(uploadedNodeType(file("model.bin", "model/gltf-binary"))).toBe("model3d");
    expect(uploadedNodeType(file("model.gltf", "model/gltf+json"))).toBeNull();
    expect(uploadedNodeType(file("model.obj", ""))).toBeNull();
    // 现有媒体类别不受影响。
    expect(uploadedNodeType(file("a.png", "image/png"))).toBe("image");
    expect(uploadedNodeType(file("a.md", ""))).toBe("text");
  });

  it("上传接受列表包含 GLB 且保留既有类型", () => {
    expect(UPLOAD_ACCEPT.split(",")).toContain(".glb");
    expect(UPLOAD_ACCEPT.split(",")).toContain("model/gltf-binary");
    expect(UPLOAD_ACCEPT).toContain("image/png");
  });

  it("文件资产记录 modelFormat 供下载恢复扩展名", () => {
    const asset = buildUploadedAsset({ media: MEDIA, mediaKind: "file", file: file("model.glb", ""), now: "2026-10-28T00:00:00.000Z" });
    expect(asset.mediaKind).toBe("file");
    expect(asset.id).toBe(`asset-upload-${CHECKSUM}`);
    expect(asset.metadata).toMatchObject({ modelFormat: "glb", contentType: "model/gltf-binary" });
    // 图片资产不写模型格式标记。
    const image = buildUploadedAsset({
      media: { ...MEDIA, contentType: "image/png" },
      mediaKind: "image",
      file: file("a.png", "image/png")
    });
    expect(image.metadata?.modelFormat).toBeUndefined();
  });

  it("规划资产与节点同批命令：先 upsert 资产，再创建不带脚本的文件模型节点", () => {
    const asset = buildUploadedAsset({ media: MEDIA, mediaKind: "file", file: file("model.glb", ""), now: "2026-10-28T00:00:00.000Z" });
    const commands = planUploadedNode({
      nodeType: "model3d",
      position: { x: 120, y: 80 },
      file: file("model.glb", ""),
      asset,
      nodeId: "n1"
    });
    expect(commands.map((command) => command.type)).toEqual(["asset.upsert", "node.add"]);
    const add = commands[1];
    expect(add.type).toBe("node.add");
    if (add.type !== "node.add") return;
    expect(add.node).toMatchObject({ id: "n1", type: "model3d", position: { x: 120, y: 80 } });
    const data = add.nodeData as CanvasNodeData;
    expect(data.modelSourceKind).toBe("glb");
    expect(data.modelAssetId).toBe(asset.id);
    expect(data.modelContentVersion).toMatchObject({ revision: 1 });
    expect(data.sharedWorldInstance).toMatchObject({ kind: "world-instance", transform: { position: { h: 0 }, scale: 1 } });
    expect(data.modelScript).toBeUndefined();
    expect(data.modelScriptVersion).toBeUndefined();
  });
});
