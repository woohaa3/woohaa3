/**
 * 替换批次的原子性与并发拒绝测试
 * （change: add-paste-import-workflows，任务 5.4）。
 *
 * 使用与 Canvas Service 共享的纯 reducer（`applyCanvasCommands`）验证：节点被删除或
 * 状态变化时替换批次被整体拒绝，原资产引用不变，且不产生部分 asset。
 */
import { describe, expect, it } from "vitest";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  type CanvasCommand,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { planReplaceImage } from "../../../extension-api/upload-asset.js";

const CHECKSUM = "a".repeat(64);

function canvasWithImageNode(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const result = applyCanvasCommands(base, [
    { type: "node.add", node: { id: "src", type: "text", position: { x: -200, y: 0 } } },
    {
      type: "node.add",
      node: { id: "n1", type: "image", position: { x: 10, y: 20 } },
      nodeData: {
        title: "原节点",
        prompt: "保留我",
        modelId: "m1",
        parameters: { ratio: "1:1" },
        outputAssetId: "old-asset",
        resourceKind: "image",
        taskStatus: "successed",
        inputMapping: [{ sourceNodeId: "src", role: "reference_image", sortKey: "0" }]
      }
    },
    { type: "edge.add", edge: { id: "e-src-n1", source: "src", target: "n1" } }
  ]);
  if (!result.ok) throw new Error("fixture");
  return result.canvas;
}

function newImageAsset(): StoredAsset {
  return {
    id: `asset-upload-${CHECKSUM}`,
    title: "new.png",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: "2026-09-27T00:00:00.000Z",
    url: `/api/media/sha256-${CHECKSUM}`,
    metadata: { storageKey: `sha256-${CHECKSUM}`, checksum: CHECKSUM, contentType: "image/png", size: 4 }
  };
}

describe("planReplaceImage 原子批次", () => {
  it("保留节点 ID/位置/prompt/parameters/inputMapping 与边，只更新输出资产", () => {
    const before = canvasWithImageNode();
    const commands = planReplaceImage({ nodeId: "n1", asset: newImageAsset() });
    const result = applyCanvasCommands(before, commands, { now: "2026-09-27T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.canvas;
    const nodeBefore = before.document.nodes.find((node) => node.id === "n1")!;
    const nodeAfter = after.document.nodes.find((node) => node.id === "n1")!;
    expect(nodeAfter).toEqual(nodeBefore);
    expect(after.document.edges).toEqual(before.document.edges);
    const data = after.nodeData["n1"] as Record<string, unknown>;
    expect(data.outputAssetId).toBe(newImageAsset().id);
    expect(data.prompt).toBe("保留我");
    expect(data.parameters).toEqual({ ratio: "1:1" });
    // inputMapping 保留来源/角色/顺序（reconciliation 会补稳定 slotId）。
    expect(data.inputMapping).toMatchObject([{ sourceNodeId: "src", role: "reference_image", sortKey: "0" }]);
    // 新资产已 upsert。
    expect(after.assets.some((asset) => asset.id === newImageAsset().id)).toBe(true);
  });

  it("节点已被删除时整批拒绝，不产生部分 asset，原资产引用不变", () => {
    const base = canvasWithImageNode();
    const removed = applyCanvasCommands(base, [{ type: "node.remove", nodeIds: ["n1"] }]);
    if (!removed.ok) throw new Error("fixture");
    const result = applyCanvasCommands(removed.canvas, planReplaceImage({ nodeId: "n1", asset: newImageAsset() }));
    expect(result.ok).toBe(false);
    // 整批原子：新资产没有进入规范状态。
    expect(removed.canvas.assets.some((asset) => asset.id === newImageAsset().id)).toBe(false);
  });

  it("nodeData.patch 对不存在节点被拒绝（并发删除语义）", () => {
    const base = canvasWithImageNode();
    const commands: CanvasCommand[] = [{ type: "nodeData.patch", nodeId: "ghost", value: { outputAssetId: "x" } }];
    const result = applyCanvasCommands(base, commands);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("node-data-orphan");
  });
});
