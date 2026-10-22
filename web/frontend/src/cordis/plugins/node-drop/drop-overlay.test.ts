// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { ServerCanvas } from "@woohaa3/contracts";
import type { CompositeAssetScopeGeometryEntry } from "../canvas-runtime/bevy-runtime.js";
import { createNodeDropOverlay } from "./drop-overlay.js";

const canvas = {
  document: { nodes: [
    { id: "group", type: "group", position: { x: 100, y: 50 } },
    { id: "film", type: "composite-asset", parentId: "group", position: { x: 120, y: 80 }, width: 300, height: 200 },
    { id: "game", type: "composite-asset", position: { x: 500, y: 80 }, width: 300, height: 200 },
    { id: "source", type: "image", position: { x: 0, y: 0 } },
  ] }, nodeData: {},
} as unknown as ServerCanvas;

/** accepted scope 几何：片场走类别默认等距平行四边形，另一个 fixture 覆盖 rect 分支，均按顶点点序绘制。 */
const scopes: CompositeAssetScopeGeometryEntry[] = [
  { nodeId: "film", shape: "isometric-diamond", vertices: [[20, 30], [80, 50], [20, 70], [-40, 50]], handles: [[20, 30], [50, 40], [80, 50], [50, 60], [20, 70], [-10, 60], [-40, 50], [-10, 40]], aabb: [-40, 30, 120, 40], base: [20, 40, 40, 20] },
  { nodeId: "game", shape: "rect", vertices: [[500, 80], [800, 80], [800, 280], [500, 280]], handles: [[650, 80], [800, 80], [800, 180], [800, 280], [650, 280], [500, 280], [500, 180], [500, 80]], aabb: [500, 80, 300, 200], base: [500, 80, 300, 200] },
];

const targets = ["film", "game"].map(id => ({
  nodeType: "composite-asset", matchesTarget: ({ targetNodeId }: { targetNodeId: string }) => targetNodeId === id,
  dropLabel: id === "film" ? "放到此处加入片场" : "放到此处加入游戏炼丹炉",
  onDrop: () => true,
  onPreview: () => null as string | null,
}));

function deps(overrides: Partial<Parameters<typeof createNodeDropOverlay>[0]> = {}) {
  return {
    worldToClient: (p: { x: number; y: number }) => ({ x: p.x * 2 + 10, y: p.y * 2 + 20 }),
    queryCompositeAssetScopes: () => ({ ok: true as const, generation: 1, value: scopes }),
    queryDropTarget: (point: { x: number; y: number }) => ({ ok: true as const, generation: 1, value: point.x < 200 ? "film" : "game" }),
    ...overrides,
  };
}

afterEach(() => document.body.replaceChildren());

it("draws each destination polygon from accepted scope geometry and tracks active target", () => {
  const overlay = createNodeDropOverlay(deps());
  overlay.update(canvas, targets, { sourceNodeIds: ["source"], point: { x: 20, y: 50 } });
  const film = document.querySelector<HTMLElement>('[data-node-id="film"]')!;
  expect(film.dataset.shape).toBe("isometric-diamond");
  expect(film.dataset.active).toBe("true");
  expect(film.textContent).toBe("放到此处加入片场");
  expect(film.querySelector("polygon")?.getAttribute("points")).toBe("50,80 170,120 50,160 -70,120");
  expect(film.style.left).toBe("-70px");
  expect(document.querySelector('[data-node-id="game"]')?.textContent).toBe("放到此处加入游戏炼丹炉");
  // 指针移到炉体：激活目标切换。
  overlay.update(canvas, targets, { sourceNodeIds: ["source"], point: { x: 600, y: 200 } });
  expect(document.querySelector<HTMLElement>('[data-node-id="game"]')?.dataset.active).toBe("true");
  expect(document.querySelector<HTMLElement>('[data-node-id="film"]')?.dataset.active).toBe("false");
});

it("hides all overlays when the accepted scope query is unavailable (no TS fallback)", () => {
  const overlay = createNodeDropOverlay(deps({
    queryCompositeAssetScopes: () => ({ ok: false as const, reason: "stale" as const }),
  }));
  overlay.update(canvas, targets, { sourceNodeIds: ["source"], point: { x: 20, y: 50 } });
  expect(document.querySelector(".node-drop-overlays")).toBeNull();
});

it("preserves rejection feedback, shape metadata and excludes dragged destinations", () => {
  const overlay = createNodeDropOverlay(deps({
    worldToClient: (p: { x: number; y: number }) => p,
    queryDropTarget: () => ({ ok: true as const, generation: 1, value: "film" }),
  }));
  overlay.update(canvas, [{ ...targets[0]!, onPreview: () => "当前素材无法加入片场" }, targets[1]!],
    { sourceNodeIds: ["game"], point: { x: 20, y: 50 } });
  expect(document.querySelector('[data-node-id="game"]')).toBeNull();
  const film = document.querySelector<HTMLElement>('[data-node-id="film"]')!;
  expect(film.textContent).toBe("当前素材无法加入片场");
  expect(film.dataset.unavailable).toBe("true");
  expect(film.dataset.shape).toBe("isometric-diamond");
  overlay.clear();
  expect(document.querySelector(".node-drop-overlays")).toBeNull();
});

it("skips destinations whose owner rejects the dragged sources (no receiving hint)", () => {
  // 接收方声明 acceptsSources 且只接受模型：拖图片时片场不点亮、不绘制提示。
  const onlyModels = {
    ...targets[0]!,
    acceptsSources: ({ sourceNodeIds }: { sourceNodeIds: readonly string[] }) => sourceNodeIds.every(id => id === "model"),
  };
  const overlay = createNodeDropOverlay(deps());
  overlay.update(canvas, [onlyModels, targets[1]!], { sourceNodeIds: ["image"], point: { x: 20, y: 50 } });
  expect(document.querySelector('[data-node-id="film"]')).toBeNull();
  // 炉体未声明谓词，仍按既有行为绘制提示。
  expect(document.querySelector('[data-node-id="game"]')?.textContent).toBe("放到此处加入游戏炼丹炉");
  // 拖模型时片场恢复提示与激活态。
  overlay.update(canvas, [onlyModels, targets[1]!], { sourceNodeIds: ["model"], point: { x: 20, y: 50 } });
  const film = document.querySelector<HTMLElement>('[data-node-id="film"]')!;
  expect(film.textContent).toBe("放到此处加入片场");
  expect(film.dataset.active).toBe("true");
});

it("treats a throwing acceptsSources predicate as not accepting", () => {
  const overlay = createNodeDropOverlay(deps());
  overlay.update(canvas, [{
    ...targets[0]!,
    acceptsSources: () => { throw new Error("boom"); },
  }], { sourceNodeIds: ["model"], point: { x: 20, y: 50 } });
  expect(document.querySelector('[data-node-id="film"]')).toBeNull();
});
