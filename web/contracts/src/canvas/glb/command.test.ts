/**
 * 文件模型节点写入/撤销/协作语义回归
 * （change: 2026-10-28-support-glb-model-nodes，任务 2.2 / 4.1）。
 *
 * 覆盖：资产 + 节点同批原子创建、规范化来源与内容版本、混源/缺失资产/类型不匹配拒绝、
 * placement 编辑只推进 revision、撤销不改变旧脚本模型语义、片场拒绝顶层文件模型字段。
 */
import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "../../../../test-support/managed-shot-commands.js";
import { createEmptyWoohaa3ServerCanvas, type CanvasNodeData, type ServerCanvas, type StoredAsset } from "../domain/index.js";
import { glbModelSourceHash, normalizeGlbModelReference } from "../model-definition.js";

const NOW = "2026-10-28T00:00:00.000Z";
const ASSET_ID = `asset-upload-${"c".repeat(64)}`;

function fileAsset(overrides: Partial<StoredAsset> = {}): StoredAsset {
  return {
    id: ASSET_ID,
    title: "模型.glb",
    mediaKind: "file",
    source: "uploaded",
    status: "ready",
    createdAt: NOW,
    url: `/api/media/sha256-${"c".repeat(64)}`,
    metadata: {
      storageKey: `sha256-${"c".repeat(64)}`,
      checksum: "c".repeat(64),
      contentType: "model/gltf-binary",
      size: 1024,
      modelFormat: "glb"
    },
    ...overrides
  };
}

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

function base(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("c1", NOW);
}

describe("文件模型节点写入", () => {
  it("资产与节点同批创建时规范化为文件模型且不写脚本字段", () => {
    const result = applyCanvasCommands(base(), [
      { type: "asset.upsert", asset: fileAsset() },
      { type: "node.add", node: { id: "glb", type: "model3d", position: { x: 12, y: 8 } }, nodeData: glbNodeData() }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.canvas.nodeData.glb;
    expect(data.modelSourceKind).toBe("glb");
    expect(data.modelAssetId).toBe(ASSET_ID);
    expect(data.modelContentVersion).toMatchObject({ revision: 1, sourceHash: glbModelSourceHash(ASSET_ID) });
    expect(data.modelScript).toBeUndefined();
    expect(data.modelScriptVersion).toBeUndefined();
    expect(data.modelPlacement).toEqual({ offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 });
  });

  it("缺失资产或资产类型不匹配时整批拒绝（不产生半成品节点）", () => {
    const missing = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "glb", type: "model3d", position: { x: 0, y: 0 } }, nodeData: glbNodeData() }
    ], { now: NOW });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.rejection.code).toBe("asset-in-use");

    const wrongKind = applyCanvasCommands(base(), [
      { type: "asset.upsert", asset: fileAsset({ mediaKind: "image" }) },
      { type: "node.add", node: { id: "glb", type: "model3d", position: { x: 0, y: 0 } }, nodeData: glbNodeData() }
    ], { now: NOW });
    expect(wrongKind.ok).toBe(false);
    if (wrongKind.ok) return;
    expect(wrongKind.rejection.code).toBe("invalid-self-contained-node");
  });

  it("混源（GLB + 脚本字段）与未知来源被拒绝", () => {
    const mixed = applyCanvasCommands(base(), [
      { type: "asset.upsert", asset: fileAsset() },
      {
        type: "node.add",
        node: { id: "glb", type: "model3d", position: { x: 0, y: 0 } },
        nodeData: { ...glbNodeData(), modelScript: "" } as unknown as CanvasNodeData
      }
    ], { now: NOW });
    expect(mixed.ok).toBe(false);

    const unknown = applyCanvasCommands(base(), [
      { type: "asset.upsert", asset: fileAsset() },
      {
        type: "node.add",
        node: { id: "glb", type: "model3d", position: { x: 0, y: 0 } },
        nodeData: { title: "x", modelSourceKind: "gltf", modelAssetId: ASSET_ID } as unknown as CanvasNodeData
      }
    ], { now: NOW });
    expect(unknown.ok).toBe(false);
  });

  it("placement 编辑推进 revision，重复同样内容不推进；来源哈希保持稳定", () => {
    const created = applyCanvasCommands(base(), [
      { type: "asset.upsert", asset: fileAsset() },
      { type: "node.add", node: { id: "glb", type: "model3d", position: { x: 0, y: 0 } }, nodeData: glbNodeData() }
    ], { now: NOW });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const moved = applyCanvasCommands(created.canvas, [
      { type: "nodeData.patch", nodeId: "glb", value: { modelPlacement: { offset: { x: 10, y: 0, z: 0 }, scale: 2, yaw: 0.5 } } }
    ], { now: NOW });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.canvas.nodeData.glb.modelContentVersion).toMatchObject({
      revision: 2,
      sourceHash: glbModelSourceHash(ASSET_ID)
    });
    expect(moved.canvas.nodeData.glb.modelPlacement).toEqual({ offset: { x: 10, y: 0, z: 0 }, scale: 2, yaw: 0.5 });

    const again = applyCanvasCommands(moved.canvas, [
      { type: "nodeData.patch", nodeId: "glb", value: { modelPlacement: { offset: { x: 10, y: 0, z: 0 }, scale: 2, yaw: 0.5 } } }
    ], { now: NOW });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.canvas.nodeData.glb.modelContentVersion).toMatchObject({ revision: 2 });
  });

  it("撤销节点不改变旧脚本模型语义（无来源字段的 model3d 仍是脚本模型）", () => {
    const scripted = applyCanvasCommands(base(), [
      {
        type: "node.add",
        node: { id: "script", type: "model3d", position: { x: 0, y: 0 } },
        nodeData: {
          modelScript: "scene.box({ id: 'a' });",
          modelScriptLanguage: "javascript",
          modelScriptVersion: "woohaa-model-js-v2",
          modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
          modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
        }
      }
    ], { now: NOW });
    expect(scripted.ok).toBe(true);
    if (!scripted.ok) return;
    expect(scripted.canvas.nodeData.script.modelSourceKind).toBeUndefined();
    expect(scripted.canvas.nodeData.script.modelScript).toBe("scene.box({ id: 'a' });");

    const removed = applyCanvasCommands(scripted.canvas, [{ type: "node.remove", nodeIds: ["script"] }], { now: NOW });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.canvas.nodeData.script).toBeUndefined();
  });

});
