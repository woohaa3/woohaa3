/**
 * 文件模型（GLB）脚本消费门禁回归
 * （change: 2026-10-28-support-glb-model-nodes，任务 3.2 / 4.1）。
 *
 * 文件模型以原始 GLB 为唯一权威内容：单条与批量脚本提交都必须拒绝，读取投影标出来源并视为
 * 不缺少脚本；不得把 GLB 当空脚本来改写。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  normalizeGlbModelReference,
  type CanvasNodeData,
  type ServerCanvas
} from "@woohaa3/contracts";
import { InMemoryYjsDocumentRepository } from "../sync/index.js";
import { CanvasRoom } from "../sync/room.js";
import { ModelMcpService } from "./service.js";
import { authorModelBatch } from "./batch-service.js";

const NOW = "2026-10-28T00:00:00.000Z";
const CANVAS_ID = "glb-guard";
const ASSET_ID = `asset-upload-${"f".repeat(64)}`;

function glbNodeData(): CanvasNodeData {
  const reference = normalizeGlbModelReference({ assetId: ASSET_ID });
  if (!reference.ok) throw new Error("fixture");
  return {
    title: "模型.glb",
    modelSourceKind: "glb",
    modelAssetId: ASSET_ID,
    modelContentVersion: reference.value.contentVersion,
    modelPlacement: reference.value.placement
  };
}

async function fixture() {
  const room = new CanvasRoom({ canvasId: CANVAS_ID, repository: new InMemoryYjsDocumentRepository(), now: () => NOW });
  const base = createEmptyWoohaa3ServerCanvas(CANVAS_ID, NOW);
  const canvas: ServerCanvas = {
    ...base,
    document: { ...base.document, nodes: [
      { id: "glb", type: "model3d", position: { x: 0, y: 0 } },
      { id: "script", type: "model3d", position: { x: 200, y: 0 } }
    ] },
    nodeData: {
      glb: glbNodeData(),
      script: {
        title: "脚本模型",
        modelScript: "scene.box({ id: 'a' });",
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
        modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
      }
    },
    assets: [{
      id: ASSET_ID,
      title: "模型.glb",
      mediaKind: "file",
      source: "uploaded",
      status: "ready",
      createdAt: NOW,
      url: `/api/media/sha256-${"f".repeat(64)}`,
      metadata: { checksum: "f".repeat(64), contentType: "model/gltf-binary", modelFormat: "glb" }
    }]
  };
  await room.initialize({ canvas, roomEpoch: "epoch", createdAt: NOW });
  return { room, service: new ModelMcpService({ resolveRoom: async () => room, now: () => NOW }) };
}

describe("文件模型脚本门禁", () => {
  it("单条脚本提交拒绝文件模型且内容不变", async () => {
    const { room, service } = await fixture();
    const before = structuredClone(room.exportCanvas());
    if (!before.ok) throw new Error(before.message);
    const result = await service.submitScript({
      canvasId: CANVAS_ID,
      nodeId: "glb",
      requestId: "edit",
      version: "woohaa-model-js-v2",
      source: "scene.box({ id: 'b' });"
    });
    expect(result).toMatchObject({ ok: false, code: "model-source-glb" });
    const after = room.exportCanvas();
    if (!after.ok) throw new Error(after.message);
    expect(after.canvas.nodeData.glb).toEqual(before.canvas.nodeData.glb);
  });

  it("脚本模型保持可提交（旧语义不变）", async () => {
    const { service } = await fixture();
    const result = await service.submitScript({
      canvasId: CANVAS_ID,
      nodeId: "script",
      requestId: "edit",
      version: "woohaa-model-js-v2",
      source: "scene.box({ id: 'a', size: [2, 2, 2] });"
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("批量脚本提交把文件模型逐项标为不可写", async () => {
    const { room } = await fixture();
    const outcome = await authorModelBatch(
      { resolveRoom: async () => room, now: () => NOW },
      {
        canvasId: CANVAS_ID,
        requestId: "batch",
        items: [
          { nodeId: "glb", source: "scene.box({ id: 'b' });" },
          { nodeId: "script", source: "scene.box({ id: 'c' });" }
        ]
      } as never,
      { principalId: "tester", mayWrite: () => true } as never,
      false
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("model-source-glb");
  });

  it("读取投影标出来源且不把文件模型视为待生成", async () => {
    const { service } = await fixture();
    const read = await service.getModelNode({ canvasId: CANVAS_ID, nodeId: "glb" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read).toMatchObject({ modelSourceKind: "glb", modelAssetId: ASSET_ID, source: "" });
    const list = await service.listModelNodes({ canvasId: CANVAS_ID });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.nodes.find((node) => node.nodeId === "glb")).toMatchObject({ sourceKind: "glb", hasScript: false, pending: false });
    expect(list.nodes.find((node) => node.nodeId === "script")).toMatchObject({ hasScript: true, pending: false });
  });
});
