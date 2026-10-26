/**
 * 场景构建层的运行态回归
 * （change: show-agent-turn-running-state-on-node）。
 *
 * `run-state-projection` 的单测只证明纯函数会写 `busy`；这里补上"真实 `buildSceneWithResources`
 * 是否把该字段送到 render scene"这一层，因为 `busy` 由 contracts 的 `isBusy(nodeData)` 派生，
 * 一旦投影顺序或覆盖关系变化，节点就会看起来毫无反应。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { CanvasNodeRunSummary, CanvasOperationRecord, ServerCanvas } from "@woohaa3/contracts";
import { buildSceneWithResources } from "./scene-builder.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { InteractionControllerOptions } from "./interaction-types.js";

import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";

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

function sceneWith(runState: { summaries: CanvasNodeRunSummary[]; records: CanvasOperationRecord[] }, extra: Partial<InteractionControllerOptions> = {}) {
  const options = {
    canvas: {} as HTMLCanvasElement,
    getSession: () => null, getRunState: () => runState, ...extra
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


it("scene presentation and loading avoid repeated source-document searches", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("linear-scene");
  for (let i = 0; i < 100; i++) canvas.document.nodes.push({ id: `text-${i}`, type: "text", position: { x: i * 200, y: 0 } });
  woohaa3CanvasStore.getState().hydrate(canvas);
  const working = workingCanvasOf(woohaa3CanvasStore.getState())!;
  let comparisons = 0;
  const find = working.document.nodes.find.bind(working.document.nodes);
  const spy = vi.spyOn(working.document.nodes, "find").mockImplementation((predicate, thisArg) => find((node, index, nodes) => { comparisons++; return predicate.call(thisArg, node, index, nodes); }));
  try {
    for (const loading of [false, true]) {
      comparisons = 0;
      sceneWith({ summaries: [], records: [] }, { compositeAssets: new CompositeAssetRegistry(), isModelLoading: () => loading });
      expect(comparisons).toBeLessThanOrEqual(working.document.nodes.length * 10);
    }
  } finally { spy.mockRestore(); }
});


it("resolves a fresh model-loading reader once per scene, with per-node calls and legacy fallback", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("loading-reader");
  for (let i = 0; i < 100; i++) canvas.document.nodes.push({ id: `text-${i}`, type: "text", position: { x: i * 200, y: 0 } });
  woohaa3CanvasStore.getState().hydrate(canvas);
  const first = vi.fn((_id: string) => false), second = vi.fn((_id: string) => false), fallback = vi.fn((_id: string) => false);
  let reader: ((id: string) => boolean) | undefined = first;
  const getModelLoading = vi.fn(() => reader);
  const options = { getModelLoading, isModelLoading: fallback };
  sceneWith({ summaries: [], records: [] }, options);
  expect(getModelLoading).toHaveBeenCalledTimes(1);
  expect(first.mock.calls.map(call => call[0])).toEqual(canvas.document.nodes.map(node => node.id));
  expect(fallback).not.toHaveBeenCalled();
  reader = second;
  sceneWith({ summaries: [], records: [] }, options);
  expect(getModelLoading).toHaveBeenCalledTimes(2);
  expect(second).toHaveBeenCalledTimes(100);
  expect(first).toHaveBeenCalledTimes(100);
  reader = undefined;
  sceneWith({ summaries: [], records: [] }, options);
  expect(fallback).toHaveBeenCalledTimes(100);
  sceneWith({ summaries: [], records: [] }, { getModelLoading });
  expect(getModelLoading).toHaveBeenCalledTimes(4);
});
