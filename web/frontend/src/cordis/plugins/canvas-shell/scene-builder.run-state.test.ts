/**
 * 场景构建层的运行态回归
 * （change: show-agent-turn-running-state-on-node）。
 *
 * `run-state-projection` 的单测只证明纯函数会写 `busy`；这里补上"真实 `buildSceneWithResources`
 * 是否把该字段送到 render scene"这一层，因为 `busy` 由 contracts 的 `isBusy(nodeData)` 派生，
 * 一旦投影顺序或覆盖关系变化，节点就会看起来毫无反应。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { CanvasNodeRunSummary, CanvasOperationRecord, ServerCanvas } from "@woohaa3/contracts";
import { buildSceneWithResources } from "./scene-builder.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { InteractionControllerOptions } from "./interaction-types.js";

const NODE_ID = "agent-model";

function canvasWithModelNode(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-run-state");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: NODE_ID, type: "model3d", position: { x: 40, y: 40 }, width: 248, height: 232 }],
      edges: []
    }
  };
}

function sceneWith(runState: { summaries: CanvasNodeRunSummary[]; records: CanvasOperationRecord[] }) {
  const options = {
    canvas: {} as HTMLCanvasElement,
    getRunState: () => runState
  } as unknown as InteractionControllerOptions;
  const built = buildSceneWithResources(options, () => ({ width: 1280, height: 800, pixelRatio: 1 }), () => new Map(), {
    selected: [],
    draft: null,
    marquee: null,
    localPositions: new Map(),
    localSizes: new Map(),
    viewportPreview: null,
    fallbackViewport: { x: 0, y: 0, zoom: 1 },
    hoveredNodeId: null,
    hoveredPort: null,
    hoveredEdgeId: null
  });
  return built?.scene.nodes.find((node) => node.id === NODE_ID) ?? null;
}

describe("场景构建保留 Agent 回合运行态", () => {
  it("Agent 回合运行中时节点 busy，结束后不 busy", () => {
    woohaa3CanvasStore.getState().hydrate(canvasWithModelNode());
    const op: CanvasOperationRecord = {
      operationId: "agent:req-1",
      canvasId: "canvas-run-state",
      nodeId: NODE_ID,
      kind: "model",
      state: "running",
      owner: "server",
      createdAt: "2026-10-18T00:00:00.000Z",
      updatedAt: "2026-10-18T00:00:01.000Z"
    };
    const summary: CanvasNodeRunSummary = {
      canvasId: "canvas-run-state",
      nodeId: NODE_ID,
      active: op,
      isAggregate: false,
      aggregateRunning: false
    };

    const running = sceneWith({ summaries: [summary], records: [op] });
    expect(running).not.toBeNull();
    // canonical 上没有 taskStatus，运行态只能来自统一运行状态投影。
    expect(running!.busy).toBe(true);

    const idle = sceneWith({ summaries: [{ ...summary, active: null }], records: [] });
    expect(idle!.busy).toBe(false);
  });
});
