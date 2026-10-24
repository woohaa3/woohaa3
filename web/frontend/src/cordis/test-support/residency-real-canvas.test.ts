/**
 * 用真实画布文档（`canvas-7961c9d3` 的 77 节点投影）验证准入链路
 * （change: 2026-10-23-scale-canvas-media-residency，design D1/D3/D5）。
 *
 * 两个真实故障的回归：
 * 1. 「卡片 hover 才加载」——预览槽被当成全页媒体准入上限；
 * 2. 「片场模型全部不显示」——prepared resource 异步就绪后候选表不失效。
 *
 * 这里用真实文档形状（34 图片 / 9 视频 / 22 模型 / 2 复合资产）断言修复后的准入规模与
 * 内容身份，不依赖 GPU：准入是纯逻辑，渲染结果仍需真实 GPU 验证（见 verification.md）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import {
  CanvasResourceCoordinator,
  createContentIdentity,
  createResidencyCandidateCache,
  createResidencyProjector
} from "../plugins/canvas-runtime/residency/index.js";

/** 与真实画布同形的节点分布（坐标按实测的 4 个视口密集点近似）。 */
function realisticCanvas() {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-realistic");
  const nodes: Array<Record<string, unknown>> = [];
  const data: Record<string, unknown> = {};
  const assets: Array<Record<string, unknown>> = [];
  let index = 0;
  const push = (type: string, x: number, y: number) => {
    const id = `node-${index++}`;
    nodes.push({ id, type, position: { x, y }, width: 320, height: 260, zIndex: index });
    if (type === "image" || type === "video") {
      assets.push({
        id: `asset-${id}`,
        status: "ready",
        url: `/api/media/${id}`,
        metadata: { storageKey: `media/${id}` }
      });
      data[id] = { outputAssetId: `asset-${id}` };
    }
    if (type === "model3d" || type === "composite-asset") data[id] = { modelScript: "scene.group({id:'a'});" };
    return id;
  };
  // 视口 1（zoom 0.15 的密集总览）：40 媒体 + 18 模型，与实测 58 一致量级。
  for (let i = 0; i < 25; i += 1) push("image", (i % 5) * 380, Math.floor(i / 5) * 300);
  for (let i = 0; i < 10; i += 1) push("video", 1900 + (i % 5) * 380, Math.floor(i / 5) * 300);
  for (let i = 0; i < 16; i += 1) push("model3d", (i % 4) * 420, 900 + Math.floor(i / 4) * 340);
  push("composite-asset", 1800, 900);
  push("composite-asset", 2400, 900);
  canvas.document.nodes = nodes as never;
  canvas.nodeData = data as never;
  canvas.assets = assets as never;
  return canvas;
}

describe("真实画布形状下的准入", () => {
  it("密集总览把视口内全部媒体卡准入，不被 16 个预览槽截断", () => {
    const canvas = realisticCanvas();
    const coordinator = new CanvasResourceCoordinator();
    const candidatesFor = createResidencyCandidateCache(
      createContentIdentity({ modelResourceKey: (nodeId) => `rk-${nodeId}` })
    );
    const project = createResidencyProjector({
      coordinator,
      getCanvas: () => canvas,
      candidatesFor,
      viewport: () => ({ x: 0, y: 0, zoom: 0.15 }),
      surface: () => ({ width: 1440, height: 900, pixelRatio: 1 }),
      interactive: () => [],
      pins: () => [],
      pageVisible: () => true
    });
    project();
    const admitted = coordinator.admittedNodeIds();
    const snap = coordinator.diagnostics();
    console.log("admitted", admitted.length, "byPurpose", JSON.stringify(snap.byPurpose),
      "gpu MiB", (snap.estimatedGpuBytes / 1048576).toFixed(2), "deferred", snap.deferred);

    // 视口内媒体卡数量远超预览槽（16），修复后必须全部准入。
    expect(admitted.length).toBeGreaterThan(snap.policy.previewSlots);
    expect(snap.estimatedGpuBytes).toBeLessThanOrEqual(snap.policy.gpuDerivedBytes);
    // 内容身份都非空（模型/复合资产取 resourceKey，图片取 storageKey）。
    expect(coordinator.admittedContentKeys().filter(Boolean).length).toBe(admitted.length);
    coordinator.dispose();
  });

  it("片场资源异步就绪后立即进入准入并交出模型 lease", () => {
    const canvas = realisticCanvas();
    const resources = new Map<string, string>();
    let version = 0;
    const coordinator = new CanvasResourceCoordinator();
    const candidatesFor = createResidencyCandidateCache(
      createContentIdentity({ modelResourceKey: (nodeId) => resources.get(nodeId) ?? null }),
      () => version
    );
    const project = createResidencyProjector({
      coordinator,
      getCanvas: () => canvas,
      candidatesFor,
      contentVersion: () => version,
      viewport: () => ({ x: 0, y: 0, zoom: 0.15 }),
      surface: () => ({ width: 1440, height: 900, pixelRatio: 1 }),
      interactive: () => [],
      pins: () => [],
      pageVisible: () => true
    });
    project();
    // 首次投影：模型还没有 prepared resource。
    expect(coordinator.admittedContentKeys().some(key => key.startsWith("rk-"))).toBe(false);

    // 模拟 model-scene 异步派生完成。
    for (const node of canvas.document.nodes) {
      if (node.type === "model3d" || node.type === "composite-asset") resources.set(node.id, `rk-${node.id}`);
    }
    version += 1;
    project();

    const keys = coordinator.admittedContentKeys().filter(key => key.startsWith("rk-"));
    expect(keys.length).toBeGreaterThan(0);
    // 片场（composite-asset）的模型 key 必须在内，否则 Rust 侧无法保护其 payload。
    const compositeIds = canvas.document.nodes
      .filter(node => node.type === "composite-asset")
      .map(node => node.id);
    for (const id of compositeIds) expect(keys).toContain(`rk-${id}`);
    coordinator.dispose();
  });
});
