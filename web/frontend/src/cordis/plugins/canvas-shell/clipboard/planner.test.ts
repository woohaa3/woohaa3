/**
 * 剪贴板载荷与粘贴规划（change: align-godot-canvas-interactions，任务 4.1 / 4.3 / 4.4）。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createWoohaa3CanvasNode,
  toWoohaa3CanvasDocument,
  createFilmSetSnapshot, canonicalFilmSetFields, filmSetAnimationsOf, decodeFilmSetNodeData,
  IMAGE_PROJECT_CONTENT_TYPE,
  PHOTOCRAFT_ENGINE_VERSION,
  applyCanvasCommands,
  filmSetObjectContainerId, filmSetObjectContainerData, resolveFilmSetObject,
  FILM_SET_SHOT_PREVIEW_NODE_TYPE, shotPreviewOwnershipOf, SHOT_REFERENCE_ROLE,
  type FilmSetModelItem, type FilmSetMediaItem,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { buildCanvasCopyPayload, parseCanvasCopyPayload, serializeCanvasCopyPayload } from "./payload.js";
import { checkPasteReferences, planCanvasPaste } from "./planner.js";

const NOW = "2026-09-24T00:00:00.000Z";

function canvasFixture(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", NOW);
  const nodes = [
    { ...createWoohaa3CanvasNode("text", { x: 0, y: 0 }, "text-1"), width: 100, height: 50 },
    { ...createWoohaa3CanvasNode("image", { x: 400, y: 0 }, "image-1"), width: 100, height: 50 },
    { ...createWoohaa3CanvasNode("text", { x: 800, y: 0 }, "gen-1"), width: 100, height: 50 }
  ];
  const edges: ServerCanvas["document"]["edges"] = [
    { id: "edge-text-image", source: "text-1", target: "image-1", sourceHandle: null, targetHandle: null, data: { label: "文本" } },
    { id: "edge-image-gen", source: "image-1", target: "gen-1", sourceHandle: null, targetHandle: null, data: {} }
  ];
  return {
    ...base,
    document: toWoohaa3CanvasDocument({ nodes, edges }, NOW),
    nodeData: {
      "text-1": { prompt: "提示词", activeRunId: "run-1", outputAssetId: "asset-1" },
      "image-1": { prompt: "图片" },
      "gen-1": { jsPath: "res://x.js" }
    }
  };
}

describe("复制载荷", () => {
  it("包含选中节点、内部边与清理后的 nodeData", () => {
    const payload = buildCanvasCopyPayload(canvasFixture(), ["text-1", "image-1"]);
    expect(payload).not.toBeNull();
    expect(payload!.nodes.map((node) => node.id)).toEqual(["text-1", "image-1"]);
    expect(payload!.edges.map((edge) => edge.id)).toEqual(["edge-text-image"]);
    // gen-1 未被选中，其入边成为 incomingEdges（源 image-1 在选区，但 image-1 也在选区内 → 内部边）。
    expect(payload!.incomingEdges).toHaveLength(0);
    // 运行态/结果字段被清理，prompt 保留。
    expect(payload!.nodeData["text-1"]).toEqual({ prompt: "提示词" });
    // 本机路径节点不在选区，不出现。
    expect(payload!.nodeData["gen-1"]).toBeUndefined();
  });

  it("扩展选中父节点的后代", () => {
    const canvas = canvasFixture();
    const child = { ...createWoohaa3CanvasNode("text", { x: 0, y: 200 }, "child-1"), parentId: "text-1" };
    canvas.document.nodes.push(child);
    const payload = buildCanvasCopyPayload(canvas, ["text-1"]);
    expect(payload!.nodes.map((node) => node.id).sort()).toEqual(["child-1", "text-1"]);
  });

  it("空选择或全失效选择返回 null", () => {
    expect(buildCanvasCopyPayload(canvasFixture(), [])).toBeNull();
    expect(buildCanvasCopyPayload(canvasFixture(), ["missing"])).toBeNull();
  });

  it("序列化往返是确定性的", () => {
    const payload = buildCanvasCopyPayload(canvasFixture(), ["text-1", "image-1"])!;
    const json = serializeCanvasCopyPayload(payload);
    expect(parseCanvasCopyPayload(json)).toEqual(payload);
  });

  it("普通文本与未知 JSON 不解析为载荷", () => {
    expect(parseCanvasCopyPayload("hello world")).toBeNull();
    expect(parseCanvasCopyPayload('{"foo":1}')).toBeNull();
    expect(parseCanvasCopyPayload("")).toBeNull();
    expect(parseCanvasCopyPayload(null)).toBeNull();
  });

  it("非法内部边（悬空端点）被拒绝解析", () => {
    const bad = {
      format: "infinspire-canvas-copy-v1",
      nodes: [{ id: "a", type: "text", position: { x: 0, y: 0 } }],
      edges: [{ id: "e", source: "a", target: "missing", data: {} }],
      incomingEdges: [],
      nodeData: {}
    };
    expect(parseCanvasCopyPayload(JSON.stringify(bad))).toBeNull();
  });

  /**
   * 上传的图片/视频/音频节点把内容存在 `outputAssetId`（见 `uploadedNodeData`），它是唯一
   * 内容引用而不是任务结果指针。剪掉会让复制出的节点没有内容——用户看到的正是「复制出来
   * 的图片节点是空白」（change: fix-copy-keeps-node-media）。
   */
  it("上传媒体节点复制时保留内容引用并携带资产", () => {
    const canvas = uploadedMediaCanvas();
    const payload = buildCanvasCopyPayload(canvas, ["img-1"]);
    expect(payload).not.toBeNull();
    expect(payload!.nodeData["img-1"]).toMatchObject({
      title: "照片.png",
      outputAssetId: "asset-upload-photo",
      resourceKind: "image",
      taskStatus: "successed"
    });
    // 资产随载荷一起走，粘贴到别的画布仍能解析该引用。
    expect(payload!.assets?.map((asset) => asset.id)).toEqual(["asset-upload-photo"]);
    expect(parseCanvasCopyPayload(serializeCanvasCopyPayload(payload!))).toEqual(payload);
  });

  it("粘贴上传媒体节点后新节点仍引用同一 ready 资产", () => {
    const payload = buildCanvasCopyPayload(uploadedMediaCanvas(), ["img-1"])!;
    const target = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const plan = planCanvasPaste({
      canvas: target,
      payload,
      anchor: { kind: "point", position: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 },
      createId: (prefix, index) => `${prefix}-n${index}`
    });
    expect(plan).not.toBeNull();
    const applied = applyCanvasCommands(target, plan!.commands, { now: NOW });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const pasted = applied.canvas.document.nodes.find((node) => node.id !== "img-1")!;
    const data = applied.canvas.nodeData[pasted.id] as { outputAssetId?: string };
    expect(data.outputAssetId).toBe("asset-upload-photo");
    expect(applied.canvas.assets.some((asset) => asset.id === "asset-upload-photo" && asset.status === "ready")).toBe(true);
  });

  it("生成结果指针仍被剪除：粘贴后是无运行态的可编辑节点", () => {
    const base = createEmptyWoohaa3ServerCanvas("canvas-1", NOW);
    const generated: ServerCanvas = {
      ...base,
      document: toWoohaa3CanvasDocument(
        { nodes: [{ ...createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "gen-img"), width: 100, height: 50 }], edges: [] },
        NOW
      ),
      assets: [storedAsset("asset-generated-out", "generated-output/x.png", "image/png", "generated")],
      nodeData: {
        "gen-img": {
          prompt: "画一只猫",
          outputAssetId: "asset-generated-out",
          resourceKind: "image",
          taskStatus: "successed",
          providerTaskId: "provider-1"
        }
      }
    } as unknown as ServerCanvas;
    const payload = buildCanvasCopyPayload(generated, ["gen-img"])!;
    expect(payload.nodeData["gen-img"]).toMatchObject({ prompt: "画一只猫" });
    expect(payload.nodeData["gen-img"]).not.toHaveProperty("outputAssetId");
    // 结果资产不随载荷走（nodeData 已不引用它）。
    expect(payload.assets ?? []).toHaveLength(0);
  });
});

describe("粘贴规划", () => {
  it("copying a film set remaps clips, default and bindings while sharing geometry and media", () => {
    const canvas = canvasFixture();
    const snapshot = createFilmSetSnapshot({
      title: "电影",
      model: { modelScript: "scene.box({id:'body',size:[1,1,1]});", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor",
      // 对象动作只经片段 binding（items-only，D10）。
      motionScript: "motion.model.rotate('body', { speed: 1 });",
      timeline: { duration: 2, loop: false },
      filmSetContent: { schemaVersion: 4, items: [{ id: "video", kind: "video", name: "视频", assetId: "asset-video", aspectRatio: 16 / 9, localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } }] }
    });
    const collection = filmSetAnimationsOf(snapshot);
    collection.clips.push({ ...structuredClone(collection.clips[0]), id: "second", name: "第二段" });
    const fields = canonicalFilmSetFields({ ...snapshot, filmSetAnimations: collection });
    canvas.document.nodes.push(createWoohaa3CanvasNode("composite-asset", { x: 0, y: 0 }, "film"));
    canvas.nodeData.film = fields as never;
    const payload = buildCanvasCopyPayload(canvas, ["film"])!;
    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const added = plan.commands.find(command => command.type === "nodeData.patch");
    if (!added || added.type !== "nodeData.patch") throw new Error("missing pasted node data");
    const decoded = decodeFilmSetNodeData(added.value);
    if (!decoded.ok) throw new Error(decoded.reason);
    const data = decoded.value;
    const pastedClips = filmSetAnimationsOf(data);
    const modelItem = data.filmSetContent.items.find((item): item is FilmSetModelItem => item.kind === "model")!;
    const actorItem = snapshot.filmSetContent.items.find((item): item is FilmSetModelItem => item.id === "actor")!;
    expect(modelItem.model).toEqual(actorItem.model);
    const videoItem = data.filmSetContent.items.find((item): item is FilmSetMediaItem => item.kind === "video")!;
    expect(videoItem.assetId).toBe("asset-video");
    expect(videoItem.id).not.toBe("video");
    expect(pastedClips.clips.map(c => c.id)).not.toEqual(collection.clips.map(c => c.id));
    expect(pastedClips.defaultClipId).toBe(pastedClips.clips[0].id);
    for (const c of pastedClips.clips) expect(c.bindings[0].itemId).toBe(modelItem.id);
  });
  it("复制片场重算预览身份与归属，粘贴后闭包自洽（change: 2026-10-15 任务 5.5）", () => {
    const canvas = canvasFixture();
    const snapshot = createFilmSetSnapshot({
      title: "电影",
      model: { modelScript: "scene.box({id:'body',size:[1,1,1]});", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor",
      motionScript: "motion.model.rotate('body', { speed: 1 });",
      timeline: { duration: 2, loop: false }
    });
    const fields = canonicalFilmSetFields(snapshot);
    canvas.document.nodes.push(createWoohaa3CanvasNode("composite-asset", { x: 0, y: 0 }, "film"));
    canvas.nodeData.film = fields as never;
    // 先让共享 reducer 补齐源片场的预览闭包（与真实画布状态一致）。
    const materialized = applyCanvasCommands(canvas, [], { now: NOW });
    if (!materialized.ok) throw new Error(materialized.rejection.message);
    const withPreview = materialized.canvas;
    const sourcePreview = withPreview.document.nodes.find((node) => node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE);
    expect(sourcePreview).toBeDefined();
    const sourceOwnership = shotPreviewOwnershipOf(withPreview.nodeData[sourcePreview!.id]);
    expect(sourceOwnership).not.toBeNull();

    // 只选片场：载荷必须补齐其预览闭包（预览与片场是兄弟节点，不随后代扩展进入）。
    const payload = buildCanvasCopyPayload(withPreview, ["film"])!;
    expect(payload.nodes.some((node) => node.id === sourcePreview!.id)).toBe(true);

    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas: withPreview, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const result = applyCanvasCommands(withPreview, plan.commands, { now: NOW });
    if (!result.ok) throw new Error(`${result.rejection.code}:${result.rejection.message}`);
    const previews = result.canvas.document.nodes.filter((node) => node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE);
    // 源片场 + 副本各一个预览；副本预览必须是新身份且归属指向副本与新 clipId。
    expect(previews).toHaveLength(2);
    const pastedPreview = previews.find((node) => node.id !== sourcePreview!.id)!;
    expect(pastedPreview).toBeDefined();
    const ownership = shotPreviewOwnershipOf(result.canvas.nodeData[pastedPreview.id]);
    expect(ownership).not.toBeNull();
    expect(ownership!.filmSetNodeId).not.toBe(sourceOwnership!.filmSetNodeId);
    expect(ownership!.clipId).not.toBe(sourceOwnership!.clipId);
    // 归属指向的新片场确实是本次粘贴新增的片场节点。
    expect(result.canvas.document.nodes.some((node) => node.id === ownership!.filmSetNodeId)).toBe(true);
  });

  it.each(["dynamic", "static"] as const)("copy %s shot reference remaps both ends and preserves media role", kind => {
    const canvas = canvasFixture();
    const snapshot = createFilmSetSnapshot({
      title: "电影",
      model: { modelScript: "scene.box({id:'body',size:[1,1,1]});", modelScriptVersion: "woohaa-model-js-v2" },
      modelItemId: "actor",
      motionScript: "motion.model.rotate('body', { speed: 1 });",
      timeline: { duration: 2, loop: false }
    });
    canvas.document.nodes.push(createWoohaa3CanvasNode("composite-asset", { x: 0, y: 0 }, "film"));
    if (kind === "static") {
      const clip = snapshot.filmSetAnimations!.clips[0]!;
      clip.kind = "static"; clip.timeline = { duration: 0, loop: false }; clip.bindings = [];
      clip.cameraMotion = { ...clip.cameraMotion, motionScript: "" };
    }
    canvas.nodeData.film = canonicalFilmSetFields(snapshot) as never;
    const materialized = applyCanvasCommands(canvas, [], { now: NOW });
    if (!materialized.ok) throw new Error(materialized.rejection.message);
    const source = materialized.canvas;
    const preview = source.document.nodes.find((node) => node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE)!;
    source.document.nodes.push({ ...createWoohaa3CanvasNode("video", { x: 800, y: 0 }, "video-1") });
    source.nodeData["video-1"] = { taskKind: "video-generation", taskStatus: "idle" } as never;
    const linked = applyCanvasCommands(source, [{
      type: "edge.add",
      edge: { id: "edge-ref", source: preview.id, target: "video-1", sourceHandle: null, targetHandle: null }
    }], { now: NOW });
    if (!linked.ok) throw new Error(linked.rejection.message);

    const payload = buildCanvasCopyPayload(linked.canvas, ["film", "video-1"])!;
    // 预览闭包随片场进入载荷，镜头参考边成为内部边。
    expect(payload.nodes.some((node) => node.id === preview.id)).toBe(true);
    expect(payload.edges.some((edge) => edge.id === "edge-ref")).toBe(true);

    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas: linked.canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const pasted = applyCanvasCommands(linked.canvas, plan.commands, { now: NOW });
    if (!pasted.ok) throw new Error(`${pasted.rejection.code}:${pasted.rejection.message}`);
    const refEdges = pasted.canvas.document.edges.filter((edge) => edge.data?.kind === (kind === "static" ? "shot-image-reference" : "shot-reference") && edge.id !== "edge-ref");
    expect(refEdges).toHaveLength(1);
    // 边两端都指向新实体，不再指向源预览/源视频节点。
    expect(refEdges[0].source).not.toBe(preview.id);
    expect(refEdges[0].target).not.toBe("video-1");
    const mapping = (pasted.canvas.nodeData[refEdges[0].target] as { inputMapping?: Array<{ role?: string }> }).inputMapping ?? [];
    expect(mapping.some((entry) => entry.role === (kind === "static" ? "shot_image_reference" : SHOT_REFERENCE_ROLE))).toBe(true);
  });

  it("单独复制预览节点无操作（受保护，不产生悬空载荷）", () => {
    // 选择集只有受保护预览时不构造任何载荷（design D2：不能单独复制）。
    const canvas = canvasFixture();
    expect(buildCanvasCopyPayload(canvas, [])).toBeNull();
  });

  it("重复粘贴生成互不冲突的新 ID", () => {
    const canvas = canvasFixture();
    const payload = buildCanvasCopyPayload(canvas, ["text-1", "image-1"])!;
    const a = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const b = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    expect(a.newNodeIds).not.toEqual(b.newNodeIds);
    expect(a.newEdgeIds).not.toEqual(b.newEdgeIds);
  });

  it("包围盒中心对齐到锚点，多节点相对位置不变", () => {
    const canvas = canvasFixture();
    const payload = buildCanvasCopyPayload(canvas, ["text-1", "image-1"])!;
    const anchor = { x: 1000, y: 500 };
    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: anchor } })!;
    const adds = plan.commands.filter((command) => command.type === "node.add") as Array<{ type: "node.add"; node: { id: string; position: { x: number; y: number } } }>;
    const textAdd = adds.find((entry) => entry.node.id === plan.newNodeIds[0])!;
    const imageAdd = adds.find((entry) => entry.node.id === plan.newNodeIds[1])!;
    // 原包围盒：x [0,500]，y [0,50] ⇒ 中心 (250,25)。平移后中心 = anchor。
    const centers = adds.map((entry) => entry.node.position);
    const minX = Math.min(...centers.map((entry) => entry.x));
    const maxX = Math.max(...centers.map((entry) => entry.x)) + 100;
    const minY = Math.min(...centers.map((entry) => entry.y));
    const maxY = Math.max(...centers.map((entry) => entry.y)) + 50;
    expect((minX + maxX) / 2).toBeCloseTo(anchor.x, 6);
    expect((minY + maxY) / 2).toBeCloseTo(anchor.y, 6);
    // 相对位置不变。
    expect(imageAdd.node.position.x - textAdd.node.position.x).toBeCloseTo(400, 6);
  });

  it("失效入边被过滤，有效入边重写 target 为新 ID", () => {
    const canvas = canvasFixture();
    // 复制 image-1 与它到 gen-1 的入边？入边方向：text->image 是入边（源 text 在外部）。
    const payload = buildCanvasCopyPayload(canvas, ["image-1"])!;
    // text-1 仍存在于目标画布 ⇒ 入边保留。
    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const edgeAdds = plan.commands.filter((command) => command.type === "edge.add") as Array<{ type: "edge.add"; edge: { source: string; target: string } }>;
    expect(edgeAdds).toHaveLength(1);
    expect(edgeAdds[0].edge.source).toBe("text-1");
    expect(edgeAdds[0].edge.target).toBe(plan.newNodeIds[0]);

    // 源节点不在目标画布时，入边被过滤。
    const emptyCanvas = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const filtered = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas: emptyCanvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    expect(filtered.commands.filter((command) => command.type === "edge.add")).toHaveLength(0);
  });

  it("命令按依赖排序：node.add 先于 nodeData.patch 与 edge.add", () => {
    const canvas = canvasFixture();
    const payload = buildCanvasCopyPayload(canvas, ["text-1", "image-1"])!;
    const plan = planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload, anchor: { kind: "point", position: { x: 0, y: 0 } } })!;
    const types = plan.commands.map((command) => command.type);
    const lastNodeAdd = types.lastIndexOf("node.add");
    const firstPatch = types.indexOf("nodeData.patch");
    const firstEdgeAdd = types.indexOf("edge.add");
    expect(firstPatch).toBeGreaterThan(lastNodeAdd);
    expect(firstEdgeAdd).toBeGreaterThan(lastNodeAdd);
  });

  it("空载荷返回 null（无操作，不提交空批次）", () => {
    const canvas = canvasFixture();
    const empty = { format: "infinspire-canvas-copy-v1" as const, nodes: [], edges: [], incomingEdges: [], nodeData: {} };
    expect(planCanvasPaste({ viewport: { x: 0, y: 0, zoom: 1 }, canvas, payload: empty, anchor: null })).toBeNull();
  });

  it("粘贴 group 子树只平移顶层，成员保持相对坐标（change: add-canvas-node-grouping）", () => {
    const base = createEmptyWoohaa3ServerCanvas("canvas-group", NOW);
    const canvas: ServerCanvas = {
      ...base,
      document: {
        ...base.document,
        nodes: [
          { id: "g", type: "group", position: { x: 100, y: 100 }, width: 400, height: 300 },
          { id: "child", type: "image", parentId: "g", position: { x: 20, y: 30 }, width: 200, height: 100 }
        ],
        edges: []
      }
    };
    const payload = buildCanvasCopyPayload(canvas, ["g"])!;
    const plan = planCanvasPaste({
      viewport: { x: 0, y: 0, zoom: 1 },
      canvas,
      payload,
      anchor: { kind: "point", position: { x: 500, y: 500 } },
      createId: (prefix, index) => `${prefix}-${index}`
    })!;
    const groupAdd = plan.commands.find(
      (command) => command.type === "node.add" && (command as { node: { type: string } }).node.type === "group"
    ) as { node: { position: { x: number; y: number } } };
    const childAdd = plan.commands.find(
      (command) => command.type === "node.add" && (command as { node: { type: string } }).node.type === "image"
    ) as { node: { position: { x: number; y: number }; parentId?: string } };
    // 顶层 group 被平移到锚点；成员仍是相对坐标（未被二次偏移）。
    expect(groupAdd.node.position).not.toEqual({ x: 100, y: 100 });
    expect(childAdd.node.position).toEqual({ x: 20, y: 30 });
    expect(childAdd.node.parentId).toBeDefined();
  });
});


/**
 * 图片工程复制回归
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 2.4）。
 *
 * 覆盖：复制工程图片节点时一并携带工程对象引用与基线/来源/输出资产；跨画布缺少必要引用
 * 或工程对象不可解析时拒绝粘贴，不留悬空引用；授权跨画布复制全部引用可解析。
 */
const PROJECT_KEY = "sha256-" + "d".repeat(64);
const BASE_KEY = "sha256-" + "a".repeat(64);
const SOURCE_KEY = "sha256-" + "b".repeat(64);
const OUTPUT_KEY = "generation-outputs/" + "c".repeat(64) + ".png";

function storedAsset(
  id: string,
  storageKey: string,
  contentType = "image/png",
  source: StoredAsset["source"] = "uploaded"
): StoredAsset {
  return {
    id,
    title: id,
    mediaKind: "image",
    source,
    status: "ready",
    createdAt: NOW,
    metadata: { storageKey, checksum: storageKey.slice(7, 71), contentType, size: 1024 }
  } as unknown as StoredAsset;
}

/** 上传图片节点：内容只在 `outputAssetId`（见 `uploadedNodeData`）。 */
function uploadedMediaCanvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", NOW);
  return {
    ...base,
    document: toWoohaa3CanvasDocument(
      { nodes: [{ ...createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "img-1"), width: 260, height: 195 }], edges: [] },
      NOW
    ),
    assets: [storedAsset("asset-upload-photo", "uploads/photo.png")],
    nodeData: {
      "img-1": {
        title: "照片.png",
        outputAssetId: "asset-upload-photo",
        resourceKind: "image",
        taskStatus: "successed"
      }
    }
  } as unknown as ServerCanvas;
}

function projectImageCanvas(canvasId = "canvas-1"): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas(canvasId, NOW);
  return {
    ...base,
    revision: 1,
    document: toWoohaa3CanvasDocument(
      {
        nodes: [{ ...createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "image-1"), width: 100, height: 50 }],
        edges: []
      },
      NOW
    ),
    assets: [storedAsset("asset-base", BASE_KEY), storedAsset("asset-src", SOURCE_KEY), storedAsset("asset-out", OUTPUT_KEY)],
    nodeData: {
      "image-1": {
        outputAssetId: "asset-out",
        imageEdit: {
          version: "woohaa-image-project-v1",
          engine: "photocraft",
          engineVersion: PHOTOCRAFT_ENGINE_VERSION,
          formatVersion: 1,
          baseAssetId: "asset-base",
          sourceWidth: 2048,
          sourceHeight: 1536,
          canvasWidth: 800,
          canvasHeight: 600,
          documentContentHash: "0123456789abcdef",
          project: { storageKey: PROJECT_KEY, checksum: "d".repeat(64), contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 4096 },
          sourceAssetIds: ["asset-base", "asset-src"]
        }
      }
    }
  } as unknown as ServerCanvas;
}

describe("图片工程复制与跨画布引用（任务 2.4）", () => {
  it("复制载荷携带工程对象引用与基线/来源/输出资产", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"]);
    expect(payload).not.toBeNull();
    expect(payload!.assets?.map((asset) => asset.id).sort()).toEqual(["asset-base", "asset-out", "asset-src"]);
    expect(payload!.projectObjects).toEqual([
      { storageKey: PROJECT_KEY, checksum: "d".repeat(64), contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 4096 }
    ]);
    expect(parseCanvasCopyPayload(serializeCanvasCopyPayload(payload!))).toEqual(payload);
  });

  it("授权跨画布复制：资产随载荷登记，所有引用在目标画布可解析", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"])!;
    const target = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const plan = planCanvasPaste({
      canvas: target,
      payload,
      anchor: { kind: "point", position: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 },
      createId: (prefix, index) => `${prefix}-n${index}`
    });
    expect(plan).not.toBeNull();
    const upserted = plan!.commands.filter((command) => command.type === "asset.upsert").length;
    expect(upserted).toBe(3);
    const patch = plan!.commands.find((command) => command.type === "nodeData.patch");
    expect((patch as { value: { imageEdit: { project: { storageKey: string } } } }).value.imageEdit.project.storageKey).toBe(PROJECT_KEY);
  });

  it("缺少必要来源资产时拒绝粘贴，不写悬空引用", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"])!;
    // 模拟载荷只带出工程对象、没带来源资产（例如来源对象不可共享）。
    const partial = { ...payload, assets: (payload.assets ?? []).filter((asset) => asset.id === "asset-out") };
    const target = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const refusal = checkPasteReferences({ canvas: target, payload: partial });
    expect(refusal?.code).toBe("project-reference-missing");
    expect(
      planCanvasPaste({
        canvas: target,
        payload: partial,
        anchor: { kind: "point", position: { x: 0, y: 0 } },
        viewport: { x: 0, y: 0, zoom: 1 }
      })
    ).toBeNull();
  });

  it("工程对象在目标画布不可解析时拒绝粘贴", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"])!;
    const target = createEmptyWoohaa3ServerCanvas("canvas-2", NOW);
    const refusal = checkPasteReferences({ canvas: target, payload, unverifiedProjectObjects: [PROJECT_KEY] });
    expect(refusal?.code).toBe("project-object-unverified");
    expect(
      planCanvasPaste({
        canvas: target,
        payload,
        anchor: { kind: "point", position: { x: 0, y: 0 } },
        viewport: { x: 0, y: 0, zoom: 1 },
        unverifiedProjectObjects: [PROJECT_KEY]
      })
    ).toBeNull();
  });

  it("目标画布已有同一资产时不再重复登记（幂等复制）", () => {
    const payload = buildCanvasCopyPayload(projectImageCanvas(), ["image-1"])!;
    const target = {
      ...createEmptyWoohaa3ServerCanvas("canvas-2", NOW),
      assets: [storedAsset("asset-base", BASE_KEY), storedAsset("asset-src", SOURCE_KEY), storedAsset("asset-out", OUTPUT_KEY)]
    } as ServerCanvas;
    const plan = planCanvasPaste({
      canvas: target,
      payload,
      anchor: { kind: "point", position: { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 }
    });
    expect(plan).not.toBeNull();
    expect(plan!.commands.filter((command) => command.type === "asset.upsert")).toHaveLength(0);
  });

  it("旧载荷（无 projectObjects 字段）仍可解析且不触发检查", () => {
    const payload = buildCanvasCopyPayload(canvasFixture(), ["text-1"])!;
    expect(payload.projectObjects).toBeUndefined();
    const json = JSON.parse(serializeCanvasCopyPayload(payload)) as Record<string, unknown>;
    delete json.projectObjects;
    expect(parseCanvasCopyPayload(JSON.stringify(json))).not.toBeNull();
    expect(checkPasteReferences({ canvas: createEmptyWoohaa3ServerCanvas("canvas-2", NOW), payload })).toBeNull();
  });
});


describe("片场对象容器复制", () => {
  it("随片场复制并重映射对象身份；单独复制容器不生成悬空节点", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("object-copy", NOW);
    canvas.document.nodes.push(createWoohaa3CanvasNode("composite-asset", { x: 0, y: 0 }, "film"));
    canvas.nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "片场", modelItemId: "actor",
      model: { modelScript: "scene.box({id:'body',size:[1,1,1]});", modelScriptVersion: "woohaa-model-js-v2" },
      timeline: { duration: 0, loop: false } })) as never;
    const film = canvas.nodeData.film;
    const content = film.filmSetContent as any;
    content.items.push({ ...structuredClone(content.items[0]), id: "hidden-actor", name: "隐藏对象" });
    film.filmSetObjectContainersHidden = ["hidden-actor"];
    const id = filmSetObjectContainerId("film", "actor");
    canvas.document.nodes.push(createWoohaa3CanvasNode("composite-asset", { x: 400, y: 0 }, id));
    canvas.nodeData[id] = filmSetObjectContainerData("film", "actor");
    expect(buildCanvasCopyPayload(canvas, [id])).toBeNull();
    const payload = buildCanvasCopyPayload(canvas, ["film"])!;
    expect(payload.nodes.map(node => node.id)).toContain(id);
    const target = createEmptyWoohaa3ServerCanvas("destination", NOW);
    const plan = planCanvasPaste({ canvas: target, payload, anchor: null, viewport: { x: 0, y: 0, zoom: 1 } })!;
    const result = applyCanvasCommands(target, plan.commands, { now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const newId = plan.newNodeIds.find(candidate => candidate.startsWith("film-object:"))!;
    const object = resolveFilmSetObject(result.canvas, newId)!;
    expect(object).not.toBeNull();
    expect(object.owner.filmSetNodeId).not.toBe("film");
    expect(object.item.id).not.toBe("actor");
    expect(newId).toBe(filmSetObjectContainerId(object.owner.filmSetNodeId, object.item.id));
    const ownerData = result.canvas.nodeData[object.owner.filmSetNodeId];
    const hiddenId = (ownerData.filmSetObjectContainersHidden as string[])[0];
    expect(hiddenId).not.toBe("hidden-actor");
    expect((ownerData.filmSetContent as any).items.some((item: any) => item.id === hiddenId)).toBe(true);
    expect(result.canvas.document.nodes.some(node => node.id === filmSetObjectContainerId(object.owner.filmSetNodeId, hiddenId))).toBe(false);
  });
});
