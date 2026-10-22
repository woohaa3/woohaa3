/**
 * 单一提交边界测试：节点新增/移动/删除、连线/断开、视口、nodeData、assets、jobs
 * 都必须在一次提交内同时更新，且 revision / updatedAt 同步前进。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createWoohaa3CanvasNode, woohaa3CanvasSchemaVersion, type ServerCanvas } from "@woohaa3/contracts";
import { addCanvasNode,
  canvasGraphOf,
  commitCanvas,
  connectCanvasEdge,
  disconnectCanvasEdge,
  moveCanvasNodes,
  patchCanvasNodeData,
  setCanvasAssets,
  setCanvasJobs } from "./canvas-commit.js";

const NOW = "2026-09-22T12:00:00.000Z";
const LATER = "2026-09-22T12:00:05.000Z";

function emptyCanvas(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("canvas-test", NOW);
}

function expectOk(result: ReturnType<typeof commitCanvas>, expected: "changed" | "unchanged") {
  if (!result.ok) throw new Error(`期望提交成功，实际被拒绝: ${result.rejection.code}`);
  expect(result.changed).toBe(expected === "changed");
  return result.canvas;
}

describe("提交边界：结构化字段", () => {

  it("assets 与 jobs 也走同一提交边界", () => {
    let canvas = emptyCanvas();
    canvas = expectOk(
      setCanvasAssets(canvas, [{
        id: "asset-1",
        nodeId: "node-image",
        title: "生成图",
        mediaKind: "image",
        source: "generated",
        status: "ready",
        url: "asset://asset-1",
        createdAt: NOW
      }], { now: LATER }),
      "changed"
    );
    expect(canvas.assets.map((asset) => asset.id)).toEqual(["asset-1"]);

    const withJob = expectOk(
      setCanvasJobs(canvas, [{
        id: "job-1",
        nodeId: "node-image",
        taskId: "task-1",
        status: "running",
        updatedAt: LATER
      }], { now: LATER }),
      "changed"
    );
    expect(withJob.jobs.map((job) => job.id)).toEqual(["job-1"]);
    expect(withJob.revision).toBe(canvas.revision + 1);
    // assets 未被 jobs 提交清掉
    expect(withJob.assets.map((asset) => asset.id)).toEqual(["asset-1"]);
  });
});

describe("提交边界：拒绝与无操作", () => {
  it("无实际变化时不递增 revision", () => {
    const canvas = expectOk(
      addCanvasNode(emptyCanvas(), createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "node-image"), undefined, { now: NOW }),
      "changed"
    );
    const same = expectOk(
      moveCanvasNodes(canvas, { "node-image": { x: 0, y: 0 } }, { now: LATER }),
      "unchanged"
    );
    expect(same).toBe(canvas);
    expect(same.revision).toBe(canvas.revision);
  });

  it("指向不存在节点的连线和 nodeData 提交被拒绝且不改变聚合", () => {
    const canvas = expectOk(
      addCanvasNode(emptyCanvas(), createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "node-image"), undefined, { now: NOW }),
      "changed"
    );

    const badEdge = connectCanvasEdge(canvas, { id: "edge-x", source: "node-image", target: "node-missing" }, { now: LATER });
    expect(badEdge.ok).toBe(false);
    if (badEdge.ok) return;
    expect(badEdge.rejection.code).toBe("unknown-node");

    const orphan = patchCanvasNodeData(canvas, "node-missing", { panelPrompt: "x" }, { now: LATER });
    expect(orphan.ok).toBe(false);
    if (orphan.ok) return;
    expect(orphan.rejection.code).toBe("unknown-node");

    const orphanCommit = commitCanvas(canvas, { nodeData: { "node-missing": { panelPrompt: "x" } } }, { now: LATER });
    expect(orphanCommit.ok).toBe(false);
    if (orphanCommit.ok) return;
    expect(orphanCommit.rejection.code).toBe("node-data-orphan");
  });

  it("断开不存在的边被拒绝", () => {
    const canvas = expectOk(
      addCanvasNode(emptyCanvas(), createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "node-image"), undefined, { now: NOW }),
      "changed"
    );
    const result = disconnectCanvasEdge(canvas, "edge-missing", { now: LATER });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("unknown-edge");
    expect(canvas.revision).toBe(1);
  });
});

describe("规范投影与 schema", () => {
  it("渲染投影与 document 一致且 schema 保持 asset-canvas-v1", () => {
    const canvas = expectOk(
      addCanvasNode(emptyCanvas(), createWoohaa3CanvasNode("text", { x: 20, y: 40 }, "node-text"), undefined, { now: NOW }),
      "changed"
    );
    const graph = canvasGraphOf(canvas);
    expect(graph.nodes.map((node) => node.id)).toEqual(["node-text"]);
    expect(canvas.document.schemaVersion).toBe(woohaa3CanvasSchemaVersion);
    expect(canvas.document.schemaVersion).toBe("asset-canvas-v1");
  });
});
