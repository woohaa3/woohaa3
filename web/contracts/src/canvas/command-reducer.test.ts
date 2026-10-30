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
import { createFilmSetSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields } from "./film-set-clip-view.js";
import { defaultGroupAppearance } from "./group-appearance.js";
import { ContentContributionRegistry } from "./content-contribution.js";

/** 公开契约测试里的最小 owner codec：只验证注册表分派，不复制任何私有业务字段。 */
function testContent(): ContentContributionRegistry {
  const registry = new ContentContributionRegistry();
  registry.register({
    extensionId: "game-furnace",
    nodeData: {
      decode: (data) => ({ ok: true, value: data }),
      validatePatch: () => null,
      normalize: (data) => data,
      sanitizeRuntime: (data) => data,
      copy: (data) => ({ data, assetRefs: [], remap: {} }),
      diff: (before, after) => ({ ok: true, forward: after, inverse: before })
    }
  });
  return registry;
}

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
function withFilmSet(modelScript = ""): ServerCanvas {
  const canvas = base();
  canvas.document.nodes = [
    { id: "anim", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 }, width: 196, height: 64 }
  ];
  const animation = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: "",
    timeline: { duration: 0, loop: false }
  });
  canvas.nodeData = { anim: canonicalFilmSetFields(animation) as never };
  return canvas;
}

/** 带一个 model3d 节点的画布（内容身份归一化测试用）。 */
function withModel3d(modelScript: string): ServerCanvas {
  const canvas = base();
  canvas.document.nodes = [{ id: "model", type: "model3d", position: { x: 0, y: 0 } }];
  canvas.nodeData = {
    model: {
      title: "模型",
      modelScript,
      modelScriptLanguage: "javascript",
      modelScriptVersion: "woohaa-model-js-v2",
      modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "old-hash" },
      modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
    }
  };
  return canvas;
}

describe("自包含节点内容身份归一化（change: 2026-10-06，任务 1.2/1.4/R2）", () => {
  it("只改源码的 patch 不能保留旧 contentHash", () => {
    const canvas = withModel3d("scene.box({ id: 'a', size: [1,1,1] });");
    const result = applyCanvasCommands(canvas, [
      {
        type: "nodeData.patch",
        nodeId: "model",
        value: { modelScript: "scene.box({ id: 'a', size: [2,2,2] });", modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "old-hash" } }
      }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const version = result.canvas.nodeData.model.modelContentVersion as { revision: number; contentHash: string };
    expect(version.contentHash).not.toBe("old-hash");
    expect(version.revision).toBe(2);
  });

  it("相同内容重复 patch 不推进 revision", () => {
    const canvas = withModel3d("scene.box({ id: 'a', size: [1,1,1] });");
    const first = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "model", value: { modelScript: "scene.box({ id: 'a', size: [1,1,1] });" } }
    ], { now: NOW });
    if (!first.ok) return;
    const revision = (first.canvas.nodeData.model.modelContentVersion as { revision: number }).revision;
    const second = applyCanvasCommands(first.canvas, [
      { type: "nodeData.patch", nodeId: "model", value: { modelScript: "scene.box({ id: 'a', size: [1,1,1] });" } }
    ], { now: NOW });
    if (!second.ok) return;
    expect((second.canvas.nodeData.model.modelContentVersion as { revision: number }).revision).toBe(revision);
  });

  it("片场节点级顶层模型脚本写入被整批拒绝（items-only）", () => {
    const canvas = withFilmSet();
    const result = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "anim", value: { modelScript: "scene.box({ id: 'a' });" } }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-self-contained-node");
  });

  it("片场拒绝新的 groupAppearance：自身模型只由 items 组成", () => {
    const canvas = withFilmSet();
    const appearance = defaultGroupAppearance();
    appearance.model.modelScript = "scene.box({ id: 'appearance', size: [2,2,2] });";
    const result = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "anim", value: { groupAppearance: appearance } }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-self-contained-node");
    expect(canvas.nodeData.anim.groupAppearance).toBeUndefined();
    expect(canvas.nodeData.anim.filmSetContent).toBeDefined();
  });

  it("片场旧 groupAppearance 原样保留，但不接受修改", () => {
    const canvas = withFilmSet();
    const appearance = defaultGroupAppearance();
    canvas.nodeData.anim.groupAppearance = appearance;
    const preserved = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "anim", value: { groupAppearance: appearance } }
    ], { now: NOW });
    expect(preserved.ok).toBe(false);
    const changed = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "anim", value: { groupAppearance: { ...appearance, model: { ...appearance.model, modelScript: "scene.sphere({ id: 'x' });" } } } }
    ], { now: NOW });
    expect(changed.ok).toBe(false);
  });
});

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

describe("group parent 不变式（change: add-canvas-node-grouping，任务 1.2）", () => {
  /** 造一个含 group `g` 与成员 `a` 的画布。 */
  function withGroup(): ServerCanvas {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "g", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300 } },
      { type: "node.add", node: { id: "a", type: "image", position: { x: 20, y: 20 }, parentId: "g" } }
    ], { now: NOW });
    if (!result.ok) throw new Error("fixture 失败");
    return result.canvas;
  }

  it("接受挂到已有 group 下的成员", () => {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "g", type: "group", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "a", type: "image", position: { x: 10, y: 10 }, parentId: "g" } }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.nodes.find((n) => n.id === "a")?.parentId).toBe("g");
  });

  it("拒绝不存在的 parent", () => {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 }, parentId: "missing" } }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-parent");
  });

  it("拒绝把非 group 节点当作 parent", () => {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "b", type: "image", position: { x: 0, y: 0 }, parentId: "a" } }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-parent");
  });

  it("拒绝自指 parent", () => {
    const result = applyCanvasCommands(base(), [
      { type: "node.add", node: { id: "g", type: "group", position: { x: 0, y: 0 }, parentId: "g" } }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-parent");
  });

  it("拒绝形成 parent 环（batch 内中间状态也拒绝）", () => {
    const result = applyCanvasCommands(withGroup(), [
      { type: "node.update", nodeId: "g", parentId: "a" }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-parent");
  });

  it("node.update 允许解除 parent（parentId: null）", () => {
    const result = applyCanvasCommands(withGroup(), [
      { type: "node.update", nodeId: "a", parentId: null }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.nodes.find((n) => n.id === "a")?.parentId).toBeUndefined();
  });

  it("拒绝以 group 为端点的 edge.add", () => {
    const canvas = withGroup();
    const asSource = applyCanvasCommands(canvas, [
      { type: "edge.add", edge: { id: "e1", source: "g", target: "a" } }
    ], { now: NOW });
    expect(asSource.ok).toBe(false);
    if (!asSource.ok) expect(asSource.rejection.code).toBe("invalid-edge-endpoint");
    const asTarget = applyCanvasCommands(canvas, [
      { type: "node.add", node: { id: "b", type: "image", position: { x: 500, y: 0 } } },
      { type: "edge.add", edge: { id: "e2", source: "a", target: "g" } }
    ], { now: NOW });
    expect(asTarget.ok).toBe(false);
    if (!asTarget.ok) expect(asTarget.rejection.code).toBe("invalid-edge-endpoint");
  });

  it("拒绝 node.add.connect 连到 group", () => {
    const canvas = withGroup();
    const result = applyCanvasCommands(canvas, [
      { type: "node.add", node: { id: "b", type: "image", position: { x: 500, y: 0 } }, connect: { fromNodeId: "g", edgeId: "e3" } }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-edge-endpoint");
  });

  it("拒绝批次原子性：非法 parent 不会产生部分更新", () => {
    const canvas = withGroup();
    const result = applyCanvasCommands(canvas, [
      { type: "node.update", nodeId: "a", position: { x: 99, y: 99 } },
      { type: "node.update", nodeId: "a", parentId: "missing" }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 整批拒绝：canonical 不出现部分 parent/position 更新。
    expect(result.rejection.code).toBe("invalid-parent");
    expect(canvas.document.nodes.find((n) => n.id === "a")?.position).toEqual({ x: 20, y: 20 });
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

  function withExtension3d(): ServerCanvas {
    const canvas = base();
    canvas.document.nodes = [
      { id: "ext", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 }, width: 260, height: 195 }
    ];
    canvas.nodeData = {
      ext: {
        extensionId: "game-furnace",
        modelScript: "scene.box({ id: 'a', size: [1,1,1] });",
        modelScriptLanguage: "javascript",
        modelScriptVersion: "woohaa-model-js-v2",
        modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "old-hash" },
        modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
      }
    };
    return canvas;
  }

  it("普通模型脚本 patch 经 self-contained 归一化推进 contentHash", () => {
    const canvas = withExtension3d();
    const result = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "ext", value: { modelScript: "scene.box({ id: 'b', size: [2,2,2] });" } }
    ], { now: NOW, content: testContent() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.canvas.nodeData.ext as Record<string, unknown>;
      const version = data.modelContentVersion as { contentHash: string };
      // 只改源码的 patch 不能保留旧 contentHash（与 model3d 同规则）。
      expect(version.contentHash).not.toBe("old-hash");
    }
  });

  it("不能作为 edge 端点（source 与 target）", () => {
    const canvas = withComposite();
    canvas.document.nodes.push({ id: "img", type: "image", position: { x: 400, y: 0 } });
    const asSource = applyCanvasCommands(canvas, [
      { type: "edge.add", edge: { id: "e1", source: "ext", target: "img" } }
    ], { now: NOW });
    expect(asSource.ok).toBe(false);
    if (!asSource.ok) expect(asSource.rejection.code).toBe("invalid-connection");
    const asTarget = applyCanvasCommands(canvas, [
      { type: "edge.add", edge: { id: "e2", source: "img", target: "ext" } }
    ], { now: NOW });
    expect(asTarget.ok).toBe(false);
    if (!asTarget.ok) expect(asTarget.rejection.code).toBe("invalid-connection");
  });
});

describe("片场无连线与内容引用（change: 2026-10-08-make-film-set-model-only）", () => {
  it("片场不能作为 edge 端点（source 与 target）", () => {
    const canvas = withFilmSet();
    canvas.document.nodes.push({ id: "img", type: "image", position: { x: 300, y: 0 } });
    const asSource = applyCanvasCommands(canvas, [
      { type: "edge.add", edge: { id: "e1", source: "anim", target: "img" } }
    ], { now: NOW });
    expect(asSource.ok).toBe(false);
    if (!asSource.ok) expect(asSource.rejection.code).toBe("invalid-connection");
    const asTarget = applyCanvasCommands(canvas, [
      { type: "edge.add", edge: { id: "e2", source: "img", target: "anim" } }
    ], { now: NOW });
    expect(asTarget.ok).toBe(false);
    if (!asTarget.ok) expect(asTarget.rejection.code).toBe("invalid-connection");
  });

  it("加载规范化同批清除已有片场边与对应 inputMapping", () => {
    const canvas = withFilmSet();
    canvas.document.nodes.push({ id: "img", type: "image", position: { x: 300, y: 0 } });
    canvas.document.edges = [
      { id: "stale", source: "anim", target: "img", sourceHandle: null, targetHandle: null, data: {} }
    ];
    canvas.nodeData.img = {
      inputMapping: [{ sourceNodeId: "anim", role: "text_prompt", slotId: "in-0" }]
    };
    const result = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "img", value: { prompt: "x" } }
    ], { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.edges.some((edge) => edge.id === "stale")).toBe(false);
    expect(result.canvas.nodeData.img.inputMapping).toBeUndefined();
  });

  it("旧快照媒体写入即使资产就绪也拒绝", () => {
    const canvas = withFilmSet();
    const content = { schemaVersion: 4, items: [
      { id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } },
      { id: "img", kind: "image", name: "图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-image", aspectRatio: 1 }
    ] } as never;
    const missing = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "anim", value: { filmSetContent: content } }
    ], { now: NOW });
    expect(missing.ok).toBe(false);

    canvas.assets.push(imageAsset());
    const ok = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "anim", value: { filmSetContent: content } }
    ], { now: NOW });
    expect(ok.ok).toBe(false);
  });

  it("删除被片场引用的资产被拒绝", () => {
    const canvas = withFilmSet();
    canvas.assets.push(imageAsset());
    canvas.nodeData.anim.filmSetContent = { schemaVersion: 4, items: [
      { id: "ground", kind: "ground", name: "地面", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, size: { width: 8, depth: 8 } },
      { id: "img", kind: "image", name: "图", localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, assetId: "asset-image", aspectRatio: 1 }
    ] };
    const result = applyCanvasCommands(canvas, [
      { type: "asset.remove", assetId: "asset-image" }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("asset-in-use");
  });

  it("片场顶层模型脚本 patch 被拒绝且不改动集合", () => {
    const canvas = withFilmSet("scene.box({ id: 'a' });");
    const before = JSON.stringify(canvas.nodeData.anim.filmSetContent);
    const result = applyCanvasCommands(canvas, [
      { type: "nodeData.patch", nodeId: "anim", value: { modelScript: "scene.box({ id: 'b' });" } }
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-self-contained-node");
    expect(JSON.stringify(canvas.nodeData.anim.filmSetContent)).toBe(before);
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

describe("类别最小尺寸与历史记录", () => {
  it("显式尺寸写入按类别拒绝，拒绝时不改变规范画布", () => {
    const canvas = withFilmSet();
    const before = JSON.stringify(canvas);
    for (const size of [{ width: 180, height: 64 }, { width: 199 }, { height: 149 }]) {
      const result = applyCanvasCommands(canvas, [{ type: "node.update", nodeId: "anim", ...size }], { now: NOW });
      expect(result).toMatchObject({ ok: false, rejection: { code: "invalid-node-size" } });
      expect(JSON.stringify(canvas)).toBe(before);
    }
    const resized = applyCanvasCommands(canvas, [{ type: "node.update", nodeId: "anim", width: 200, height: 150 }], { now: NOW });
    expect(resized.ok).toBe(true);
    const normal = applyCanvasCommands(base(), [{ type: "node.add", node: { id: "normal", type: "text", position: { x: 0, y: 0 }, width: 180, height: 64 } }], { now: NOW });
    expect(normal.ok).toBe(true);
    const added = applyCanvasCommands(base(), [{ type: "node.add", node: { id: "small", type: "composite-asset", position: { x: 0, y: 0 }, width: 180, height: 64 }, nodeData: { extensionId: "creature-video-assets", extensionContentRef: { schemaVersion: 1, instanceId: "instance-123456" } } }], { now: NOW });
    expect(added).toMatchObject({ ok: false, rejection: { code: "invalid-node-size" } });
  });
  it("历史小片场移动与标题修改批次需先迁移", () => {
    const result = applyCanvasCommands(withFilmSet(), [
      { type: "node.update", nodeId: "anim", position: { x: 40, y: 50 } },
      { type: "nodeData.patch", nodeId: "anim", value: { title: "空场" } },
    ], { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("invalid-self-contained-node");
  });
});
