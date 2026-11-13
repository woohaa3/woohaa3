/**
 * 驻留准入的真实运行时回归
 * （change: 2026-10-23-scale-canvas-media-residency，design D1/D3/D5）。
 *
 * 都是「逻辑正确但语义错位」的缺陷，单测只断言了硬上限所以漏过：
 * 1. 全页 GPU 估算预算是唯一准入上限：不能按离屏预览相机数量把普通媒体卡截断，否则视口内
 *    超过该数量的卡片永不加载，只能 hover 变 interactive 才显示（真实故障：整屏卡片
 *    「hover 才能加载」）。
 * 2. 内容身份（模型 prepared resource key）是异步就绪的，画布对象不变。候选表只按画布对象
 *    memo 时，首次投影早于资源就绪会让模型候选永久 `eligible: false`，payload lease 永远
 *    为空 → 被 Rust 淘汰后不再重建（真实故障：模型全部不显示）。
 * 3. 共享世界模型直接绘制在世界层，没有卡片 rect；它们始终常驻可见并提交 payload lease。
 */
import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, newWorldInstance } from "@woohaa3/contracts";
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
  onAdmittedContent?: (contentKeys: readonly string[], revision: number) => void;
}) {
  return createResidencyProjector({
    coordinator: options.coordinator,
    getCanvas: () => options.canvas,
    candidatesFor: options.candidatesFor,
    ...(options.contentVersion ? { contentVersion: options.contentVersion } : {}),
    ...(options.onAdmittedContent ? { onAdmittedContent: options.onAdmittedContent } : {}),
    viewport: () => ({ x: 0, y: 0, zoom: 1 }),
    surface: () => ({ width: 4000, height: 1000, pixelRatio: 1 }),
    interactive: () => [],
    pins: () => [],
    pageVisible: () => true
  });
}

describe("全页预算只按 GPU 估算收敛", () => {
  it("视口内大量图片卡全部准入，不靠 hover", () => {
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

    const coordinator = new CanvasResourceCoordinator();
    const candidatesFor = createResidencyCandidateCache(createContentIdentity({}));
    project({ canvas, coordinator, candidatesFor })();

    // 30 张图片都在视口内：卡片贴图只受全页 GPU 估算预算约束。
    expect(coordinator.admittedNodeIds()).toHaveLength(30);
    coordinator.dispose();
  });

  it("多个唯一共享世界资源全部获得 payload lease", () => {
    const worldIds = Array.from({ length: 21 }, (_, index) => `world-${index}`);
    const cardIds = Array.from({ length: 20 }, (_, index) => `card-${index}`);
    const canvas = canvasWith([
      ...worldIds.map(id => ({ id, type: "model3d", x: 100_000, y: 100_000 })),
      ...cardIds.map((id, index) => ({ id, type: "model3d", x: index * 120, y: 0 }))
    ]);
    for (const id of [...worldIds, ...cardIds]) {
      canvas.nodeData[id] = { sharedWorldInstance: newWorldInstance(`instance-${id}`, { x: 0, y: 0 }) };
    }
    const coordinator = new CanvasResourceCoordinator();
    const candidatesFor = createResidencyCandidateCache(
      createContentIdentity({ modelResourceKey: nodeId => `rk-${nodeId}` })
    );
    const onAdmittedContent = vi.fn();
    const projectOnce = project({ canvas, coordinator, candidatesFor, onAdmittedContent });
    projectOnce();

    const leased = onAdmittedContent.mock.calls[0]?.[0] as readonly string[];
    expect(coordinator.admittedNodeIds()).toHaveLength(worldIds.length + cardIds.length);
    expect(leased).toHaveLength(worldIds.length + cardIds.length);
    for (const id of worldIds) expect(leased).toContain(`rk-${id}`);
    for (const id of cardIds) expect(leased).toContain(`rk-${id}`);

    // 静止帧复用准入集合，不重复提交或丢失世界资源 lease。
    projectOnce();
    expect(onAdmittedContent).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });
});

describe("异步模型资源就绪后候选表失效", () => {
  it("资源在首次投影后才就绪时，模型进入需求并提交 payload lease", () => {
    const canvas = canvasWith([{ id: "m1", type: "model3d", x: 0, y: 0 }]);
    canvas.nodeData.m1 = {
      sharedWorldInstance: {
        kind: "world-instance", version: "shared-world-v1", instanceId: "instance-m1",
        transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
      }
    };
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
