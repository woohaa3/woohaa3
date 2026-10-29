import { CANVAS_CAMERA_PITCH } from "./model-focus/canvas-projection.js";
import { filmSetMediaPlanesForNode } from "./render-scene.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ServerCanvas } from "./domain/index.js";
import {
  AGGREGATE_HANDLE_GAP,
  AGGREGATE_HANDLE_RADIUS,
  bevyAggregateHandle,
  bevyDragAttachActionBarRect,
  bevyDragAttachProbe,
  bevyEdgeDeleteHitRect,
  bevyEdgeDeleteRect,
  bevyEdgeHoverBridgeRect,
  bevyEdgeLabelRect,
  bevyKindForNodeType,
  bevyNodeSize,
  bevyNodeHistoryStripDot,
  bevyNodeHistoryStripRect,
  bevyPort,
  bevyResizeHandleRect,
  bevySelectionBounds,
  buildCanvasRenderScene,
  CANVAS_RENDER_SCENE_VERSION,
  compositeAssetScopeGeometry,
  DEFAULT_MODEL_PREVIEW,
  DRAG_ATTACH_ACTION_BAR_GAP,
  DRAG_ATTACH_ACTION_BAR_HEIGHT,
  DRAG_ATTACH_PROBE_LENGTH,
  dragAttachProbeIntersects,
  EDGE_DELETE_BUTTON_GAP,
  EDGE_DELETE_BUTTON_SIZE,
  edgeLabelWidth,
  EDGE_DELETE_HIT_PADDING,
  EDGE_HOVER_BRIDGE_PADDING,
  EDGE_LABEL_FONT,
  EDGE_LABEL_HEIGHT,
  EDGE_LABEL_MAX_WIDTH,
  EDGE_LABEL_PADDING,
  FOCUS_TRANSITION_VERSION,
  NODE_HISTORY_STRIP_DOT_RADIUS,
  NODE_HISTORY_STRIP_GAP,
  NODE_HISTORY_STRIP_HEIGHT,
  NODE_HISTORY_STRIP_PADDING,
  renderSceneEquals,
  renderSceneFingerprint
} from "./render-scene.js";
import {
  NODE_ACTION_TOOLBAR_ACTION_HEIGHT,
  NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH,
  NODE_ACTION_TOOLBAR_ACTION_PAD,
  NODE_ACTION_TOOLBAR_CHEVRON_WIDTH,
  NODE_ACTION_TOOLBAR_FONT,
  NODE_ACTION_TOOLBAR_GAP,
  NODE_ACTION_TOOLBAR_PAD,
  NODE_ACTION_TOOLBAR_SEPARATOR,
  NODE_ACTION_TOOLBAR_SUMMARY_GAP,
  NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH
} from "./render-scene/node-action-toolbar.js";
import {
  shotPreviewCardAttachment,
  shotPreviewContentRect
} from "./render-scene/shot-preview-projection.js";
import { SHOT_PREVIEW_HEADER_HEIGHT, shotPreviewNodeId } from "./film-set-shot-preview.js";
import { createFilmSetGroupMarker } from "./film-set-group.js";
import { createFilmSetSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields } from "./film-set-clip-view.js";
import { staticShotCameraMotion } from "./film-set-animations.js";
import {
  isActiveOperationState,
  isAggregateRunNode,
  isTerminalOperationState,
  summarizeRunStateByNode,
  type CanvasOperationRecord
} from "./run-state.js";
import { v2SceneExtent } from "./scene-ir-v2.js";
import { prepareModelResource } from "./prepared-model.js";
import { defaultGroupAppearance } from "./group-appearance.js";
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH, RESIZE_HANDLE_SIZE } from "./domain/index.js";
import type { CanvasRenderScene } from "./render-scene.js";
import { WOOHAA3_CANVAS_MAX_ZOOM, WOOHAA3_CANVAS_MIN_ZOOM } from "./domain/core/viewport-zoom.js";
import { MODEL_SCRIPT_SCENE_IR_V2_VERSION } from "./model-script.js";
import { defaultAppTheme, sentinelAppTheme } from "../theme/index.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";

function canvas(overrides: Partial<ServerCanvas> = {}): ServerCanvas {
  return {
    id: "c1",
    revision: 3,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [],
      edges: [],
      updatedAt: "2026-09-25T00:00:00.000Z"
    },
    nodeData: {},
    assets: [],
    jobs: [],
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...overrides
  };
}

describe("bevy kind mapping", () => {
  it("maps woohaa3 node types to the reference palette kinds", () => {
    expect(bevyKindForNodeType("text")).toBe("text");
    expect(bevyKindForNodeType("image")).toBe("image");
    expect(bevyKindForNodeType("model3d")).toBe("model");
    expect(bevyKindForNodeType(COMPOSITE_ASSET_NODE_TYPE)).toBe("model");
    expect(bevyKindForNodeType("audio")).toBe("audio");
    expect(bevyKindForNodeType("video")).toBe("video");
    expect(bevyKindForNodeType("group")).toBe("group");
    // 已下线的旧类型不再映射到 model/text，按未知节点回落。
    expect(bevyKindForNodeType("generate")).toBe("node");
    expect(bevyKindForNodeType("edit")).toBe("node");
    expect(bevyKindForNodeType("shot")).toBe("node");
    expect(bevyKindForNodeType("start")).toBe("node");
    expect(bevyKindForNodeType("future")).toBe("node");
  });

  it("自包含 3D 节点用显式分类名区分（change: 2026-10-05）", () => {
    const model = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "m", type: "model3d", position: { x: 0, y: 0 } },
            { id: "a", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 200, y: 0 } }
          ],
          edges: [],
          updatedAt: "2026-10-05T00:00:00.000Z"
        }
      })
    });
    expect(model.nodes.find((node) => node.id === "m")?.cardLabel).toBe("3D 模型");
    // 片场纯模型：不再有顶部卡片分类名，改为条件范围几何
    // （change: 2026-10-08-make-film-set-model-only）。
    const filmNode = model.nodes.find((node) => node.id === "a");
    expect(filmNode?.cardLabel).toBeUndefined();
    expect(filmNode?.compositeAsset).toBeDefined();
    // 普通 generate 已下线，不设覆盖（沿用未知节点行为，不恢复旧节点）。
    const plain = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "g", type: "generate", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-10-05T00:00:00.000Z"
        }
      })
    });
    expect(plain.nodes[0]?.cardLabel).toBeUndefined();
  });

  it("maps the generic pure-model extension node to model kind", () => {
    // 通用复合资产节点（change: 2026-10-10-add-game-furnace-extension；2026-10-11 身份迁移）：
    // 复用 model kind 与既有 Scene IR 渲染路径，无游戏专属分支。
    expect(bevyKindForNodeType(COMPOSITE_ASSET_NODE_TYPE)).toBe("model");
  });

  it("uses the reference node sizes", () => {
    expect(bevyNodeSize("text")).toEqual({ width: 248, height: 232 });
    expect(bevyNodeSize("model")).toEqual({ width: 196, height: 64 });
  });

  it("computes ports at the vertical midpoint", () => {
    const node = { x: 10, y: 20, width: 200, height: 100 };
    expect(bevyPort(node, "input")).toEqual({ x: 10, y: 70 });
    expect(bevyPort(node, "output")).toEqual({ x: 210, y: 70 });
  });
});

describe("group 投影（change: add-canvas-node-grouping，任务 2.1）", () => {
  function groupCanvas() {
    return canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [
          { id: "g", type: "group", position: { x: 100, y: 100 }, width: 500, height: 400 },
          { id: "a", type: "image", parentId: "g", position: { x: 20, y: 30 } },
          { id: "b", type: "image", parentId: "g", position: { x: 200, y: 100 } }
        ],
        edges: [],
        updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
  }

  it("成员位置投影为绝对画布坐标", () => {
    const scene = buildCanvasRenderScene({ canvas: groupCanvas(), theme: defaultAppTheme() });
    const a = scene.nodes.find((node) => node.id === "a")!;
    expect(a.type).toBe("image");
    // 局部 (20,30) + group (100,100) → 绝对 (120,130)。
    expect({ x: a.x, y: a.y }).toEqual({ x: 120, y: 130 });
  });

  it("renders each group before its members and later top-level nodes", () => {
    const base = groupCanvas();
    const scene = buildCanvasRenderScene({
      canvas: {
        ...base,
        document: {
          ...base.document,
          // Deliberately place the member before its parent to exercise the
          // derived hierarchy order used by the renderer.
          nodes: [
            { id: "a", type: "image", parentId: "g", position: { x: 20, y: 30 } },
            { id: "g", type: "group", position: { x: 100, y: 100 }, width: 500, height: 400 },
            { id: "outside", type: "image", position: { x: 120, y: 120 } },
          ],
        },
      },
      theme: defaultAppTheme(),
    });
    expect(scene.nodes.map((node) => node.id)).toEqual(["outside", "g", "a"]);
  });

  it("keeps ungrouped roots at the lowest layer and sorts groups by id", () => {
    const base = groupCanvas();
    const scene = buildCanvasRenderScene({
      canvas: {
        ...base,
        document: {
          ...base.document,
          nodes: [
            { id: "top-late", type: "image", position: { x: 0, y: 0 }, zIndex: 4 },
            { id: "member", type: "image", parentId: "group-late", position: { x: 20, y: 30 }, zIndex: 1 },
            { id: "group-late", type: "group", position: { x: 100, y: 100 }, width: 500, height: 400, zIndex: 3 },
            { id: "top-early", type: "image", position: { x: 0, y: 0 }, zIndex: 2 },
            { id: "group-early", type: "group", position: { x: 300, y: 100 }, width: 500, height: 400, zIndex: 99 },
          ],
        },
      },
      theme: defaultAppTheme(),
    });
    expect(scene.nodes.map((node) => node.id)).toEqual(["top-late", "top-early", "group-early", "group-late", "member"]);
  });

  it("marks only the transient drop target group", () => {
    const scene = buildCanvasRenderScene({
      canvas: groupCanvas(),
      theme: defaultAppTheme(),
      dropTargetGroupIds: new Set(["g"]),
    });
    expect(scene.nodes.find((node) => node.id === "g")?.group?.dropTarget).toBe(true);
    expect(scene.nodes.find((node) => node.id === "a")?.group).toBeUndefined();
  });

  it("group 携带 memberCount/outputCapableLeafCount 且不绘制 resize 抓手语义", () => {
    const scene = buildCanvasRenderScene({ canvas: groupCanvas(), theme: defaultAppTheme(), selection: { nodes: ["g"] } });
    const g = scene.nodes.find((node) => node.id === "g")!;
    expect(g.type).toBe("group");
    expect(g.group).toEqual({ title: "", memberCount: 2, outputCapableLeafCount: 2, collapsed: false, badgeScale: 1, badgeResizable: false });
    // 单选 group 时仍应可 resize（group 支持缩放）。
    expect(g.resizable).toBe(true);
  });

  it("group 标题来自 nodeData.title", () => {
    const base = groupCanvas();
    const scene = buildCanvasRenderScene({
      canvas: { ...base, nodeData: { g: { title: "镜头发散" } } },
      theme: defaultAppTheme()
    });
    expect(scene.nodes.find((node) => node.id === "g")!.group!.title).toBe("镜头发散");
  });

  it("group 复用 prepared resource 时同时下发 3D 模型引用", () => {
    const resource = prepareModelResource({
      sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION,
      ops: [{ t: "box", id: "body", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1], material: null, color: "#fff" }]
    });
    const scene = buildCanvasRenderScene({ canvas: groupCanvas(), modelResources: new Map([["g", resource]]) });
    expect(scene.nodes.find((node) => node.id === "g")!.model).toMatchObject({ resourceKey: resource.resourceKey, signature: resource.signature });
    expect(scene.nodes.find(node => node.id === "g")!.group!.modelBounds).toEqual({ aabb: resource.aabb, extent: resource.extent });
    const changed = structuredClone(scene);
    changed.nodes.find(node => node.id === "g")!.group!.modelBounds!.aabb.max[0] += 1;
    expect(renderSceneFingerprint(changed)).not.toBe(renderSceneFingerprint(scene));
    expect(renderSceneEquals(changed, scene)).toBe(false);
  });

  it("group 读取自身 groupAppearance 摆放，瞬时编辑优先", () => {
    const current = groupCanvas();
    const appearance = defaultGroupAppearance();
    appearance.model.placement = { offset: { x: 1, y: 2, z: 3 }, scale: 0.5, yaw: 45 };
    current.nodeData.g = { groupAppearance: appearance };
    const resource = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: [] });
    const input = { canvas: current, modelResources: new Map([["g", resource]]) };
    expect(buildCanvasRenderScene(input).nodes.find(node => node.id === "g")!.model!.placement)
      .toEqual(appearance.model.placement);
    const override = { offset: { x: 0, y: 0, z: 0 }, scale: 0.75, yaw: 90 };
    expect(buildCanvasRenderScene({ ...input, modelPlacements: new Map([["g", override]]) })
      .nodes.find(node => node.id === "g")!.model!.placement).toEqual(override);
  });

  it("嵌套 group 的叶子计数是递归的", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "g1", type: "group", position: { x: 0, y: 0 }, width: 600, height: 600 },
            { id: "g2", type: "group", parentId: "g1", position: { x: 20, y: 20 }, width: 300, height: 300 },
            { id: "leaf", type: "image", parentId: "g2", position: { x: 10, y: 10 } }
          ],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      theme: defaultAppTheme()
    });
    const g1 = scene.nodes.find((node) => node.id === "g1")!;
    expect(g1.group!.memberCount).toBe(1);
    expect(g1.group!.outputCapableLeafCount).toBe(1);
  });

  it("group 位置预览覆盖绝对坐标（拖拽 group 时）", () => {
    const scene = buildCanvasRenderScene({
      canvas: groupCanvas(),
      theme: defaultAppTheme(),
      positionOverrides: new Map([["g", { x: 700, y: 800 }]])
    });
    const g = scene.nodes.find((node) => node.id === "g")!;
    expect({ x: g.x, y: g.y }).toEqual({ x: 700, y: 800 });
  });
});

describe("buildCanvasRenderScene", () => {
  it("maps nodes, edges and selection into the Bevy snapshot", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "n1", type: "image", position: { x: 0, y: 0 } },
            { id: "n2", type: "start", position: { x: 300, y: 0 } }
          ],
          edges: [{ id: "e1", source: "n2", target: "n1", data: { label: "输入" }, sourceHandle: null, targetHandle: null }],
              updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      selection: { nodes: ["n1"], edge: "e1" }
    });
    expect(scene.version).toBe(CANVAS_RENDER_SCENE_VERSION);
    expect(scene.nodes).toHaveLength(2);
    expect(scene.nodes[0]).toMatchObject({ id: "n1", type: "image" });
    expect(scene.edges[0]).toMatchObject({ id: "e1", label: "输入" });
    expect(scene.selection).toEqual({ nodes: ["n1"], edge: "e1" });
  });

  it("动画播放投影进入快照并纳入 fingerprint", () => {    const playback = {
      nodeId: "n1",
      version: "woohaa-motion-ir-v1",
      time: 2,
      duration: 4,
      looped: false,
      playing: true,
      initialCamera: { azimuth: 0, elevation: 0.5, distance: 4, focusOffset: [0, 0, 0] as [number, number, number] },
      cameraMotion: [],
      modelMotion: []
    };
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "n1", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      animationPlayback: playback
    });
    expect(scene.animationPlayback).toEqual(playback);
    const without = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "n1", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      })
    });
    expect(renderSceneFingerprint(scene)).not.toBe(renderSceneFingerprint(without));
    expect(renderSceneEquals(scene, without)).toBe(false);
  });

  it("公共聚焦过渡进度进入快照并纳入 fingerprint（design D6/D7）", () => {
    const progress = {
      version: FOCUS_TRANSITION_VERSION,
      nodeId: "m1",
      kind: "model",
      progress: 0.5,
      runtimeGeneration: 3,
      transitionId: 7
    };
    const scene = buildCanvasRenderScene({ canvas: canvas(), focusTransition: progress });
    expect(scene.focusTransition).toEqual(progress);
    const without = buildCanvasRenderScene({ canvas: canvas() });
    expect(without.focusTransition).toBeUndefined();
    expect(renderSceneFingerprint(scene)).not.toBe(renderSceneFingerprint(without));
    expect(renderSceneEquals(scene, without)).toBe(false);
    // 进度推进改变 fingerprint（同一过渡的逐帧提交不被去重）。
    const advanced = buildCanvasRenderScene({ canvas: canvas(), focusTransition: { ...progress, progress: 0.75 } });
    expect(renderSceneFingerprint(advanced)).not.toBe(renderSceneFingerprint(scene));
  });

  it("运行中/已完成节点都不携带状态文案字段", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "running", type: "image", position: { x: 0, y: 0 } },
            { id: "done", type: "image", position: { x: 300, y: 0 } }
          ],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        },
        nodeData: {
          running: { taskStatus: "processing", progress: 42 },
          done: { taskStatus: "successed", progress: 100 }
        }
      })
    });
    const running = scene.nodes.find((node) => node.id === "running")!;
    const done = scene.nodes.find((node) => node.id === "done")!;
    // 运行中只由 busy + progress 驱动进度环；不产出「生成中」文案。
    expect(running).toMatchObject({ busy: true, progress: 42 });
    expect(running).not.toHaveProperty("status");
    // 完成节点不产出「已完成」标记。
    expect(done.busy).toBe(false);
    expect(done).not.toHaveProperty("status");
  });

  it("keeps edges for unknown node types", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "weird", type: "future", position: { x: 0, y: 0 } },
            { id: "n2", type: "text", position: { x: 300, y: 0 } }
          ],
          edges: [{ id: "e1", source: "weird", target: "n2", data: {}, sourceHandle: null, targetHandle: null }],
              updatedAt: "2026-09-25T00:00:00.000Z"
        }
      })
    });
    expect(scene.nodes[0]).toMatchObject({ id: "weird", type: "node" });
    expect(scene.edges).toHaveLength(1);
  });

  it("does not fall back to prompt when the output asset is missing", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }],
          edges: [],
              updatedAt: "2026-09-25T00:00:00.000Z"
        },
        nodeData: { n1: { outputAssetId: "missing", prompt: "hello" } }
      })
    });
    expect(scene.nodes[0].body).toBe("");
  });

  it("reads ready text assets for text bodies", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }],
          edges: [],
              updatedAt: "2026-09-25T00:00:00.000Z"
        },
        nodeData: { n1: { outputAssetId: "a1" } },
        assets: [{ id: "a1", title: "t", mediaKind: "text", source: "generated", status: "ready", text: "结果正文", createdAt: "2026-09-25T00:00:00.000Z" }]
      })
    });
    expect(scene.nodes[0].body).toContain("结果正文");
  });

  it("作品名称作为主标题，类型退居次要标记", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "n1", type: "image", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        },
        nodeData: { n1: { title: "海边日落" } }
      })
    });
    expect(scene.nodes[0].title).toBe("海边日落");
    expect(scene.nodes[0].typeLabel).toBe("图片");
  });

  it("无显式名称时主标题使用已提交提示词摘要，不读草稿", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "n1", type: "video", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        },
        nodeData: { n1: { prompt: "开场镜头：晨雾中的城市天际线" } }
      })
    });
    expect(scene.nodes[0].title).toContain("开场镜头");
    expect(scene.nodes[0].typeLabel).toBe("视频");
  });

  it("无名称与提示词时主标题使用中文默认名，body 不含名称", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "n1", type: "audio", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      })
    });
    expect(scene.nodes[0].title).toBe("未命名音频");
    expect(scene.nodes[0].typeLabel).toBe("音频");
    expect(scene.nodes[0].body).toBe("");
  });

  it("attaches a lightweight model reference when scene ops are provided", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "g1", type: "model3d", position: { x: 0, y: 0 } }],
          edges: [],
              updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      modelScenesV2: new Map([["g1", [{ t: "box", id: "b", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1], material: null, color: "#ff0000" }]]]),
      modelPlacements: new Map([["g1", { offset: { x: 1, y: 2, z: 3 }, scale: 2, yaw: 45 }]])
    });
    const model = scene.nodes[0].model;
    expect(model).toBeDefined();
    expect(model?.placement).toEqual({ offset: { x: 1, y: 2, z: 3 }, scale: 2, yaw: 45 });
    // 焦点：v5 只引用资源，不再内联 ops/payload。
    expect(model?.resourceKey).toMatch(/^woohaa-model-scene-ir-v2:/);
    expect(model?.signature).toHaveLength(16);
    expect(model).not.toHaveProperty("ops");
    expect(model).not.toHaveProperty("extent");
  });

  it("expands model3d previews and preserves explicit composite asset dimensions", () => {
    const current = canvas({document:{schemaVersion:"asset-canvas-v1",nodes:[
      {id:"model",type:"model3d",position:{x:0,y:0},width:196,height:64},
      {id:"film",type:COMPOSITE_ASSET_NODE_TYPE,position:{x:300,y:0},width:196,height:64}
    ],edges:[],updatedAt:"2026-10-08T00:00:00Z"}});
    const scene = buildCanvasRenderScene({canvas:current});
    expect(scene.nodes[0]).toMatchObject({width:248,height:232,modelPreview:{targetOffset:[0,0,0]}});
    // 默认视角正对模型正面（方位 0），保留 30° 俯视。
    expect(scene.nodes[0].modelPreview).toMatchObject({
      azimuth: DEFAULT_MODEL_PREVIEW.azimuth,
      elevation: DEFAULT_MODEL_PREVIEW.elevation
    });
    expect(DEFAULT_MODEL_PREVIEW.azimuth).toBe(0);
    // 旧小尺寸只在呈现中按类别下限 clamp，不回写文档。
    const filmNode = scene.nodes[1];
    expect(filmNode).toMatchObject({width:200,height:150});
    // 片场纯模型：无卡片分类名、无卡片预览，只有条件范围几何。
    expect(filmNode.cardLabel).toBeUndefined();
    expect(filmNode.modelPreview).toBeUndefined();
    expect(filmNode.compositeAsset).toBeDefined();
    // 范围框 = 节点矩形。
    expect(filmNode.compositeAsset).toMatchObject({x:300,y:0,width:200,height:150});
    const rotated = buildCanvasRenderScene({canvas:current,modelPreviews:new Map([["model",{azimuth:1,elevation:.3,distanceScale:1}]])});
    expect(renderSceneEquals(scene,rotated)).toBe(false);
    expect(current.document.nodes[0].height).toBe(64);
  });

  it("通用复合资产节点（composite-asset）无卡片、无预览、按范围几何呈现且不能连线", () => {
    // change: 2026-10-10-add-game-furnace-extension，design D2。
    const current = canvas({document:{schemaVersion:"asset-canvas-v1",nodes:[
      {id:"ext",type:COMPOSITE_ASSET_NODE_TYPE,position:{x:10,y:20}},
      {id:"img",type:"image",position:{x:400,y:0}}
    ],edges:[
      {id:"e1",source:"ext",target:"img",sourceHandle:null,targetHandle:null,data:{}},
      {id:"e2",source:"img",target:"ext",sourceHandle:null,targetHandle:null,data:{}},
      {id:"e3",source:"img",target:"img2",sourceHandle:null,targetHandle:null,data:{}}
    ],updatedAt:"2026-10-10T00:00:00Z"}});
    const scene = buildCanvasRenderScene({canvas:current});
    const ext = scene.nodes.find((node) => node.id === "ext")!;
    expect(ext.type).toBe("model");
    // 无卡片分类名、无卡片预览；默认范围尺寸 260x195，范围框 = 节点矩形。
    expect(ext.cardLabel).toBeUndefined();
    expect(ext.modelPreview).toBeUndefined();
    expect(ext).toMatchObject({width:260,height:195});
    expect(ext.compositeAsset).toMatchObject({x:10,y:20,width:260,height:195});
    // 纯模型节点不能作为边端点：映射层防御过滤其相关边。
    expect(scene.edges.map((edge) => edge.id)).toEqual(["e3"]);
  });

  it("复合资产默认等距范围，adapter 可覆盖为 rect 且进入 fingerprint", () => {
    // change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D3 修订：
    // 范围形状是复合资产类别的默认（等距地面范围），不再要求 adapter 显式声明。
    const current = canvas({document:{schemaVersion:"asset-canvas-v1",nodes:[
      {id:"asset",type:COMPOSITE_ASSET_NODE_TYPE,position:{x:0,y:0},width:260,height:195}
    ],edges:[],updatedAt:"2026-10-12T00:00:00Z"},nodeData:{asset:{extensionId:"game-furnace"}}});
    // 缺省（任意业务，包括炉体）：类别默认即 isometric-diamond，并派生地面矩形。
    const diamondScene = buildCanvasRenderScene({canvas:current});
    expect(diamondScene.nodes[0]!.compositeAsset).toMatchObject({
      x:0,y:0,width:260,height:195,scopeShape:"isometric-diamond"
    });
    // 基准矩形仍是 260×195（不是范围 AABB）；只附加形状与地面矩形声明。
    const diamondAsset = diamondScene.nodes[0]!.compositeAsset!;
    expect(diamondAsset.scopeGround).toBeDefined();
    // 地面范围永远平行网格，宽高比由当前相机俯仰角决定。
    const range = compositeAssetScopeGeometry(
      { x: diamondAsset.x, y: diamondAsset.y, width: diamondAsset.width, height: diamondAsset.height },
      "isometric-diamond",
      32,
      diamondAsset.scopeGround
    );
    expect(range.aabb.width / range.aabb.height).toBeCloseTo(1 / Math.sin(CANVAS_CAMERA_PITCH), 6);
    // 可信 adapter 覆盖为 rect：范围框即基准矩形，不写 scopeShape/scopeGround。
    const rectScene = buildCanvasRenderScene({
      canvas: current,
      compositeAssetScopeShapes: new Map([["asset", "rect"]])
    });
    expect(rectScene.nodes[0]!.compositeAsset).not.toHaveProperty("scopeShape");
    expect(rectScene.nodes[0]!.compositeAsset).not.toHaveProperty("scopeGround");
    expect(rectScene.nodes[0]!.compositeAsset).toMatchObject({x:0,y:0,width:260,height:195});
    expect(renderSceneEquals(rectScene, diamondScene)).toBe(false);
    expect(renderSceneFingerprint(rectScene)).not.toBe(renderSceneFingerprint(diamondScene));
  });

  it("复合资产业务类型名覆盖通用内容类型标签并进入 fingerprint", () => {
    // change: 2026-10-12-align-film-set-scope-with-isometric-grid：浮动名称面板标注聚合节点业务类型。
    const current = canvas({document:{schemaVersion:"asset-canvas-v1",nodes:[
      {id:"asset",type:COMPOSITE_ASSET_NODE_TYPE,position:{x:0,y:0},width:260,height:195}
    ],edges:[],updatedAt:"2026-10-12T00:00:00Z"},nodeData:{asset:{extensionId:"film-set"}}});
    // 缺省：回落通用内容类型标签「复合资产」。
    const fallback = buildCanvasRenderScene({ canvas: current });
    expect(fallback.nodes[0]!.typeLabel).toBe("复合资产");
    // 可信 adapter 声明的业务类型名覆盖通用标签。
    const labelled = buildCanvasRenderScene({
      canvas: current,
      compositeAssetTypeLabels: new Map([["asset", "片场"]])
    });
    expect(labelled.nodes[0]!.typeLabel).toBe("片场");
    expect(renderSceneFingerprint(labelled)).not.toBe(renderSceneFingerprint(fallback));
  });

  it("总览 LOD 策略声明注入 compositeAsset/group.geometryQuality 并进入 fingerprint，缺省不写入", () => {
    // change: 2026-10-15-add-film-set-overview-lod，design D1：只由可信 adapter 声明注入。
    const current = canvas({document:{schemaVersion:"asset-canvas-v1",nodes:[
      {id:"asset",type:COMPOSITE_ASSET_NODE_TYPE,position:{x:0,y:0},width:260,height:195}
    ],edges:[],updatedAt:"2026-10-12T00:00:00Z"},nodeData:{asset:{extensionId:"game-furnace"}}});
    // 缺省（普通卡片/炉体/第三方）：不写入，World 用途保持 High。
    const fallback = buildCanvasRenderScene({ canvas: current });
    expect(fallback.nodes[0]!.compositeAsset).not.toHaveProperty("geometryQuality");
    // 可信 adapter 声明后写入，并参与 fingerprint/equality。
    const declared = buildCanvasRenderScene({
      canvas: current,
      geometryQualities: new Map([["asset", "overview-primitives-v1"]])
    });
    expect(declared.nodes[0]!.compositeAsset?.geometryQuality).toBe("overview-primitives-v1");
    expect(renderSceneEquals(declared, fallback)).toBe(false);
    expect(renderSceneFingerprint(declared)).not.toBe(renderSceneFingerprint(fallback));
    // 声明不进入模型内容 identity：resourceKey/signature 不因策略声明改变。
    expect(declared.nodes[0]!.model?.resourceKey).toBe(fallback.nodes[0]!.model?.resourceKey);
  });

  it("总览 LOD 策略声明也可落到 group 徽标的呈现", () => {
    const current = canvas({document:{schemaVersion:"asset-canvas-v1",nodes:[
      {id:"group",type:"group",position:{x:0,y:0},width:400,height:300}
    ],edges:[],updatedAt:"2026-10-12T00:00:00Z"},nodeData:{group:{}}});
    const fallback = buildCanvasRenderScene({ canvas: current });
    expect(fallback.nodes[0]!.group).not.toHaveProperty("geometryQuality");
    const declared = buildCanvasRenderScene({
      canvas: current,
      geometryQualities: new Map([["group", "overview-primitives-v1"]])
    });
    expect(declared.nodes[0]!.group?.geometryQuality).toBe("overview-primitives-v1");
    expect(renderSceneFingerprint(declared)).not.toBe(renderSceneFingerprint(fallback));
  });

  it("preserves rich model card dimensions", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "default", type: "model3d", position: { x: 0, y: 0 }, width: 260, height: 195 },
            { id: "custom", type: "model3d", position: { x: 300, y: 0 }, width: 280, height: 180 }
          ],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      })
    });
    expect(scene.nodes[0]).toMatchObject({ width: 260, height: 195 });
    expect(scene.nodes[1]).toMatchObject({ width: 280, height: 180 });
  });

  it("does not change when only job internals change", () => {
    const base = canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }],
        edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
    const withJob = { ...base, jobs: [{ id: "j1", nodeId: "n1", taskId: "t", status: "running" as const, updatedAt: "z" }] };
    expect(renderSceneEquals(buildCanvasRenderScene({ canvas: base }), buildCanvasRenderScene({ canvas: withJob }))).toBe(true);
  });

  it("computes scene extent from ops", () => {
    expect(v2SceneExtent([])).toBe(2);
    const extent = v2SceneExtent([
      { t: "box", id: "b", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [4, 4, 4], material: null, color: "#ffffff" }
    ]);
    expect(extent).toBeGreaterThanOrEqual(4);
  });

  it("attaches a versioned V2 model reference derived from prepared metadata", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "g2", type: "model3d", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      modelScenesV2: new Map([["g2", [
        { t: "sphere", id: "s", parent: null, position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ff0000", radius: 1 }
      ]]])
    });
    expect(scene.nodes[0].model?.sceneVersion).toBe("woohaa-model-scene-ir-v2");
    expect(scene.nodes[0].model?.resourceKey).toMatch(/^woohaa-model-scene-ir-v2:/);
    // 同一内容签名稳定；placement 不进入 key。
    const again = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "g2", type: "model3d", position: { x: 10, y: 20 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      modelScenesV2: new Map([["g2", [
        { t: "sphere", id: "s", parent: null, position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ff0000", radius: 1 }
      ]]])
    });
    expect(again.nodes[0].model?.resourceKey).toBe(scene.nodes[0].model?.resourceKey);
  });

  it("直接使用 prepared model resource 时不在映射内重新派生", () => {
    const ops = [{ t: "box" as const, id: "b", parent: null, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], size: [4, 4, 4] as [number, number, number], material: null, color: "#ff0000" }];
    const resource = prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops });
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "g1", type: "model3d", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      modelResources: new Map([["g1", resource]])
    });
    expect(scene.nodes[0].model?.resourceKey).toBe(resource.resourceKey);
    expect(scene.nodes[0].model?.signature).toBe(resource.signature);
  });
});

describe("resize（change: add-node-resize）", () => {
  function resizableCanvas(node: { id: string; type: string; width?: number; height?: number }): ServerCanvas {
    return canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: node.id, type: node.type, position: { x: 0, y: 0 }, width: node.width, height: node.height }],
        edges: [],
        updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
  }

  it("仅唯一选中节点标记 resizable", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "n1", type: "image", position: { x: 0, y: 0 } },
            { id: "n2", type: "image", position: { x: 400, y: 0 } }
          ],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      selection: { nodes: ["n1"] }
    });
    expect(scene.nodes.find((node) => node.id === "n1")?.resizable).toBe(true);
    expect(scene.nodes.find((node) => node.id === "n2")?.resizable).toBe(false);
    // 多选不画抓手。
    const multi = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "n1", type: "image", position: { x: 0, y: 0 } },
            { id: "n2", type: "image", position: { x: 400, y: 0 } }
          ],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      selection: { nodes: ["n1", "n2"] }
    });
    expect(multi.nodes.every((node) => node.resizable === false)).toBe(true);
  });

  it("sizeOverrides 优先于规范尺寸", () => {
    const scene = buildCanvasRenderScene({
      canvas: resizableCanvas({ id: "n1", type: "image", width: 300, height: 200 }),
      sizeOverrides: new Map([["n1", { width: 420, height: 280 }]])
    });
    expect(scene.nodes[0]).toMatchObject({ width: 420, height: 280 });
  });

  it("把低于下限的尺寸 clamp 到共享最小值", () => {
    const scene = buildCanvasRenderScene({
      canvas: resizableCanvas({ id: "n1", type: "image", width: 40, height: 30 })
    });
    expect(scene.nodes[0]).toMatchObject({ width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT });
    const override = buildCanvasRenderScene({
      canvas: resizableCanvas({ id: "n1", type: "image", width: 300, height: 200 }),
      sizeOverrides: new Map([["n1", { width: 1, height: 1 }]])
    });
    expect(override.nodes[0]).toMatchObject({ width: MIN_NODE_WIDTH, height: MIN_NODE_HEIGHT });
  });

  it("抓手矩形贴住右下角且尺寸与常量一致", () => {
    const rect = bevyResizeHandleRect({ x: 10, y: 20, width: 200, height: 100 });
    expect(rect).toEqual({ x: 10 + 200 - RESIZE_HANDLE_SIZE, y: 20 + 100 - RESIZE_HANDLE_SIZE, width: RESIZE_HANDLE_SIZE, height: RESIZE_HANDLE_SIZE });
  });

  it("节点尺寸不受宽高比锁定：任意宽高都被接受", () => {
    // 节点可自由缩放为任意比例（媒体在 Bevy 侧按自身比例 contain）。
    const wide = buildCanvasRenderScene({
      canvas: resizableCanvas({ id: "n1", type: "image", width: 600, height: 120 })
    });
    expect(wide.nodes[0]).toMatchObject({ width: 600, height: 120 });
    const tall = buildCanvasRenderScene({
      canvas: resizableCanvas({ id: "n1", type: "image", width: 200, height: 500 })
    });
    expect(tall.nodes[0]).toMatchObject({ width: 200, height: 500 });
  });

  it("幽灵节点（上传中）作为普通节点合并且标记 ghost/busy", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas(),
      ghostNodes: [
        { id: "g1", nodeType: "image", x: 10, y: 20, label: "a.png", status: "上传中", progress: 40, texture: false }
      ]
    });
    expect(scene.nodes).toHaveLength(1);
    expect(scene.nodes[0]).toMatchObject({
      id: "g1",
      type: "image",
      x: 10,
      y: 20,
      body: "a.png",
      progress: 40,
      busy: true,
      ghost: true,
      resizable: false,
      texture: false
    });
    // 节点卡片不显示状态文案：诊断 status 不进入快照。
    expect(scene.nodes[0]).not.toHaveProperty("status");
  });

  it("同 id 真实节点存在时跳过幽灵节点（无跳变接管）", () => {
    const base = canvas();
    const withNode: ServerCanvas = {
      ...base,
      document: {
        ...base.document,
        nodes: [{ id: "g1", type: "image", position: { x: 1, y: 2 } }]
      }
    };
    const scene = buildCanvasRenderScene({
      canvas: withNode,
      ghostNodes: [{ id: "g1", nodeType: "image", x: 10, y: 20, label: "ghost" }]
    });
    // 只保留真实节点，ghost 被抑制且不标记。
    expect(scene.nodes).toHaveLength(1);
    expect(scene.nodes[0]!.ghost).toBeUndefined();
  });

  it("Bevy 的 RESIZE_HANDLE_SIZE 与 contracts 保持一致", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // 常量已随 `refactor-bevy-runtime-modules` 迁到 canvas2d::layout。
    const rust = readFileSync(resolve(here, "../../../../bevy/src/canvas_query/layout.rs"), "utf8");
    const match = rust.match(/const RESIZE_HANDLE_SIZE: f32 = ([\d.]+);/);
    expect(match, "bevy 缺少 RESIZE_HANDLE_SIZE").toBeTruthy();
    expect(Number(match![1])).toBe(RESIZE_HANDLE_SIZE);
  });

  it("Bevy 视口缩放校验区间与 contracts 一致（change: fix-viewport-zoom-range）", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/protocol/scene.rs"), "utf8");
    const match = rust.match(/\(([\d]+(?:\.[\d]+)?)\.\.=([\d]+(?:\.[\d]+)?)\)\.contains\(&self\.viewport\.zoom\)/);
    expect(match, "bevy 缺少 viewport.zoom 区间校验").toBeTruthy();
    expect(Number(match![1])).toBe(WOOHAA3_CANVAS_MIN_ZOOM);
    expect(Number(match![2])).toBe(WOOHAA3_CANVAS_MAX_ZOOM);
  });

  it("Bevy 历史条常量与 contracts 保持一致（change: 2026-10-12-unify-generation-history-strip）", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/canvas_query/layout.rs"), "utf8");
    const expectConst = (name: string, value: number): void => {
      const match = rust.match(new RegExp(`const ${name}: f32 = ([\\d.]+);`));
      expect(match, `bevy 缺少 ${name}`).toBeTruthy();
      expect(Number(match![1])).toBe(value);
    };
    expectConst("NODE_HISTORY_STRIP_HEIGHT", NODE_HISTORY_STRIP_HEIGHT);
    expectConst("NODE_HISTORY_STRIP_DOT_RADIUS", NODE_HISTORY_STRIP_DOT_RADIUS);
    expectConst("NODE_HISTORY_STRIP_GAP", NODE_HISTORY_STRIP_GAP);
    expectConst("NODE_HISTORY_STRIP_PADDING", NODE_HISTORY_STRIP_PADDING);
  });
});

describe("theme snapshot（change: unify-application-theme-tokens，任务 3.1 / 3.2 / 3.4）", () => {
  it("默认注入内置主题，fingerprint 稳定", () => {
    const scene = buildCanvasRenderScene({ canvas: canvas() });
    expect(scene.theme.id).toBe(defaultAppTheme().id);
    expect(scene.theme.fingerprint).toBe(defaultAppTheme().fingerprint);
  });

  it("仅 theme fingerprint 变化时 render equality 判定需要重绘", () => {
    const base = canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }],
        edges: [],
        updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
    const left = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme() });
    const right = buildCanvasRenderScene({ canvas: base, theme: sentinelAppTheme() });
    expect(renderSceneEquals(left, right)).toBe(false);
    // canvas revision 与所有 canonical 字段保持不变。
    expect(right.revision).toBe(left.revision);
    expect(right.nodes).toEqual(left.nodes);
    expect(right.edges).toEqual(left.edges);
    expect(right.viewport).toEqual(left.viewport);
    expect(right.selection).toEqual(left.selection);
  });

  it("相同 theme 不产生多余重绘", () => {
    const a = buildCanvasRenderScene({ canvas: canvas(), theme: defaultAppTheme() });
    const b = buildCanvasRenderScene({ canvas: canvas(), theme: defaultAppTheme() });
    expect(renderSceneEquals(a, b)).toBe(true);
  });

  it("非法 theme snapshot 被拒绝（不降级为混合主题）", () => {
    expect(() => buildCanvasRenderScene({ canvas: canvas(), theme: { id: "x", version: "bad", tokens: {} } })).toThrow();
    expect(() => buildCanvasRenderScene({ canvas: canvas(), theme: { id: "x", version: "woohaa-app-theme-v1", tokens: {} } })).toThrow();
  });

  it("scene 使用 v20 协议并包含预览卡片、归属线与横条动作声明，且与 Rust 常量一致", () => {
    expect(CANVAS_RENDER_SCENE_VERSION).toBe("woohaa-canvas-render-scene-v31");
    // 跨语言版本必须同步：Rust `Scene::validate` 按版本拒绝整帧，任一侧漏改会让画布静止
    // （change: 2026-10-12-unify-generation-history-strip）。
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/protocol/model.rs"), "utf8");
    const match = rust.match(/CANVAS_RENDER_SCENE_VERSION: &str = "(woohaa-canvas-render-scene-v\d+)"/);
    expect(match, "bevy 缺少 CANVAS_RENDER_SCENE_VERSION").toBeTruthy();
    expect(match![1]).toBe(CANVAS_RENDER_SCENE_VERSION);
  });
});

describe("节点内部历史圆点几何", () => {
  it("圆点区域在节点内部底部，并留出右下角 resize 抓手", () => {
    const node = { x:100, y:50, width:248, height:232 };
    const strip = bevyNodeHistoryStripRect(node), resize = bevyResizeHandleRect(node);
    expect(strip).toEqual({x:124,y:262,width:200,height:16});
    expect(strip.y + strip.height).toBeLessThan(node.y + node.height);
    expect(strip.x + strip.width).toBeLessThanOrEqual(resize.x);
  });
  it("圆点紧凑居中且大量版本不超出节点", () => {
    const node = { x:0,y:0,width:248,height:232 };
    expect(bevyNodeHistoryStripDot(node,0,3)).toEqual({x:112,y:220});
    expect(bevyNodeHistoryStripDot(node,2,3)).toEqual({x:136,y:220});
    for (let index=0; index<24; index++) {
      const dot=bevyNodeHistoryStripDot(node,index,24);
      expect(dot.x).toBeGreaterThan(24);
      expect(dot.x).toBeLessThan(224);
    }
  });
});

describe("统一生成运行状态契约（change: 2026-10-12-unify-generation-history-strip）", () => {
  it("聚合节点谓词当前只认片场，不为不存在的类型造占位", () => {
    expect(isAggregateRunNode({ type: "composite-asset" })).toBe(true);
    expect(isAggregateRunNode({ type: "model3d" })).toBe(false);
    expect(isAggregateRunNode({ type: "image" })).toBe(false);
    expect(isAggregateRunNode({ type: "group" })).toBe(false);
  });

  it("按节点归约运行摘要并驱动聚合遮罩", () => {
    const records: CanvasOperationRecord[] = [
      record("o1", "n1", "running", "server"),
      record("o2", "n1", "succeeded", "server"),
      record("o3", "n2", "succeeded", "local")
    ];
    const summaries = summarizeRunStateByNode({
      canvasId: "c",
      records,
      aggregateNodeIds: ["n1"]
    });
    const n1 = summaries.get("n1");
    expect(n1?.active?.operationId).toBe("o1");
    expect(n1?.isAggregate).toBe(true);
    expect(n1?.aggregateRunning).toBe(true);
    const n2 = summaries.get("n2");
    expect(n2?.active).toBeNull();
    expect(n2?.aggregateRunning).toBe(false);
  });

  it("非终态状态分类", () => {
    expect(isActiveOperationState("queued")).toBe(true);
    expect(isActiveOperationState("interrupted")).toBe(true);
    expect(isActiveOperationState("succeeded")).toBe(false);
    expect(isTerminalOperationState("partial")).toBe(true);
    expect(isTerminalOperationState("running")).toBe(false);
  });
});

function record(
  operationId: string,
  nodeId: string,
  state: CanvasOperationRecord["state"],
  owner: CanvasOperationRecord["owner"]
): CanvasOperationRecord {
  return {
    operationId,
    canvasId: "c",
    nodeId,
    kind: "image",
    state,
    owner,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z"
  };
}

describe("边删除按钮位置（change: add-edge-hover-delete）", () => {
  it("无标签时按钮居中于连线中点、边长与 Bevy 常量一致", () => {
    const source = { x: 0, y: 0, width: 200, height: 100 };
    const target = { x: 400, y: 200, width: 200, height: 100 };
    // 输出端口 (200,50)，输入端口 (400,250) → 中点 (300,150)。
    expect(bevyPort(source, "output")).toEqual({ x: 200, y: 50 });
    expect(bevyPort(target, "input")).toEqual({ x: 400, y: 250 });
    const rect = bevyEdgeDeleteRect(source, target);
    expect(rect.width).toBe(EDGE_DELETE_BUTTON_SIZE);
    expect(rect.height).toBe(EDGE_DELETE_BUTTON_SIZE);
    expect(rect.x + rect.width / 2).toBe(300);
    expect(rect.y + rect.height / 2).toBe(150);
  });

  it("标签胶囊按内容收缩，两个字不再占八个字宽", () => {
    // "图片" = 2 个汉字 → 22px 文本 + 16px 内边距 = 38px，而不是固定 104px。
    const width = edgeLabelWidth("图片");
    expect(width).toBe(EDGE_LABEL_FONT * 2 + EDGE_LABEL_PADDING * 2);
    expect(width).toBeLessThan(EDGE_LABEL_MAX_WIDTH);
    const label = bevyEdgeLabelRect({ x: 0, y: 0, width: 100, height: 50 }, { x: 100, y: 300, width: 100, height: 50 }, "图片");
    expect(label.width).toBe(width);
    expect(label.x + label.width / 2).toBe(100);
  });

  it("有标签时按钮排在标签胶囊右侧，纵向仍对齐中点", () => {
    const source = { x: 0, y: 0, width: 200, height: 100 };
    const target = { x: 400, y: 200, width: 200, height: 100 };
    const labelWidth = edgeLabelWidth("图片");
    const rect = bevyEdgeDeleteRect(source, target, "图片");
    const expectedCenterX =
      300 + labelWidth / 2 + EDGE_DELETE_BUTTON_GAP + EDGE_DELETE_BUTTON_SIZE / 2;
    expect(rect.x + rect.width / 2).toBe(expectedCenterX);
    expect(rect.y + rect.height / 2).toBe(150);
    // 按钮左缘不早于标签胶囊右缘（不遮挡标签）。
    const labelRight = 300 + labelWidth / 2;
    expect(rect.x).toBeGreaterThanOrEqual(labelRight + EDGE_DELETE_BUTTON_GAP);
    // 窄标签把按钮留在曲线附近：两个字时中心仅离中点 32px，远小于旧固定宽度的一半。
    expect(rect.x + rect.width / 2 - 300).toBeLessThan(EDGE_LABEL_MAX_WIDTH / 2);
  });

  it("Bevy 的 EDGE_DELETE_BUTTON_SIZE 与 contracts 保持一致", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/canvas_query/layout.rs"), "utf8");
    const match = rust.match(/const EDGE_DELETE_BUTTON_SIZE: f32 = ([\d.]+);/);
    expect(match, "bevy 缺少 EDGE_DELETE_BUTTON_SIZE").toBeTruthy();
    expect(Number(match![1])).toBe(EDGE_DELETE_BUTTON_SIZE);
  });

  it("Bevy 的标签与间隙常量与 contracts 保持一致", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/canvas_query/layout.rs"), "utf8");
    for (const [name, value] of [
      ["EDGE_LABEL_MAX_WIDTH", EDGE_LABEL_MAX_WIDTH],
      ["EDGE_LABEL_HEIGHT", EDGE_LABEL_HEIGHT],
      ["EDGE_LABEL_FONT", EDGE_LABEL_FONT],
      ["EDGE_LABEL_PADDING", EDGE_LABEL_PADDING],
      ["EDGE_DELETE_BUTTON_GAP", EDGE_DELETE_BUTTON_GAP],
      ["EDGE_DELETE_HIT_PADDING", EDGE_DELETE_HIT_PADDING],
      ["EDGE_HOVER_BRIDGE_PADDING", EDGE_HOVER_BRIDGE_PADDING]
    ] as const) {
      const match = rust.match(new RegExp(`const ${name}: f32 = ([\\d.]+);`));
      expect(match, `bevy 缺少 ${name}`).toBeTruthy();
      expect(Number(match![1])).toBe(value);
    }
  });

  it("删除按钮命中区外扩，并与标签胶囊相接（修复：删除按钮悬停丢失）", () => {
    const source = { x: 0, y: 0, width: 100, height: 50 };
    const target = { x: 100, y: 300, width: 100, height: 50 };
    const visual = bevyEdgeDeleteRect(source, target, "图片");
    const hit = bevyEdgeDeleteHitRect(source, target, "图片");
    // 视觉仍是 18px，命中区四向外扩。
    expect(hit.width).toBe(visual.width + EDGE_DELETE_HIT_PADDING * 2);
    expect(hit.height).toBe(visual.height + EDGE_DELETE_HIT_PADDING * 2);
    expect(hit.x).toBe(visual.x - EDGE_DELETE_HIT_PADDING);
    expect(hit.y).toBe(visual.y - EDGE_DELETE_HIT_PADDING);
    // 命中区左缘正好接上标签胶囊右缘，指针从标签走到按钮不会落进死区。
    const label = bevyEdgeLabelRect(source, target, "图片");
    expect(hit.x).toBe(label.x + label.width);
  });

  it("悬停保持区覆盖连线中点、标签与按钮（修复：删除按钮悬停丢失）", () => {
    const source = { x: 0, y: 0, width: 100, height: 50 };
    const target = { x: 100, y: 300, width: 100, height: 50 };
    const bridge = bevyEdgeHoverBridgeRect(source, target, "图片");
    const button = bevyEdgeDeleteHitRect(source, target, "图片");
    // 中点 (100,175)：曲线在此穿过标签，保持区必须包含它，才能从线体接进标签。
    expect(bridge.x).toBeLessThanOrEqual(100);
    expect(100).toBeLessThanOrEqual(bridge.x + bridge.width);
    expect(bridge.y).toBeLessThanOrEqual(175);
    expect(175).toBeLessThanOrEqual(bridge.y + bridge.height);
    // 按钮完全落在保持区内，标签右侧与间隙都被覆盖。
    expect(bridge.x).toBeLessThanOrEqual(button.x);
    expect(bridge.y).toBeLessThanOrEqual(button.y);
    expect(button.x + button.width).toBeLessThanOrEqual(bridge.x + bridge.width);
    expect(button.y + button.height).toBeLessThanOrEqual(bridge.y + bridge.height);
    // 无标签时保持区就是按钮命中区。
    expect(bevyEdgeHoverBridgeRect(source, target)).toEqual(bevyEdgeDeleteHitRect(source, target));
  });
});

describe("hover 端点悬停瞬时投影（change: add-node-endpoint-hover）", () => {  it("缺省不携带 hover（所有端点静止不绘制）", () => {
    const scene = buildCanvasRenderScene({ canvas: canvas(), theme: defaultAppTheme() });
    expect(scene.hover).toBeUndefined();
  });

  it("传入 hover 时原样投影且参与 equality", () => {
    const base = canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }],
        edges: [],
        updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
    const hovered = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      hover: { nodeId: "n1", port: "output" }
    });
    const noHover = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme() });
    expect(hovered.hover).toEqual({ nodeId: "n1", port: "output" });
    expect(noHover.hover).toBeUndefined();
    expect(renderSceneEquals(hovered, noHover)).toBe(false);
    // 悬停只在节点上、不落在端点命中区时 port 为 null。
    const cardHover = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      hover: { nodeId: "n1", port: null }
    });
    expect(cardHover.hover).toEqual({ nodeId: "n1", port: null });
    expect(renderSceneEquals(hovered, cardHover)).toBe(false);
    // 相同悬停两次构建相等。
    const again = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      hover: { nodeId: "n1", port: "output" }
    });
    expect(renderSceneEquals(hovered, again)).toBe(true);
    // 悬停不改变任何 canonical 字段。
    expect(hovered.revision).toBe(noHover.revision);
    expect(hovered.nodes).toEqual(noHover.nodes);
    expect(hovered.edges).toEqual(noHover.edges);
    expect(hovered.selection).toEqual(noHover.selection);
  });

  it("连线悬停投影为 { edgeId } 并参与 equality（change: add-edge-hover-delete）", () => {
    const base = canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [
          { id: "n1", type: "start", position: { x: 0, y: 0 } },
          { id: "n2", type: "image", position: { x: 400, y: 0 } }
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", data: { label: "输入" }, sourceHandle: null, targetHandle: null }],
        updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
    const edgeHover = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), hover: { edgeId: "e1" } });
    const noHover = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme() });
    const nodeHover = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), hover: { nodeId: "n1" } });
    expect(edgeHover.hover).toEqual({ edgeId: "e1" });
    expect(renderSceneEquals(edgeHover, noHover)).toBe(false);
    // 连线悬停与节点悬停是不同快照。
    expect(renderSceneEquals(edgeHover, nodeHover)).toBe(false);
    // 悬停不改变 canonical 字段。
    expect(edgeHover.edges).toEqual(noHover.edges);
    expect(edgeHover.revision).toBe(noHover.revision);
  });
});

describe("marquee 框选瞬时投影（change: fix-group-and-marquee-preview）", () => {
  it("缺省不携带 marquee", () => {
    const scene = buildCanvasRenderScene({ canvas: canvas(), theme: defaultAppTheme() });
    expect(scene.marquee).toBeUndefined();
  });

  it("传入 marquee 时原样投影且参与 equality/fingerprint", () => {
    const base = canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [{ id: "n1", type: "text", position: { x: 0, y: 0 } }],
        edges: [],
        updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
    const marquee = { x: 10, y: 20, width: 100, height: 50 };
    const withMarquee = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), marquee });
    const without = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme() });
    expect(withMarquee.marquee).toEqual(marquee);
    expect(without.marquee).toBeUndefined();
    expect(renderSceneEquals(withMarquee, without)).toBe(false);
    // 移动选框 → 不同快照（拖拽必须逐帧重绘）。
    const moved = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      marquee: { ...marquee, width: 120 }
    });
    expect(renderSceneEquals(withMarquee, moved)).toBe(false);
    // 相同选框两次构建相等。
    const again = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), marquee });
    expect(renderSceneEquals(withMarquee, again)).toBe(true);
    // 不改变 canonical 字段。
    expect(withMarquee.revision).toBe(without.revision);
    expect(withMarquee.nodes).toEqual(without.nodes);
  });

  it("负宽高的选框也被接受（拖拽方向决定）", () => {
    const scene = buildCanvasRenderScene({
      canvas: canvas(),
      theme: defaultAppTheme(),
      marquee: { x: 100, y: 100, width: -40, height: -20 }
    });
    expect(scene.marquee).toEqual({ x: 100, y: 100, width: -40, height: -20 });
  });
});

describe("dragAttach 拖动粘连瞬时投影（change: add-drag-touch-connections）", () => {
  function attachCanvas() {
    return canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [
          { id: "n1", type: "image", position: { x: 0, y: 0 } },
          { id: "n2", type: "image", position: { x: 600, y: 0 } }
        ],
        edges: [],
        updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
  }

  it("缺省不携带 dragAttach（不绘制操作条）", () => {
    const scene = buildCanvasRenderScene({ canvas: canvas(), theme: defaultAppTheme() });
    expect(scene.dragAttach).toBeUndefined();
  });

  it("传入 dragAttach 时原样投影且参与 equality", () => {
    const base = attachCanvas();
    const attach = {
      nodeId: "n1",
      mode: "successor" as const,
      contactNodeId: "n2",
      pendingEdges: [{ id: "e1", source: "n1", target: "n2" }]
    };
    const withAttach = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), dragAttach: attach });
    const without = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme() });
    expect(withAttach.dragAttach).toEqual(attach);
    expect(without.dragAttach).toBeUndefined();
    expect(renderSceneEquals(withAttach, without)).toBe(false);
    // 相同投影两次构建相等。
    const again = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), dragAttach: attach });
    expect(renderSceneEquals(withAttach, again)).toBe(true);
    // 只改模式 / 接触目标 / 待提交边都会改变投影。
    const modeChanged = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      dragAttach: { ...attach, mode: "predecessor" as const }
    });
    expect(renderSceneEquals(withAttach, modeChanged)).toBe(false);
    const contactChanged = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      dragAttach: { ...attach, contactNodeId: "n3" }
    });
    expect(renderSceneEquals(withAttach, contactChanged)).toBe(false);
    const edgesChanged = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      dragAttach: { ...attach, pendingEdges: [...attach.pendingEdges, { id: "e2", source: "n1", target: "n3" }] }
    });
    expect(renderSceneEquals(withAttach, edgesChanged)).toBe(false);
    // 不改变 canonical 字段。
    expect(withAttach.revision).toBe(without.revision);
    expect(withAttach.nodes).toEqual(without.nodes);
    expect(withAttach.edges).toEqual(without.edges);
    expect(withAttach.selection).toEqual(without.selection);
  });

  it("mode 为 null（未按 Q/E）仍携带操作条投影", () => {
    const scene = buildCanvasRenderScene({
      canvas: attachCanvas(),
      theme: defaultAppTheme(),
      dragAttach: { nodeId: "n1", mode: null, pendingEdges: [] }
    });
    expect(scene.dragAttach).toEqual({ nodeId: "n1", mode: null, pendingEdges: [] });
  });

  it("操作条贴节点下缘、触须向左右延伸且长度固定", () => {
    const node = { x: 100, y: 50, width: 200, height: 100 };
    const bar = bevyDragAttachActionBarRect(node);
    expect(bar).toEqual({ x: 100, y: 50 + 100 + DRAG_ATTACH_ACTION_BAR_GAP, width: 200, height: DRAG_ATTACH_ACTION_BAR_HEIGHT });
    expect(bevyDragAttachProbe(node, "predecessor")).toEqual({
      from: { x: 100, y: 100 },
      to: { x: 100 - DRAG_ATTACH_PROBE_LENGTH, y: 100 }
    });
    expect(bevyDragAttachProbe(node, "successor")).toEqual({
      from: { x: 300, y: 100 },
      to: { x: 300 + DRAG_ATTACH_PROBE_LENGTH, y: 100 }
    });
  });

  it("probe 命中矩形：接触时相交、离开或高度错开时不命中", () => {
    const node = { x: 100, y: 50, width: 200, height: 100 };
    const probe = bevyDragAttachProbe(node, "successor");
    // 候选矩形落在触须延长线上（y 覆盖中点 100）。
    expect(dragAttachProbeIntersects(probe, { x: 340, y: 60, width: 120, height: 80 })).toBe(true);
    // 候选在触须长度之外：不命中。
    expect(dragAttachProbeIntersects(probe, { x: 400, y: 60, width: 120, height: 80 })).toBe(false);
    // 候选纵向错开：不命中。
    expect(dragAttachProbeIntersects(probe, { x: 340, y: 200, width: 120, height: 80 })).toBe(false);
  });

  it("Bevy 的拖动粘连几何常量与 contracts 保持一致", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/canvas2d/attach.rs"), "utf8");
    for (const [name, value] of [
      ["DRAG_ATTACH_ACTION_BAR_HEIGHT", DRAG_ATTACH_ACTION_BAR_HEIGHT],
      ["DRAG_ATTACH_ACTION_BAR_GAP", DRAG_ATTACH_ACTION_BAR_GAP],
      ["DRAG_ATTACH_PROBE_LENGTH", DRAG_ATTACH_PROBE_LENGTH]
    ] as const) {
      const match = rust.match(new RegExp(`const ${name}: f32 = ([\\d.]+);`));
      expect(match, `bevy 缺少 ${name}`).toBeTruthy();
      expect(Number(match![1])).toBe(value);
    }
  });

  it("Bevy 的节点操作横条几何常量与 contracts 保持一致", () => {
    // 横条由 Bevy 绘制、Rust 命中；几何常量必须两边相同，否则「画在哪、点在哪」会分叉。
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/canvas_query/layout.rs"), "utf8");
    for (const [name, value] of [
      ["NODE_ACTION_TOOLBAR_GAP", NODE_ACTION_TOOLBAR_GAP],
      ["NODE_ACTION_TOOLBAR_ACTION_HEIGHT", NODE_ACTION_TOOLBAR_ACTION_HEIGHT],
      ["NODE_ACTION_TOOLBAR_PAD", NODE_ACTION_TOOLBAR_PAD],
      ["NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH", NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH],
      ["NODE_ACTION_TOOLBAR_ACTION_PAD", NODE_ACTION_TOOLBAR_ACTION_PAD],
      ["NODE_ACTION_TOOLBAR_CHEVRON_WIDTH", NODE_ACTION_TOOLBAR_CHEVRON_WIDTH],
      ["NODE_ACTION_TOOLBAR_SEPARATOR", NODE_ACTION_TOOLBAR_SEPARATOR],
      ["NODE_ACTION_TOOLBAR_FONT", NODE_ACTION_TOOLBAR_FONT],
      ["NODE_ACTION_TOOLBAR_SUMMARY_GAP", NODE_ACTION_TOOLBAR_SUMMARY_GAP],
      ["NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH", NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH]
    ] as const) {
      const match = rust.match(new RegExp(`const ${name}: f32 = ([\\d.]+);`));
      expect(match, `bevy 缺少 ${name}`).toBeTruthy();
      expect(Number(match![1])).toBe(value);
    }
  });
});

describe("aggregateConnect 多选聚合瞬时投影（change: add-multi-select-aggregate-connect）", () => {
  function attachCanvas() {
    return canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [
          { id: "n1", type: "image", position: { x: 0, y: 0 } },
          { id: "n2", type: "image", position: { x: 400, y: 0 } }
        ],
        edges: [],
        updatedAt: "2026-09-25T00:00:00.000Z"
      }
    });
  }

  it("缺省不携带 aggregateConnect（不绘制聚合把手）", () => {
    const scene = buildCanvasRenderScene({ canvas: canvas(), theme: defaultAppTheme() });
    expect(scene.aggregateConnect).toBeUndefined();
  });

  it("传入 aggregateConnect 时原样投影且参与 equality", () => {
    const base = attachCanvas();
    const aggregate = {
      direction: "output" as const,
      cursor: { x: 12, y: 34 },
      pendingEdges: [{ id: "e1", source: "n1", target: "n2" }]
    };
    const withAgg = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), aggregateConnect: aggregate });
    const without = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme() });
    expect(withAgg.aggregateConnect).toEqual(aggregate);
    expect(without.aggregateConnect).toBeUndefined();
    expect(renderSceneEquals(withAgg, without)).toBe(false);
    // 方向 / cursor / pending edge 任一变化都改变投影。
    const dirChanged = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      aggregateConnect: { ...aggregate, direction: "input" as const }
    });
    expect(renderSceneEquals(withAgg, dirChanged)).toBe(false);
    const cursorChanged = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      aggregateConnect: { ...aggregate, cursor: { x: 99, y: 34 } }
    });
    expect(renderSceneEquals(withAgg, cursorChanged)).toBe(false);
    const edgesChanged = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      aggregateConnect: { ...aggregate, pendingEdges: [...aggregate.pendingEdges, { id: "e2", source: "n1", target: "n3" }] }
    });
    expect(renderSceneEquals(withAgg, edgesChanged)).toBe(false);
    // 不改变 canonical 字段。
    expect(withAgg.revision).toBe(without.revision);
    expect(withAgg.nodes).toEqual(without.nodes);
    expect(withAgg.edges).toEqual(without.edges);
  });

  it("仅显示把手（direction null）时仍携带投影", () => {
    const scene = buildCanvasRenderScene({
      canvas: attachCanvas(),
      theme: defaultAppTheme(),
      aggregateConnect: { direction: null, pendingEdges: [] }
    });
    expect(scene.aggregateConnect).toEqual({ direction: null, pendingEdges: [] });
  });

  it("选区包围盒与左右把手几何", () => {
    expect(bevySelectionBounds([])).toBeNull();
    const bounds = bevySelectionBounds([
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 200, y: 100, width: 40, height: 60 }
    ]);
    expect(bounds).toEqual({ x: 0, y: 0, width: 240, height: 160 });
    expect(bevyAggregateHandle(bounds!, "input")).toEqual({ x: -AGGREGATE_HANDLE_GAP, y: 80 });
    expect(bevyAggregateHandle(bounds!, "output")).toEqual({ x: 240 + AGGREGATE_HANDLE_GAP, y: 80 });
  });

  it("Bevy 的聚合把手常量与 contracts 保持一致", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/canvas_query/aggregate.rs"), "utf8");
    for (const [name, value] of [
      ["AGGREGATE_HANDLE_RADIUS", AGGREGATE_HANDLE_RADIUS],
      ["AGGREGATE_HANDLE_GAP", AGGREGATE_HANDLE_GAP]
    ] as const) {
      const match = rust.match(new RegExp(`const ${name}: f32 = ([\\d.]+);`));
      expect(match, `bevy 缺少 ${name}`).toBeTruthy();
      expect(Number(match![1])).toBe(value);
    }
  });
});

describe("modelFocus 瞬时投影（change: add-model-focus-viewing，任务 1.1）", () => {
  it("缺省不携带 modelFocus（普通正交画布）", () => {
    const scene = buildCanvasRenderScene({ canvas: canvas(), theme: defaultAppTheme() });
    expect(scene.modelFocus).toBeUndefined();
  });

  it("传入 modelFocus 时原样投影且参与 equality", () => {
    const base = canvas();
    const focus = {
      version: "woohaa-model-focus-v1" as const,
      nodeId: "n1",
      target: [0, 1, 0] as [number, number, number],
      yaw: 0.1,
      pitch: -0.2,
      distance: 12,
      fov: 0.87,
      radius: 2
    };
    const withFocus = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), modelFocus: focus });
    const withoutFocus = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme() });
    expect(withFocus.modelFocus).toEqual(focus);
    // 相机 pose 变化同样触发重绘。
    const moved = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      modelFocus: { ...focus, yaw: 0.5 }
    });
    expect(renderSceneEquals(withFocus, moved)).toBe(false);
    expect(renderSceneEquals(withFocus, withoutFocus)).toBe(false);
    // 同一个 focus 两次构建相等。
    const again = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), modelFocus: focus });
    expect(renderSceneEquals(withFocus, again)).toBe(true);
    // 投影不改变 canonical 字段。
    expect(withFocus.revision).toBe(withoutFocus.revision);
    expect(withFocus.nodes).toEqual(withoutFocus.nodes);
    expect(withFocus.selection).toEqual(withoutFocus.selection);
  });

  it("focus 与 hover 可共存于同一投影；focus 优先级由运行时判定，schema 不含版本/字段变化", () => {
    // change: play-model-animations-on-hover，任务 3.1：复用既有 hover/modelFocus 瞬时投影，
    // 不新增 schema/version。进入聚焦的 scene 仍可能携带残留 hover，运行时以 modelFocus 优先。
    const base = canvas();
    const focus = {
      version: "woohaa-model-focus-v1" as const,
      nodeId: "n1",
      target: [0, 0, 0] as [number, number, number],
      yaw: 0,
      pitch: 0,
      distance: 10,
      fov: 0.87,
      radius: 1
    };
    const hovered = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), hover: { nodeId: "n1", port: null } });
    const focusPlusHover = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      hover: { nodeId: "n1", port: null },
      modelFocus: focus
    });
    // 同一 hover 在普通画布与聚焦会话中都能投影；运行时据此判定活跃播放模型。
    expect(focusPlusHover.hover).toEqual({ nodeId: "n1", port: null });
    expect(focusPlusHover.modelFocus).toEqual(focus);
    // 聚焦进入改变 fingerprint（hover 未变但 modelFocus 从无到有）。
    expect(renderSceneFingerprint(hovered)).not.toBe(renderSceneFingerprint(focusPlusHover));
    // 退出聚焦恢复到与进入前相同的可见状态。
    const exited = buildCanvasRenderScene({ canvas: base, theme: defaultAppTheme(), hover: { nodeId: "n1", port: null } });
    expect(renderSceneFingerprint(exited)).toBe(renderSceneFingerprint(hovered));
  });
});

describe("renderSceneFingerprint（change: optimize-model-scene-snapshot-hot-path）", () => {
  function baseScene() {
    return buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [
            { id: "n1", type: "text", position: { x: 0, y: 0 } },
            { id: "g1", type: "model3d", position: { x: 300, y: 0 } }
          ],
          edges: [{ id: "e1", source: "n1", target: "g1", data: { label: "输入" }, sourceHandle: null, targetHandle: null }],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      modelScenesV2: new Map([["g1", [
        { t: "sphere", id: "s", parent: null, position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ff0000", radius: 1 }
      ]]])
    });
  }

  it("相同输入得到相同 fingerprint，只由可见字段驱动", () => {
    expect(renderSceneFingerprint(baseScene())).toBe(renderSceneFingerprint(baseScene()));
  });

  it("film feedback identity, phase and reduced motion participate in equality and fingerprint", () => {
    const base = baseScene();
    const withRun = { ...base, nodes: base.nodes.map(node => ({ ...node, aggregateRun: {
      active: true, filmSet: { operationKey: "attempt-1", phase: "running" as const, source: "agent" as const, labelCode: "generating" as const }
    } })) };
    expect(renderSceneEquals(withRun, structuredClone(withRun))).toBe(true);
    for (const change of [{ filmSet: { ...withRun.nodes[0]!.aggregateRun.filmSet, operationKey: "attempt-2" } },
      { filmSet: { ...withRun.nodes[0]!.aggregateRun.filmSet, phase: "committing" as const } }, { reduceMotion: true }]) {
      const next = { ...withRun, nodes: withRun.nodes.map(node => ({ ...node, aggregateRun: { ...node.aggregateRun, ...change } })) };
      expect(renderSceneEquals(withRun, next)).toBe(false);
      expect(renderSceneFingerprint(withRun)).not.toBe(renderSceneFingerprint(next));
    }
  });

  it("图片取景不变时，入场完成信号仍触发场景更新；省略信号兼容既有呈现", () => {
    const imageFocus = { version: "woohaa-image-focus-v1" as const, nodeId: "n1", viewport: { x: 0, y: 0, zoom: 1 }, sourceWidth: 640, sourceHeight: 480 };
    const scene = { ...baseScene(), imageFocus };
    const entering = { ...scene, imageFocus: { ...imageFocus, presentationReady: false } };
    const completed = { ...scene, imageFocus: { ...imageFocus, presentationReady: true } };
    expect(renderSceneFingerprint(entering)).not.toBe(renderSceneFingerprint(completed));
    expect(renderSceneFingerprint(scene)).toBe(renderSceneFingerprint(completed));
  });

  it("文档相机改变但帧视口不变时仍更新场景", () => {
    const imageFocus = { version: "woohaa-image-focus-v1" as const, nodeId: "n1", viewport: { x: 0, y: 0, zoom: 1 },
      sourceWidth: 640, sourceHeight: 480, documentView: { sourceWidth: 4000, sourceHeight: 3000,
        viewport: { x: 10, y: 20, zoom: .2 } } };
    const scene = { ...baseScene(), imageFocus };
    for (const change of [{ x: 30 }, { y: 50 }, { zoom: .4 }]) {
      const next = { ...scene, imageFocus: { ...imageFocus, documentView: { ...imageFocus.documentView,
        viewport: { ...imageFocus.documentView.viewport, ...change } } } };
      expect(renderSceneEquals(scene, next)).toBe(false);
      expect(renderSceneFingerprint(scene)).not.toBe(renderSceneFingerprint(next));
    }
  });

  it("逐个可见字段变化都改变 fingerprint", () => {
    const base = baseScene();
    const baseFp = renderSceneFingerprint(base);
    const mutations: CanvasRenderScene[] = [
      { ...base, revision: base.revision + 1 },
      { ...base, nodes: base.nodes.map(node => ({ ...node, compositeAsset: { x: 0, y: 0, width: 260, height: 195, itemPlacements: { root: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 } } } })) },
      { ...base, selection: { nodes: ["n1"], edge: null } },
      { ...base, viewport: { ...base.viewport, zoom: 2 } },
      { ...base, draft: { source: "n1", side: "output", x: 1, y: 2 } },
      { ...base, surface: { width: 100, height: 100, pixelRatio: 1 } },
      { ...base, hover: { nodeId: "n1", port: "output" } },
      { ...base, hover: { edgeId: "e1" } },
      { ...base, dragAttach: { nodeId: "n1", mode: "successor", contactNodeId: "g1", pendingEdges: [{ id: "e2", source: "n1", target: "g1" }] } },
      { ...base, aggregateConnect: { direction: "output", cursor: { x: 1, y: 2 }, pendingEdges: [{ id: "e3", source: "n1", target: "g1" }] } },
      { ...base, nodes: base.nodes.map((node) => (node.id === "n1" ? { ...node, body: "changed" } : node)) },
      { ...base, nodes: base.nodes.map((node) => (node.id === "n1" ? { ...node, mediaLoading: true } : node)) },
      { ...base, edges: base.edges.map((edge) => ({ ...edge, label: "changed" })) },
      {
        ...base,
        nodes: base.nodes.map((node) =>
          node.model ? { ...node, model: { ...node.model, resourceKey: "woohaa-model-scene-ir-v2:ffffffffffffffff" } } : node
        )
      }
    ];
    for (const mutated of mutations) {
      expect(renderSceneFingerprint(mutated), JSON.stringify(mutated).slice(0, 60)).not.toBe(baseFp);
    }
  });

  it("placement 变化改变 fingerprint 但不改变模型内容 identity", () => {
    const withPlacement = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "g1", type: "model3d", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      modelScenesV2: new Map([["g1", [
        { t: "sphere", id: "s", parent: null, position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ff0000", radius: 1 }
      ]]])
    });
    const moved = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "g1", type: "model3d", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-09-25T00:00:00.000Z"
        }
      }),
      modelScenesV2: new Map([["g1", [
        { t: "sphere", id: "s", parent: null, position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ff0000", radius: 1 }
      ]]])
    });
    // 内容相同 → resourceKey/signature 相同（放置独立于资源）。
    expect(moved.nodes[0].model?.resourceKey).toBe(withPlacement.nodes[0].model?.resourceKey);
  });
});



it("dynamic film-set placements invalidate presentation without changing revision or resource", () => {
  const base = buildCanvasRenderScene({ canvas: canvas() });
  const first: CanvasRenderScene = { ...base, nodes: [{
    id: "film", type: "model", title: "片场", typeLabel: "片场", x: 0, y: 0, width: 260, height: 195, body: "", progress: 0, busy: false, texture: false, resizable: false,
    compositeAsset: { x: 0, y: 0, width: 260, height: 195, itemRoots: { a: "root" }, itemPlacements: { root: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } } }
  }] };
  const second: CanvasRenderScene = { ...first, nodes: first.nodes.map(node => ({ ...node, compositeAsset: { ...node.compositeAsset!, itemPlacements: { root: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 } } } })) };
  expect(renderSceneFingerprint(second)).not.toBe(renderSceneFingerprint(first));
  expect(second.revision).toBe(first.revision);
});

it("media placements emit content-local geometry that the shared root scales", () => {
  const [plane] = filmSetMediaPlanesForNode({
    nodeId: "film",
    readyPlaneIds: new Set(),
    contentExtent: 2,
    data: { filmSetContent: { schemaVersion: 4, items: [{ id: "photo", kind: "image", name: "photo", assetId: "asset", aspectRatio: 1.5, localTransform: { offset: { x: 3, y: 4, z: 5 }, scale: 2, yaw: 0.2 } }] } } as never
  });
  // 内容单位高度 = 48 × itemScale(2) × extent(2) / 192 = 1；宽 1.5；中心 = offset + 半高。
  expect(plane).toMatchObject({ id: "film::photo", itemId: "photo", unit: 1, x: 3, y: 4.5, z: 5, width: 1.5, height: 1, yaw: 0.2 });
});

describe("拍摄镜头预览卡片与归属线（change: 2026-10-15-add-film-set-shooting-shot-previews）", () => {
  const shotNodeId = shotPreviewNodeId("film", "clip-1");

  function filmSetCanvas(): ServerCanvas {
    const base = createFilmSetSnapshot({
      title: "片场",
      model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" },
      timeline: { duration: 0, loop: false }
    });
    const clip = {
      id: "clip-1",
      name: "运镜",
      kind: "dynamic" as const,
      timeline: { duration: 4, loop: false },
      initialCamera: base.sceneCamera,
      cameraMotion: staticShotCameraMotion(),
      bindings: []
    };
    const nodeData = canonicalFilmSetFields({ ...base, filmSetAnimations: { schemaVersion: 3, defaultClipId: "clip-1", clips: [clip] } });
    return canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [
          { id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 100, y: 60 }, width: 320, height: 240 },
          { id: shotNodeId, type: "film-set-shot-preview", position: { x: 560, y: 60 }, width: 240, height: 167 }
        ],
        edges: [],
        updatedAt: "2026-10-15T00:00:00.000Z"
      },
      nodeData: {
        film: nodeData as never,
        [shotNodeId]: { shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "clip-1" } } as never
      }
    });
  }

  it("预览卡片投影源镜头的标题/类型/画幅/时长，不复制权威数据", () => {
    const scene = buildCanvasRenderScene({ canvas: filmSetCanvas(), theme: defaultAppTheme() });
    const card = scene.nodes.find((node) => node.id === shotNodeId)!.shotPreview!;
    expect(card).toMatchObject({ filmSetNodeId: "film", clipId: "clip-1", kind: "dynamic", name: "运镜", duration: 4, state: "ready" });
    expect(card.aspect).toBeCloseTo(16 / 9, 6);
    // 标题/类型为只读投影：卡片主标题 = 镜头名，次要标记 = 类型。
    const node = scene.nodes.find((entry) => entry.id === shotNodeId)!;
    expect(node.title).toBe("运镜");
    expect(node.typeLabel).toBe("动态镜头");
    // 预览节点不合成为普通内容节点：无 outputAssetId/媒体引用等字段。
    expect(node).not.toHaveProperty("outputAssetId");
  });

  it("迁移后的 owner-managed 预览节点仍投影镜头卡片与归属线", () => {
    const groupId = "film-group";
    const clipId = "clip-1";
    const previewId = shotPreviewNodeId(groupId, clipId);
    const marker = createFilmSetGroupMarker({
      sceneBindings: [],
      cameras: [{ id: `camera:${clipId}`, name: "运镜", azimuth: 0, elevation: 0.35, distance: 4, focusOffset: { x: 0, y: 0, z: 0 }, aspect: "16:9" }],
      clips: [{ id: clipId, name: "运镜", cameraId: `camera:${clipId}`, duration: 4, loop: false, cameraMotion: staticShotCameraMotion(), bindings: [] }],
      activeClip: clipId
    });
    const source = canvas({
      document: {
        schemaVersion: "asset-canvas-v1",
        nodes: [
          { id: groupId, type: "group", position: { x: 100, y: 60 }, width: 320, height: 240 },
          { id: previewId, type: "video", position: { x: 560, y: 60 }, width: 240, height: 167 }
        ],
        edges: [],
        updatedAt: "2026-10-15T00:00:00.000Z"
      },
      nodeData: {
        [groupId]: { filmSetGroup: marker } as never,
        [previewId]: {
          managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: groupId, entityId: clipId, lifecycle: "owner-managed" },
          mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: groupId, clipId } }
        } as never
      }
    });
    const scene = buildCanvasRenderScene({ canvas: source, theme: defaultAppTheme(), shotPreviewCameraProjection: () => ({ x: 10, y: 10 }) });
    const node = scene.nodes.find((entry) => entry.id === previewId)!;
    expect(node.shotPreview).toMatchObject({ filmSetNodeId: groupId, clipId, kind: "dynamic", name: "运镜", duration: 4 });
    expect(node.title).toBe("运镜");
    expect(node.typeLabel).toBe("动态镜头");
    expect(scene.shotPreviewLinks).toHaveLength(1);
    expect(scene.shotPreviewLinks![0]).toMatchObject({ ownerNodeId: groupId, previewNodeId: previewId, clipId });
  });

  it("镜头始终外显，旧隐藏设置不影响卡片、连线或规范布局", () => {
    const source = filmSetCanvas();
    const before = structuredClone(source.document.nodes);
    source.nodeData.film.filmSetShotPreviewsHidden = ["clip-1"];
    const scene = buildCanvasRenderScene({ canvas: source, theme: defaultAppTheme(), shotPreviewCameraProjection: () => ({ x: 10, y: 10 }) });
    const shot = scene.nodes.find(node => node.id === shotNodeId)?.shotPreview;
    expect(shot).toMatchObject({ clipId: "clip-1", kind: "dynamic" });
    expect(shot?.hidden).toBeUndefined();
    expect(scene.shotPreviewLinks?.length).toBeGreaterThan(0);
    expect(source.document.nodes).toEqual(before);
  });

  it("projects each shot's custom backdrop to the shared preview/capture rig", () => {
    const source = filmSetCanvas();
    (source.nodeData.film as unknown as { filmSetAnimations: { clips: { backdrop?: string }[] } }).filmSetAnimations.clips[0]!.backdrop = "#284e62";
    const scene = buildCanvasRenderScene({ canvas: source, theme: defaultAppTheme() });
    expect(scene.nodes.find(node => node.id === shotNodeId)!.shotPreview!.backdrop).toBe("#284e62");
  });

  it("本地播放状态与状态机进入卡片且只影响内容，不写 canonical", () => {
    const base = filmSetCanvas();
    const playing = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      shotPreviews: new Map([[shotNodeId, { progress: 0.5, playing: true }]])
    });
    const card = playing.nodes.find((node) => node.id === shotNodeId)!.shotPreview!;
    expect(card.progress).toBe(0.5);
    expect(card.playing).toBe(true);
    const stale = buildCanvasRenderScene({
      canvas: base,
      theme: defaultAppTheme(),
      shotPreviews: new Map([[shotNodeId, { state: "stale" }]])
    });
    expect(stale.nodes.find((node) => node.id === shotNodeId)!.shotPreview!.state).toBe("stale");
    // 未知/非法归属或源镜头已消失：不绘制内容，但保留节点。
    const missingSource = buildCanvasRenderScene({
      canvas: canvas({
        document: {
          schemaVersion: "asset-canvas-v1",
          nodes: [{ id: "p", type: "film-set-shot-preview", position: { x: 0, y: 0 } }],
          edges: [],
          updatedAt: "2026-10-15T00:00:00.000Z"
        },
        nodeData: { p: { shotPreview: { schemaVersion: 1, filmSetNodeId: "gone", clipId: "clip-1" } } as never }
      })
    });
    expect(missingSource.nodes[0].shotPreview).toBeUndefined();
    // 播放状态不改变 revision。
    expect(playing.revision).toBe(base.revision);
  });

  it("归属线由注入的相机投影派生，起点/终点身份稳定", () => {
    const canvasState = filmSetCanvas();
    const projection = (filmSetNodeId: string, clipId: string) => (filmSetNodeId === "film" && clipId === "clip-1" ? { x: 200, y: 180 } : null);
    const scene = buildCanvasRenderScene({ canvas: canvasState, theme: defaultAppTheme(), shotPreviewCameraProjection: projection });
    expect(scene.shotPreviewLinks).toHaveLength(1);
    const link = scene.shotPreviewLinks![0]!;
    expect(link).toMatchObject({ id: "link:film:clip-1", ownerNodeId: "film", previewNodeId: shotNodeId, clipId: "clip-1", start: { x: 200, y: 180 } });
    // 缺失投影：不伪造起点，不派生线。
    const none = buildCanvasRenderScene({ canvas: canvasState, theme: defaultAppTheme() });
    expect(none.shotPreviewLinks).toBeUndefined();
    // 归属线不进入普通 edges。
    expect(scene.edges).toHaveLength(0);
  });

  it("归属线几何与卡片接口复用同一份矩形，并参与 fingerprint", () => {
    const content = shotPreviewContentRect({ x: 560, y: 60, width: 240, height: 167 });
    expect(content).toEqual({ x: 576, y: 60 + SHOT_PREVIEW_HEADER_HEIGHT, width: 208, height: 167 - SHOT_PREVIEW_HEADER_HEIGHT - 16 });
    expect(shotPreviewCardAttachment({ x: 560, y: 60, width: 240, height: 167 })).toEqual({ x: 560, y: 60 + 167 / 2 });
    const scene = buildCanvasRenderScene({
      canvas: filmSetCanvas(),
      theme: defaultAppTheme(),
      shotPreviewCameraProjection: () => ({ x: 100, y: 100 })
    });
    const moved = buildCanvasRenderScene({
      canvas: filmSetCanvas(),
      theme: defaultAppTheme(),
      shotPreviewCameraProjection: () => ({ x: 130, y: 100 })
    });
    expect(renderSceneFingerprint(scene)).not.toBe(renderSceneFingerprint(moved));
  });
});

it("占位声明只改变总览呈现与指纹，缺省/未知不改变范围和内容", () => {
  const current = canvas();
  current.document.nodes = [{ id: "empty", type: "composite-asset", position: { x: 0, y: 0 }, width: 260, height: 195 }];
  current.nodeData = {};
  const before = JSON.stringify(current);
  const absent = buildCanvasRenderScene({ canvas: current });
  const declared = buildCanvasRenderScene({ canvas: current, compositeAssetEmptyPlaceholders: new Map([["empty", "brand-plinth-v1"]]) });
  expect(declared.nodes[0].compositeAsset?.emptyPlaceholder).toBe("brand-plinth-v1");
  expect(renderSceneFingerprint(declared)).not.toBe(renderSceneFingerprint(absent));
  delete declared.nodes[0].compositeAsset!.emptyPlaceholder;
  expect(renderSceneEquals(declared, absent)).toBe(true);
  const unknown = buildCanvasRenderScene({ canvas: current, compositeAssetEmptyPlaceholders: new Map([["empty", "unknown" as never]]) });
  expect(renderSceneEquals(unknown, absent)).toBe(true);
  expect(JSON.stringify(current)).toBe(before);
});
