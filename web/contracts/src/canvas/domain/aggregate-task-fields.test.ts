/**
 * 任务生命周期字段的持久化往返（change: add-image-text-node-execution，任务 1.3）。
 *
 * `StoredJob.runId` / `error` 与节点 `nodeData.activeRunId` / `modelId` 必须能穿过
 * `parseCanvasAggregate`（IndexedDB 恢复走这条路）。若这里丢了字段，
 * latest-run-wins 在刷新后会失效，失败原因也会消失。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas,
  createWoohaa3CanvasNode,
  parseCanvasAggregate,
  toWoohaa3CanvasDocument } from "./index";

const NOW = "2026-09-23T00:00:00.000Z";
const NODE_ID = "node-image-1";

function canvasWithNode() {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-task", NOW);
  return {
    ...canvas,
    document: toWoohaa3CanvasDocument(
      {
        nodes: [createWoohaa3CanvasNode("image", { x: 0, y: 0 }, NODE_ID)],
        edges: []
      },
      NOW
    )
  };
}

describe("任务字段往返", () => {
  it("jobs 的 runId 与 error 在解析后仍然存在", () => {
    const parsed = parseCanvasAggregate(
      {
        ...canvasWithNode(),
        jobs: [
          {
            id: "job-1",
            nodeId: NODE_ID,
            taskId: "task-1",
            runId: "run-1",
            status: "failed",
            error: "上游超时",
            updatedAt: NOW
          }
        ]
      },
      { now: NOW }
    );
    if (!parsed.ok) throw new Error(`期望解析成功，实际失败: ${parsed.failure.code}`);
    expect(parsed.canvas.jobs).toHaveLength(1);
    expect(parsed.canvas.jobs[0]).toMatchObject({
      runId: "run-1",
      error: "上游超时",
      status: "failed"
    });
  });

  it("nodeData 的 activeRunId / modelId / outputAssetId 原样保留", () => {
    const parsed = parseCanvasAggregate(
      {
        ...canvasWithNode(),
        nodeData: {
          [NODE_ID]: {
            activeRunId: "run-9",
            modelId: "gpt-image-2",
            taskStatus: "successed",
            outputAssetId: "asset-1"
          }
        }
      },
      { now: NOW }
    );
    if (!parsed.ok) throw new Error(`期望解析成功，实际失败: ${parsed.failure.code}`);
    expect(parsed.canvas.nodeData[NODE_ID]).toMatchObject({
      activeRunId: "run-9",
      modelId: "gpt-image-2",
      taskStatus: "successed",
      outputAssetId: "asset-1"
    });
  });
});
