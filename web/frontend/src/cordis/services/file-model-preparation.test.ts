/**
 * GLB 文件模型渲染准备回归
 * （change: 2026-10-28-support-glb-model-nodes，任务 3.1 / 4.1）。
 *
 * 覆盖：资产缺失/未就绪/类型不符的可见失败、合法模型产出可注册资源、内嵌纹理经既有模型纹理
 * 通道按 `modeltex:` 前缀上传、非法 GLB 明确失败、执行身份随资产身份变化而脚本模型返回空。
 */
import { describe, expect, it, vi } from "vitest";
import type { CanvasNodeData, NodeCapabilityContext, ServerCanvas } from "@woohaa3/contracts";
import { createFileModelPreparation, fileModelExecutionKey } from "./file-model-preparation.js";

const ASSET_ID = `asset-upload-${"d".repeat(64)}`;

function canvasWith(data: CanvasNodeData, asset?: Record<string, unknown>): ServerCanvas {
  return {
    id: "c1",
    assets: asset
      ? [{
          id: ASSET_ID,
          title: "模型.glb",
          mediaKind: "file",
          source: "uploaded",
          status: "ready",
          createdAt: "2026-10-28T00:00:00.000Z",
          url: `/api/media/sha256-${"d".repeat(64)}`,
          metadata: { checksum: "d".repeat(64), contentType: "model/gltf-binary" },
          ...asset
        }]
      : [],
    document: { nodes: [{ id: "model", type: "model3d", position: { x: 0, y: 0 } }] },
    nodeData: { model: data }
  } as unknown as ServerCanvas;
}

function context(canvas: ServerCanvas): NodeCapabilityContext {
  return { canvas, node: canvas.document.nodes[0], data: canvas.nodeData.model };
}

function glbData(): CanvasNodeData {
  return {
    title: "模型.glb",
    modelSourceKind: "glb",
    modelAssetId: ASSET_ID,
    modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
    modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
  };
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

/** 单三角形 GLB；可选内嵌图片与材质。 */
function buildGlb(options: { texture?: boolean } = {}): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const image = options.texture ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]) : null;
  const parts = [new Uint8Array(positions.buffer), new Uint8Array(indices.buffer)];
  const bufferViews: Record<string, unknown>[] = [
    { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
    { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }
  ];
  let length = positions.byteLength + indices.byteLength;
  if (image) {
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: image.byteLength });
    parts.push(image);
    length += image.byteLength;
  }
  const document: Record<string, unknown> = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: length }],
    bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, ...(options.texture ? { material: 0 } : {}) }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0
  };
  if (options.texture) {
    document.images = [{ bufferView: 2, mimeType: "image/png" }];
    document.textures = [{ source: 0 }];
    document.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  }
  const bin = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bin.set(part, offset);
    offset += part.byteLength;
  }
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = align4(json.byteLength);
  const binLength = align4(bin.byteLength);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.byteLength, 20 + jsonLength);
  const binOffset = 20 + jsonLength;
  view.setUint32(binOffset, binLength, true);
  view.setUint32(binOffset + 4, 0x004e4942, true);
  out.set(bin, binOffset + 8);
  return out;
}

function preparation(overrides: {
  blob?: Blob;
  read?: (asset: unknown, signal: AbortSignal | undefined, canvasId: string) => Promise<Blob>;
  runtime?: { setModelMediaTexture: (id: string, width: number, height: number, rgba: Uint8Array, source?: string) => boolean };
} = {}) {
  const uploads: Array<{ id: string; width: number; height: number; source?: string }> = [];
  const decodeTexture = vi.fn(async () => ({ width: 2, height: 2, rgba: new Uint8Array(16) }));
  const instance = createFileModelPreparation({
    runtime: () => ({
      runtime: () => overrides.runtime ?? {
        setModelMediaTexture: (id, width, height, _rgba, source) => {
          uploads.push({ id, width, height, source });
          return true;
        }
      }
    }),
    read: overrides.read ?? (async () => overrides.blob ?? new Blob([buildGlb().buffer as ArrayBuffer], { type: "model/gltf-binary" })),
    decodeTexture
  });
  return { instance, uploads, decodeTexture };
}

describe("GLB 文件模型准备", () => {
  it("脚本模型不占用文件准备身份", () => {
    expect(fileModelExecutionKey(context(canvasWith({ modelScript: "scene.box({});" })))).toBeUndefined();
  });

  it("声明为文件模型但资产引用损坏时仍由文件路径处理（不回退脚本）", () => {
    const canvas = canvasWith({ ...glbData(), modelAssetId: "" } as unknown as CanvasNodeData);
    expect(fileModelExecutionKey(context(canvas))).toContain("missing");
  });

  it("执行身份随资产就绪状态与身份变化", () => {
    const ready = canvasWith(glbData(), {});
    const key = fileModelExecutionKey(context(ready));
    expect(key).toContain(ASSET_ID);
    const missing = canvasWith(glbData());
    expect(fileModelExecutionKey(context(missing))).toContain("missing");
  });

  it("合法 GLB 产出可注册资源，无纹理时不触碰运行时", async () => {
    const { instance, uploads } = preparation();
    const result = await instance.prepare(context(canvasWith(glbData(), {})));
    expect(result.status).toBe("ok");
    expect(result.resource?.ops.some((op) => op.t === "mesh")).toBe(true);
    expect(result.resource?.aabb).not.toBeNull();
    expect(uploads).toHaveLength(0);
  });

  it("内嵌纹理经模型纹理通道按内容前缀上传", async () => {
    const { instance, uploads, decodeTexture } = preparation({ blob: new Blob([buildGlb({ texture: true }).buffer as ArrayBuffer]) });
    const result = await instance.prepare(context(canvasWith(glbData(), {})));
    expect(result.status).toBe("ok");
    expect(decodeTexture).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].id).toMatch(/^modeltex:glbtex:[0-9a-f]{16}$/);
    expect(uploads[0].source).toMatch(/^glbtex:/);
    const material = result.resource?.ops.find((op) => op.t === "material");
    expect(material?.t === "material" ? material.baseColorTexture : null).toMatch(/^glbtex:/);
  });

  it("资产缺失、未就绪与类型不符时返回可见失败状态", async () => {
    const { instance } = preparation();
    expect((await instance.prepare(context(canvasWith(glbData())))).status).toMatch(/^fail:load:missing-asset/);
    expect((await instance.prepare(context(canvasWith(glbData(), { status: "generating" })))).status)
      .toMatch(/^fail:load:asset-unavailable/);
    expect((await instance.prepare(context(canvasWith(glbData(), { mediaKind: "image" })))).status)
      .toMatch(/^fail:load:asset-kind/);
  });

  it("同一节点的新准备取消上一轮下载，旧结果标记为取消", async () => {
    let calls = 0;
    const { instance } = preparation({
      read: (_asset, signal) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          });
        }
        return Promise.resolve(new Blob([buildGlb().buffer as ArrayBuffer], { type: "model/gltf-binary" }));
      }
    });
    const contextValue = context(canvasWith(glbData(), {}));
    const first = instance.prepare(contextValue);
    const second = instance.prepare(contextValue);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ status: "fail:load:aborted" });
    expect(secondResult.status).toBe("ok");
  });

  it("运行时晚于模型准备就绪时等待并完成纹理上传", async () => {
    let available = false;
    const uploads: string[] = [];
    const instance = createFileModelPreparation({
      runtime: () => available
        ? { runtime: () => ({ setModelMediaTexture: (id) => { uploads.push(id); return true; } }) }
        : null,
      read: async () => new Blob([buildGlb({ texture: true }).buffer as ArrayBuffer]),
      decodeTexture: async () => ({ width: 1, height: 1, rgba: new Uint8Array(4) })
    });
    const pending = instance.prepare(context(canvasWith(glbData(), {})));
    await new Promise((resolve) => setTimeout(resolve, 120));
    available = true;
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(/^modeltex:glbtex:[0-9a-f]{16}$/);
  });

  it("损坏 GLB 明确失败且不产生资源", async () => {
    const { instance } = preparation({ blob: new Blob([new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer]) });
    const result = await instance.prepare(context(canvasWith(glbData(), {})));
    expect(result.status).toMatch(/^fail:load:not-glb/);
    expect(result.resource).toBeUndefined();
  });
});
