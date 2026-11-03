/**
 * 版本圆点搬运开关的场景层回归。
 *
 * 默认（false）Bevy 圆点原样保留；开启后图片节点的圆点进宿主 store、scene 里不再有 `historyStrip`。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { NodeGenerationHistoryListItem, ServerCanvas } from "@woohaa3/contracts";
import { buildSceneWithResources } from "./scene-builder.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { historyLayersStore } from "../../services/history-layers-store.js";
import type { InteractionControllerOptions } from "./interaction-types.js";

const NODE_ID = "img";

function canvasWithImageNode(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-layers");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: NODE_ID, type: "image", position: { x: 40, y: 40 }, width: 248, height: 232 }],
      edges: []
    }
  };
}

const version = (entryId: string, current: boolean) =>
  ({ current, entryId, createdAt: entryId, recoverable: true, source: { label: "test" }, preview: { kind: "text", excerpt: "t" } }) as unknown as NodeGenerationHistoryListItem;

function imageNodeFromScene(extra: Partial<InteractionControllerOptions>) {
  const options = {
    canvas: {} as HTMLCanvasElement,
    getSession: () => null,
    getRunState: () => ({ summaries: [], records: [], versionsByNode: new Map([[NODE_ID, [version("1", false), version("2", true)]]]) }),
    ...extra
  } as unknown as InteractionControllerOptions;
  const built = buildSceneWithResources(options, () => ({ width: 1280, height: 800, pixelRatio: 1 }), () => new Map(), {
    selected: [], draft: null, marquee: null, localPositions: new Map(), localSizes: new Map(), viewportPreview: null,
    fallbackViewport: { x: 0, y: 0, zoom: 1 }, hoveredNodeId: null, hoveredPort: null, hoveredEdgeId: null
  });
  return built?.scene.nodes.find((node) => node.id === NODE_ID) ?? null;
}

afterEach(() => historyLayersStore.reset());

describe("relocateHistoryStrips 开关", () => {
  it("默认不搬：scene 里保留 Bevy 圆点，store 为空", () => {
    woohaa3CanvasStore.getState().hydrate(canvasWithImageNode());
    const node = imageNodeFromScene({});
    expect(node?.historyStrip?.dots).toHaveLength(2);
    expect(historyLayersStore.getSnapshot().size).toBe(0);
  });

  it("开启后搬走：scene 里没有圆点，store 里有两层", () => {
    woohaa3CanvasStore.getState().hydrate(canvasWithImageNode());
    const node = imageNodeFromScene({ relocateHistoryStrips: true });
    expect(node?.historyStrip).toBeUndefined();
    expect(historyLayersStore.getSnapshot().get(NODE_ID)?.layers).toHaveLength(2);
  });
});
