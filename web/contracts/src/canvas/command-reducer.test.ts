import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
/**
 * 共享命令 reducer 与 satisfaction 判定（change: add-frontend-speculative-canvas-state）。
 *
 * 覆盖全部 CanvasCommand、批次原子性、稳定 ID、最小尺寸以及 satisfaction 判定。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas, type StoredAsset } from "./domain/index.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";

import { isCanvasCommandBatchSatisfied, isCanvasCommandSatisfied } from "./command-satisfaction.js";
import { createWoohaa3CanvasNodeId, createHighEntropyId } from "./domain/index.js";
import { createWoohaa3CanvasEdge } from "./domain/index.js";

const NOW = "2026-09-26T00:00:00.000Z";

function base(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("c1", NOW);
}

function imageAsset(id = "asset-image"): StoredAsset {
  return {
    id,
    title: "图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    metadata: {
      storageKey: `sha256-${"a".repeat(64)}`,
      checksum: "a".repeat(64),
      contentType: "image/png",
      size: 4
    }
  };
}

/** 带一个 items-only 片场（composite-asset + film-set）节点的画布（change: 2026-10-11 身份/结构迁移）。 */
describe("applyCanvasCommands（共享 reducer）", () => {
  it("覆盖 node.add / nodeData.patch / edge.add 且只产生一个聚合", () => {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 100, y: 0 } }, connect: { fromNodeId: "a", edgeId: "e1" } },
      { type: "nodeData.patch", nodeId: "b", value: { prompt: "hi" } }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.canvas.document.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(result.canvas.document.edges[0]).toMatchObject({ id: "e1", source: "a", target: "b" });
    expect(result.canvas.nodeData.b).toMatchObject({ prompt: "hi" });
  });

  it("node.add.connect 保留客户端稳定 edgeId", () => {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 1, y: 0 } }, connect: { fromNodeId: "a", edgeId: "stable-edge" } }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.edges[0].id).toBe("stable-edge");
  });

  it("批次原子：后段失败不产生部分结果", () => {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } },
      { type: "edge.add", edge: { source: "a", target: "ghost" } }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-edge-endpoint");
  });

  it("创建命令缺少稳定 ID 被拒绝（design D7）", () => {
    const connectMissing = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 1, y: 0 } }, connect: { fromNodeId: "a" } }
    ], { now: NOW });
    expect(connectMissing.ok).toBe(false);
    if (connectMissing.ok) return;
    expect(connectMissing.rejection.code).toBe("missing-edge-id");

    const edgeMissing = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 1, y: 0 } } },
      { type: "edge.add", edge: { source: "a", target: "b" } }
    ], { now: NOW });
    expect(edgeMissing.ok).toBe(false);
    if (edgeMissing.ok) return;
    expect(edgeMissing.rejection.code).toBe("missing-edge-id");
  });

  it("最小尺寸：过小的 node.add / node.update 被拒绝", () => {
    const tooSmall = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 }, width: 10, height: 10 } }
    ], { now: NOW });
    expect(tooSmall.ok).toBe(false);
    if (tooSmall.ok) return;
    expect(tooSmall.rejection.code).toBe("invalid-node-size");
  });

  it("覆盖 edge.remove / asset / job / canvas.setTitle", () => {
    const withAll = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } },
      { type: "asset.upsert", asset: imageAsset("a1") },
      { type: "job.upsert", job: { id: "j1", nodeId: "a", taskId: "t", status: "running", updatedAt: NOW } },
      { type: "canvas.setTitle", title: "标题" }
    ], { now: NOW });
    expect(withAll.ok).toBe(true);
    if (!withAll.ok) return;
    expect(withAll.canvas.title).toBe("标题");
    expect(withAll.canvas.assets.map((a) => a.id)).toEqual(["a1"]);
    expect(withAll.canvas.jobs.map((j) => j.id)).toEqual(["j1"]);
    const removed = applyCanvasCommands(withAll.canvas, [
      { type: "asset.remove", assetId: "a1" },
      { type: "job.remove", jobId: "j1" }
    ], { now: NOW });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.canvas.assets).toEqual([]);
    expect(removed.canvas.jobs).toEqual([]);
  });

  it("无净变化 changed=false", () => {
    const canvas = base();
    const result = applyCanvasCommands(canvas, [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } },
      { type: "node.remove", nodeIds: ["a"] }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.canvas).toBe(canvas);
  });
});

describe("通用复合资产节点（change: 2026-10-11 身份迁移）", () => {
  function withComposite(): ServerCanvas {
    const canvas = base();
    canvas.document.nodes = [
      { id: "ext", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 }, width: 260, height: 195 }
    ];
    canvas.nodeData = { ext: { extensionId: "creature-video-assets" } };
    return canvas;
  }

  it("作为普通节点参与连线（source 与 target）", () => {
    const canvas = withComposite();
    canvas.document.nodes.push({ id: "img", type: "image", position: { x: 400, y: 0 } });
    const asSource = applyCanvasCommands(canvas, [
      { type: "edge.add", edge: { id: "e1", source: "ext", target: "img" } }
    ], { now: NOW });
    expect(asSource.ok).toBe(true);
    if (!asSource.ok) expect(asSource.rejection.code).toBe("invalid-connection");
    const asTarget = applyCanvasCommands(canvas, [
      { type: "edge.add", edge: { id: "e2", source: "img", target: "ext" } }
    ], { now: NOW });
    expect(asTarget.ok).toBe(true);
    if (!asTarget.ok) expect(asTarget.rejection.code).toBe("invalid-connection");
  });
});

describe("isCanvasCommandBatchSatisfied", () => {
  it("node.add 按稳定 ID 与位置判定", () => {
    const canvas = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 5, y: 6 } } }
    ], { now: NOW });
    expect(canvas.ok).toBe(true);
    if (!canvas.ok) return;
    expect(isCanvasCommandBatchSatisfied(canvas.canvas, [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 5, y: 6 } } }
    ])).toBe(true);
    expect(isCanvasCommandBatchSatisfied(canvas.canvas, [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 9, y: 6 } } }
    ])).toBe(false);
  });

  it("node.remove 按实体不存在判定", () => {
    expect(isCanvasCommandSatisfied(base(), { type: "node.remove", nodeIds: ["ghost"] })).toBe(true);
    const withNode = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], { now: NOW });
    if (!withNode.ok) return;
    expect(isCanvasCommandSatisfied(withNode.canvas, { type: "node.remove", nodeIds: ["a"] })).toBe(false);
  });

  it("node.update / nodeData.patch 按目标字段判定", () => {
    const canvas = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "nodeData.patch", nodeId: "a", value: { prompt: "x" } }
    ], { now: NOW });
    if (!canvas.ok) return;
    expect(isCanvasCommandSatisfied(canvas.canvas, { type: "node.update", nodeId: "a", position: { x: 0, y: 0 } })).toBe(true);
    expect(isCanvasCommandSatisfied(canvas.canvas, { type: "node.update", nodeId: "a", position: { x: 1, y: 0 } })).toBe(false);
    expect(isCanvasCommandSatisfied(canvas.canvas, { type: "nodeData.patch", nodeId: "a", value: { prompt: "x" } })).toBe(true);
    expect(isCanvasCommandSatisfied(canvas.canvas, { type: "nodeData.patch", nodeId: "a", value: { prompt: "y" } })).toBe(false);
  });

  it("node.add / node.update 的后置条件按持久化网格坐标判定", () => {
    const added = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 85.1, y: 95.61 } } }
    ], { now: NOW });
    if (!added.ok) return;

    expect(added.canvas.document.nodes[0]?.position).toEqual({ x: 85, y: 95.5 });
    expect(isCanvasCommandSatisfied(added.canvas, {
      type: "node.add",
      node: { id: "a", type: "text", position: { x: 85.1, y: 95.61 } }
    })).toBe(true);
    expect(isCanvasCommandSatisfied(added.canvas, {
      type: "node.update",
      nodeId: "a",
      position: { x: 85.1, y: 95.61 }
    })).toBe(true);
  });

  it("带连接的 node.add 需要稳定 edgeId 出现", () => {
    const canvas = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 1, y: 0 } }, connect: { fromNodeId: "a", edgeId: "e1" } }
    ], { now: NOW });
    if (!canvas.ok) return;
    expect(isCanvasCommandSatisfied(canvas.canvas, {
      type: "node.add",
      node: { id: "b", type: "image", position: { x: 1, y: 0 } },
      connect: { fromNodeId: "a", edgeId: "e1" }
    })).toBe(true);
  });
});

describe("稳定 ID 生成（design D7）", () => {
  it("节点 ID 高熵且不依赖时间戳唯一性", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createWoohaa3CanvasNodeId("text")));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^asset-text-/);
  });

  it("createHighEntropyId 使用 crypto.randomUUID 或高熵回退", () => {
    const a = createHighEntropyId("edge-x");
    const b = createHighEntropyId("edge-x");
    expect(a).not.toBe(b);
    expect(a.startsWith("edge-x-")).toBe(true);
  });

  it("createWoohaa3CanvasEdge 生成带高熵后缀的 ID", () => {
    const nodes = [
      { id: "a", type: "text", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "image", position: { x: 1, y: 0 }, data: {} }
    ];
    const edge = createWoohaa3CanvasEdge({ source: "a", target: "b", sourceHandle: null, targetHandle: null }, nodes as never);
    expect(edge).not.toBeNull();
    expect(edge!.id.startsWith("edge-a-b-")).toBe(true);
  });
});

describe("输入 mapping finalizer（change: add-reference-inputs-and-mentions，任务 2.1）", () => {
  it("edge.add 在同一提交内创建稳定 slot mapping", () => {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 200, y: 0 } } },
      { type: "edge.add", edge: { id: "e1", source: "a", target: "b" } }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mapping = result.canvas.nodeData.b?.inputMapping ?? [];
    expect(mapping).toHaveLength(1);
    expect(mapping[0]).toMatchObject({ sourceNodeId: "a" });
    expect(mapping[0]!.slotId).toBeTruthy();
  });

  it("edge.remove 在同一提交内删除对应 mapping 且保留其它 slot", () => {
    const connected = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 200, y: 0 } } },
      { type: "node.add", node: { id: "c", type: "image", position: { x: 400, y: 0 } } },
      { type: "edge.add", edge: { id: "e1", source: "a", target: "c" } },
      { type: "edge.add", edge: { id: "e2", source: "b", target: "c" } }
    ], { now: NOW });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    const before = connected.canvas.nodeData.c!.inputMapping!;
    const keepSlot = before.find((mapping) => mapping.sourceNodeId === "b")!.slotId;

    const removed = applyCanvasCommands(connected.canvas, [
      { type: "edge.remove", edgeId: "e1" }
    ], { now: NOW });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const after = removed.canvas.nodeData.c!.inputMapping ?? [];
    expect(after.map((mapping) => mapping.sourceNodeId)).toEqual(["b"]);
    // 其它 mapping 的 slotId 保持不变。
    expect(after[0]!.slotId).toBe(keepSlot);
  });

  it("node.remove 清理其作为 source 的 mapping", () => {
    const connected = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 200, y: 0 } } },
      { type: "edge.add", edge: { id: "e1", source: "a", target: "b" } }
    ], { now: NOW });
    if (!connected.ok) throw new Error("setup failed");
    const removed = applyCanvasCommands(connected.canvas, [
      { type: "node.remove", nodeIds: ["a"] }
    ], { now: NOW });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.canvas.nodeData.b?.inputMapping ?? []).toHaveLength(0);
  });
});

describe("类别最小尺寸", () => {
  it("显式尺寸写入低于类别下限时整批拒绝，拒绝时不改变规范画布", () => {
    const added = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "model", type: "model3d", position: { x: 0, y: 0 } } }
    ], { now: NOW });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const before = JSON.stringify(added.canvas);
    const result = applyCanvasCommands(added.canvas, [{ type: "node.update", nodeId: "model", width: 120 }], { now: NOW });
    expect(result).toMatchObject({ ok: false, rejection: { code: "invalid-node-size" } });
    expect(JSON.stringify(added.canvas)).toBe(before);
    const resized = applyCanvasCommands(added.canvas, [{ type: "node.update", nodeId: "model", width: 200, height: 200 }], { now: NOW });
    expect(resized.ok).toBe(true);
  });
});
