/**
 * 驻留准入的两个真实运行时回归
 * （change: 2026-10-23-scale-canvas-media-residency，design D1/D3/D5）。
 *
 * 两者都是「逻辑正确但语义错位」的缺陷，单测只断言了硬上限所以漏过：
 * 1. `previewSlots` 是**离屏预览渲染槽**上限（模型/复合资产），不是全页媒体准入上限。把它当成
 *    所有媒体卡的上限后，视口内超过 16 个卡片时其余卡片永不加载，只能 hover 变 interactive
 *    才显示（真实故障：整屏卡片「hover 才能加载」）。
 * 2. 内容身份（模型 prepared resource key）是异步就绪的，画布对象不变。候选表只按画布对象
 *    memo 时，首次投影早于资源就绪会让模型/片场候选永久 `eligible: false`，payload lease 永远
 *    为空 → 被 Rust 淘汰后不再重建（真实故障：片场节点模型全部不显示）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import {
  CanvasResourceCoordinator,
  createContentIdentity,
  createResidencyCandidateCache,
  createResidencyProjector
} from "../plugins/canvas-runtime/residency/index.js";

type NodeSpec = { id: string; type: string; x: number; y: number; width?: number; height?: number };

function canvasWith(nodes: readonly NodeSpec[]) {
  const canvas = createEmptyWoohaa3ServerCanvas("residency-probe");
  canvas.document.nodes = nodes.map((node, index) => ({
    id: node.id,
    type: node.type,
    position: { x: node.x, y: node.y },
    width: node.width ?? 200,
    height: node.height ?? 200,
    zIndex: index
  })) as never;
  return canvas;
}

function project(options: {
  canvas: ReturnType<typeof canvasWith>;
  coordinator: CanvasResourceCoordinator;
  candidatesFor: ReturnType<typeof createResidencyCandidateCache>;
  contentVersion?: () => number;
}) {
  return createResidencyProjector({
    coordinator: options.coordinator,
    getCanvas: () => options.canvas,
    candidatesFor: options.candidatesFor,
    ...(options.contentVersion ? { contentVersion: options.contentVersion } : {}),
    viewport: () => ({ x: 0, y: 0, zoom: 1 }),
    surface: () => ({ width: 4000, height: 1000, pixelRatio: 1 }),
    interactive: () => [],
    pins: () => [],
    pageVisible: () => true
  });
}

describe("预览槽只约束离屏预览需求", () => {
  it("视口内超过 previewSlots 张图片卡仍然全部准入，不靠 hover", () => {
    const canvas = canvasWith(
      Array.from({ length: 30 }, (_, index) => ({ id: `img-${index}`, type: "image", x: index * 120, y: 0 }))
    );
    canvas.assets = Array.from({ length: 30 }, (_, index) => ({
      id: `asset-${index}`,
      status: "ready",
      url: `/api/media/img-${index}`,
      metadata: { storageKey: `media/img-${index}` }
    })) as never;
    const nodeData = canvas.nodeData as unknown as Record<string, unknown>;
    for (let index = 0; index < 30; index += 1) {
      nodeData[`img-${index}`] = { outputAssetId: `asset-${index}` };
    }

    const coordinator = new CanvasResourceCoordinator({ policy: { previewSlots: 16 } });
    const candidatesFor = createResidencyCandidateCache(createContentIdentity({}));
    project({ canvas, coordinator, candidatesFor })();

    // 30 张图片都在视口内：预览槽是模型渲染槽，不该限制卡片贴图。
    expect(coordinator.admittedNodeIds()).toHaveLength(30);
    coordinator.dispose();
  });

  it("模型仍然受 previewSlots 约束，超出的模型明确延后", () => {
    const keys = new Map<string, string>();
    const canvas = canvasWith(
      Array.from({ length: 20 }, (_, index) => ({ id: `m-${index}`, type: "model3d", x: index * 120, y: 0 }))
    );
    for (let index = 0; index < 20; index += 1) keys.set(`m-${index}`, `rk-${index}`);

    const coordinator = new CanvasResourceCoordinator({ policy: { previewSlots: 16 } });
    const candidatesFor = createResidencyCandidateCache(
      createContentIdentity({ modelResourceKey: (nodeId) => keys.get(nodeId) ?? null })
    );
    project({ canvas, coordinator, candidatesFor })();

    expect(coordinator.admittedNodeIds()).toHaveLength(16);
    expect(coordinator.diagnostics().deferred).toBe(4);
    coordinator.dispose();
  });
});

describe("异步模型资源就绪后候选表失效", () => {
  it("资源在首次投影后才就绪时，模型进入需求并提交 payload lease", () => {
    const canvas = canvasWith([
      { id: "m1", type: "model3d", x: 0, y: 0 }
    ]);
    const resources = new Map<string, { resourceKey: string }>();
    let version = 0;
    const coordinator = new CanvasResourceCoordinator();
    const candidatesFor = createResidencyCandidateCache(
      createContentIdentity({
        modelResourceKey: (nodeId) => resources.get(nodeId)?.resourceKey ?? null
      }),
      () => version
    );
    const projectOnce = project({ canvas, coordinator, candidatesFor, contentVersion: () => version });

    // 首次投影：`model3d` 的 prepared resource 还没派生出来，因此没有可准入内容。
    projectOnce();
    expect(coordinator.admittedNodeIds()).toEqual([]);

    // 资源异步就绪（画布对象不变，只有内容版本推进）。
    resources.set("m1", { resourceKey: "rk-m1" });
    version += 1;
    projectOnce();

    expect(coordinator.admittedNodeIds()).toEqual(["m1"]);
    expect(coordinator.admittedContentKeys()).toEqual(["rk-m1"]);
    coordinator.dispose();
  });

});
