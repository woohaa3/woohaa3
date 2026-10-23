/**
 * 动态镜头参考协议测试
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.1）。
 *
 * 覆盖：动态预览 → 视频生成节点的专用镜头参考边/映射角色、与派生归属线的区分、静态及未支持
 * 组合明确拒绝、以及规范化不剥掉合法镜头参考 / 清理非法预览边。
 */
import { describe, expect, it } from "vitest";
import { shotImageReferenceIdentity, freezeShotImageReferences, shotImageReferenceAssetId } from "./film-set-shot-image-reference.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { normalizeCanvas } from "./domain/normalization.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { planCanvasEdit } from "./edit-plan.js";
import { createFilmSetSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields, filmSetAnimationsOf } from "./film-set-clip-view.js";
import { filmSetClipPrecondition, type FilmSetClipPatchOp } from "./film-set-clip-ops.js";
import { decodeFilmSetNodeData } from "./canvas-node-model.js";
import { isValidWoohaa3CanvasConnection, explainWoohaa3CanvasConnectionBlock } from "./domain/core/connection-rules.js";
import { SHOT_REFERENCE_ROLE, SHOT_REFERENCE_EDGE_KIND, SHOT_REFERENCE_SCHEMA_VERSION, isShotReferenceRole, isSupportedShotReferenceEdgeData } from "./domain/core/shot-reference.js";
import {
  DEFAULT_SHOT_REFERENCE_RECORD_PROFILE,
  shotReferenceCacheKey,
  shotReferenceContentIdentity,
  shotReferenceProfileKey
} from "./film-set-shot-reference.js";
import {
  shotPreviewNodeId
} from "./film-set-shot-preview.js";

const NOW = "2026-10-16T00:00:00.000Z";

/** 片场 + 一个动态镜头（clip-1）+ 一个普通视频生成节点。 */
function withDynamicFilmSet(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({
    id: "film",
    type: COMPOSITE_ASSET_NODE_TYPE,
    position: { x: 100, y: 50 },
    width: 320,
    height: 240
  });
  canvas.document.nodes.push({
    id: "video-1",
    type: "video",
    position: { x: 600, y: 50 },
    width: 240,
    height: 180
  });
  const animation = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: `motion.model.rotate("body", { speed: 1 });`,
    timeline: { duration: 5, loop: false }
  });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  canvas.nodeData["video-1"] = { taskKind: "video-generation", taskStatus: "idle" } as never;
  return canvas;
}

function apply(canvas: ServerCanvas, commands: unknown[]) {
  return applyCanvasCommands(canvas, commands as never, { now: NOW });
}

function expectOk(result: ReturnType<typeof applyCanvasCommands>): ServerCanvas {
  if (!result.ok) throw new Error(`期望成功，实际 ${result.rejection.code}: ${result.rejection.message}`);
  return result.canvas;
}

function materialize(canvas: ServerCanvas): ServerCanvas {
  return expectOk(apply(canvas, [{ type: "canvas.setTitle", title: canvas.title ?? "" }]));
}

function clipPatch(canvas: ServerCanvas, op: FilmSetClipPatchOp, clipId = "clip-1") {
  const decoded = decodeFilmSetNodeData(canvas.nodeData.film);
  if (!decoded.ok) throw new Error(decoded.reason);
  return {
    type: "filmSet.clipPatch",
    nodeId: "film",
    clipId,
    expectedHash: filmSetClipPrecondition(filmSetAnimationsOf(decoded.value), clipId, op),
    op
  };
}

/** 追加一个静态镜头（clip-s）并返回新画布。 */
function withExtraStaticClip(canvas: ServerCanvas): ServerCanvas {
  const decoded = decodeFilmSetNodeData(canvas.nodeData.film);
  if (!decoded.ok) throw new Error(decoded.reason);
  return expectOk(apply(canvas, [clipPatch(canvas, {
    kind: "create",
    clip: {
      id: "clip-s",
      name: "静态镜头",
      kind: "static",
      timeline: { duration: 0, loop: false },
      initialCamera: (canvas.nodeData.film as { sceneCamera: unknown }).sceneCamera as never,
      cameraMotion: {
        motionScript: "",
        motionScriptLanguage: "javascript",
        motionScriptVersion: "woohaa-motion-js-v1",
        revision: 1,
        sourceHash: "s",
        basedOnModelVersion: { revision: 1, contentHash: "camera" }
      },
      bindings: []
    } as never
  }, "clip-s")]));
}

const PREVIEW_ID = shotPreviewNodeId("film", "clip-1");
const STATIC_PREVIEW_ID = shotPreviewNodeId("film", "clip-s");

describe("static image reference contracts", () => {
  const connect = (canvas: ServerCanvas, source = STATIC_PREVIEW_ID, target = "video-1") => expectOk(apply(canvas, [{ type: "edge.add", edge: { id: "image-edge", source, target } }]));
  it("protected undo/redo restores the source kind and consumer edge/mapping role together", () => {
    const base = connect(withExtraStaticClip(materialize(withDynamicFilmSet())));
    const plan = planCanvasEdit(base, [clipPatch(base, { kind: "set-kind", toKind: "dynamic", duration: 3 }, "clip-s")] as never);
    if (!plan.ok) throw new Error(plan.reason);
    const replay = (canvas: ServerCanvas, direction: typeof plan.forward) => expectOk(apply(canvas, [{ type: "edit.apply", ...direction }]));
    const forward = replay(base, plan.forward);
    expect(forward.document.edges[0]?.data?.kind).toBe("shot-reference");
    expect(forward.nodeData["video-1"]!.inputMapping![0]!.role).toBe("shot_reference");
    const undo = replay(forward, plan.inverse);
    expect(undo.document.edges[0]?.data?.kind).toBe("shot-image-reference");
    expect(undo.nodeData["video-1"]!.inputMapping![0]!.role).toBe("shot_image_reference");
    const redo = replay(undo, plan.forward);
    expect(redo.document.edges[0]?.data?.kind).toBe("shot-reference");
  });
  it("static edge, mapping, normalization and atomic creation share the image role", () => {
    const canvas = connect(withExtraStaticClip(materialize(withDynamicFilmSet())));
    expect(canvas.document.edges[0]?.data?.kind).toBe("shot-image-reference");
    expect(canvas.nodeData["video-1"]?.inputMapping?.[0]?.role).toBe("shot_image_reference");
    expect(normalizeCanvas(canvas).document.edges).toEqual(canvas.document.edges);
    expect(normalizeCanvas(canvas).nodeData["video-1"]?.inputMapping).toEqual(canvas.nodeData["video-1"]?.inputMapping);
    const next = expectOk(apply(canvas, [{ type: "node.add", node: { id: "image-1", type: "image", position: { x: 500, y: 500 } }, nodeData: { taskKind: "image-generation" }, connect: { fromNodeId: STATIC_PREVIEW_ID, edgeId: "image-created" } }]));
    expect(next.nodeData["image-1"]?.inputMapping?.[0]?.role).toBe("shot_image_reference");
    expect(next.document.edges.find(edge => edge.id === "image-created")?.data?.kind).toBe("shot-image-reference");
    const removed = expectOk(apply(next, [{ type: "node.remove", nodeIds: ["film"] }]));
    expect(removed.document.edges).toEqual([]);
    expect(removed.nodeData["image-1"]?.inputMapping ?? []).toEqual([]);
  });
  it("conversion commits kind/edge/role together, preserves slot/layout and rejects incompatible consumers atomically", () => {
    const base = connect(withExtraStaticClip(materialize(withDynamicFilmSet())));
    const before = base.nodeData["video-1"]!.inputMapping![0]!;
    const dynamic = expectOk(apply(base, [clipPatch(base, { kind: "set-kind", toKind: "dynamic", duration: 3 }, "clip-s")]));
    expect(dynamic.document.edges[0]?.data?.kind).toBe("shot-reference");
    expect(dynamic.nodeData["video-1"]!.inputMapping![0]).toMatchObject({ slotId: before.slotId, role: "shot_reference" });
    expect(dynamic.document.nodes.find(node => node.id === STATIC_PREVIEW_ID)?.position).toEqual(base.document.nodes.find(node => node.id === STATIC_PREVIEW_ID)?.position);
    const still = expectOk(apply(dynamic, [clipPatch(dynamic, { kind: "set-kind", toKind: "static", confirmClearContent: true }, "clip-s")]));
    expect(still.nodeData["video-1"]!.inputMapping![0]).toMatchObject({ slotId: before.slotId, role: "shot_image_reference" });
    const imageConsumer = expectOk(apply(still, [{ type: "node.add", node: { id: "image-1", type: "image", position: { x: 0, y: 0 } }, connect: { fromNodeId: STATIC_PREVIEW_ID, edgeId: "blocked" } }]));
    const snapshot = structuredClone(imageConsumer);
    const result = apply(imageConsumer, [clipPatch(imageConsumer, { kind: "set-kind", toKind: "dynamic", duration: 3 }, "clip-s")]);
    expect(result.ok).toBe(false); expect(imageConsumer).toEqual(snapshot);
    if (!result.ok) expect(result.rejection.message).toContain("image-1");
  });
  it("stale mapping patches cannot overwrite a reconnect or unrelated target fields", () => {
    const canvas = connect(withExtraStaticClip(materialize(withDynamicFilmSet())));
    const original = structuredClone(canvas.nodeData["video-1"]!.inputMapping!);
    const disconnected = expectOk(apply(canvas, [{ type: "edge.remove", edgeId: "image-edge" }]));
    const result = apply(disconnected, [{ type: "nodeData.patch", nodeId: "video-1", value: { inputMapping: original }, expectedInputMapping: original }]);
    expect(result.ok).toBe(false);
    expect(disconnected.nodeData["video-1"]!.inputMapping ?? []).toEqual([]);
  });
  it("image identity excludes name/provenance/scene observation and includes saved camera, background, geometry and profile", () => {
    const canvas = connect(withExtraStaticClip(materialize(withDynamicFilmSet())));
    const decoded = decodeFilmSetNodeData(canvas.nodeData.film); if (!decoded.ok) throw new Error(decoded.reason);
    const animation = decoded.value;
    const identity = (background = "#ffffff") => shotImageReferenceIdentity({ animation, clipId: "clip-s", background, assets: [] })!;
    const before = identity();
    animation.title = "Renamed"; animation.sceneCamera.azimuth += 1;
    animation.filmSetContent.items[0]!.name = "Renamed object";
    expect(identity()).toEqual(before);
    expect(identity("#000000").contentIdentity).not.toBe(before.contentIdentity);
    animation.filmSetAnimations!.clips.find(clip => clip.id === "clip-s")!.initialCamera.aspect = "9:16";
    expect(identity()).toMatchObject({ width: 720, height: 1280 });
    expect(identity().profileKey).not.toBe(before.profileKey);
    const frozen = freezeShotImageReferences(canvas, "video-1", "#ffffff");
    expect(Array.isArray(frozen)).toBe(true);
    if (Array.isArray(frozen)) expect(shotImageReferenceAssetId(frozen[0]!)).toContain("shot-reference-image:film:clip-s:");
  });
});

describe("镜头参考协议（任务 8.1）", () => {
  it("动态预览到视频节点的连接合法，边标记为 shot-reference，映射角色为 shot_reference", () => {
    const canvas = materialize(withDynamicFilmSet());
    const reader = { get: (id: string) => canvas.nodeData[id] as Record<string, unknown> | undefined };
    const connection = { source: PREVIEW_ID, target: "video-1", sourceHandle: null, targetHandle: null };
    expect(isValidWoohaa3CanvasConnection(connection, canvas.document.nodes, canvas.document.edges, reader)).toBe(true);

    const next = expectOk(apply(canvas, [{
      type: "edge.add",
      edge: { id: "edge-shot-ref", source: PREVIEW_ID, target: "video-1", sourceHandle: null, targetHandle: null }
    }]));
    const edge = next.document.edges.find((entry) => entry.id === "edge-shot-ref")!;
    expect(edge.data?.kind).toBe(SHOT_REFERENCE_EDGE_KIND);
    expect(edge.data?.schemaVersion).toBe(SHOT_REFERENCE_SCHEMA_VERSION);
    expect(isSupportedShotReferenceEdgeData(edge.data as Record<string, unknown>)).toBe(true);
    const mapping = (next.nodeData["video-1"] as { inputMapping?: { sourceNodeId: string; role: string }[] }).inputMapping ?? [];
    const shotMapping = mapping.find((entry) => entry.sourceNodeId === PREVIEW_ID);
    expect(shotMapping?.role).toBe(SHOT_REFERENCE_ROLE);
    expect(isShotReferenceRole(shotMapping?.role)).toBe(true);
  });

  it("镜头参考不进片场归属线：归属线只在 Render Scene 派生，document.edges 只含显式参考边", () => {
    const canvas = materialize(withDynamicFilmSet());
    // 未显式连边时，预览与片场之间没有 document 边（归属线是派生呈现）。
    expect(canvas.document.edges.filter((edge) => edge.source === "film" || edge.target === "film")).toHaveLength(0);
    expect(canvas.document.edges.filter((edge) => edge.source === PREVIEW_ID || edge.target === PREVIEW_ID)).toHaveLength(0);
  });

  it("静态镜头接受图片参考，预览作目标和动态非视频目标明确拒绝", () => {
    const canvas = materialize(withDynamicFilmSet());
    const staticCanvas = withExtraStaticClip(canvas);
    const reader = { get: (id: string) => staticCanvas.nodeData[id] as Record<string, unknown> | undefined };
    const fromStatic = { source: STATIC_PREVIEW_ID, target: "video-1", sourceHandle: null, targetHandle: null };
    expect(isValidWoohaa3CanvasConnection(fromStatic, staticCanvas.document.nodes, staticCanvas.document.edges, reader)).toBe(true);

    const dynamicReader = { get: (id: string) => canvas.nodeData[id] as Record<string, unknown> | undefined };
    expect(isValidWoohaa3CanvasConnection({ source: "video-1", target: PREVIEW_ID, sourceHandle: null, targetHandle: null }, canvas.document.nodes, canvas.document.edges, dynamicReader)).toBe(false);
    expect(explainWoohaa3CanvasConnectionBlock({ source: "video-1", target: PREVIEW_ID, sourceHandle: null, targetHandle: null }, canvas.document.nodes, canvas.document.edges, dynamicReader))
      .toBe("拍摄镜头预览不接受任何输入连接");

    // 预览 → 图片节点：非视频目标拒绝。
    const imageCanvas = { ...canvas, document: { ...canvas.document, nodes: [...canvas.document.nodes, { id: "image-1", type: "image", position: { x: 900, y: 50 } }] } } as ServerCanvas;
    imageCanvas.nodeData = { ...canvas.nodeData, "image-1": { taskKind: "image-generation" } as never };
    const imageReader = { get: (id: string) => imageCanvas.nodeData[id] as Record<string, unknown> | undefined };
    expect(isValidWoohaa3CanvasConnection({ source: PREVIEW_ID, target: "image-1", sourceHandle: null, targetHandle: null }, imageCanvas.document.nodes, imageCanvas.document.edges, imageReader)).toBe(false);
    expect(explainWoohaa3CanvasConnectionBlock({ source: PREVIEW_ID, target: "image-1", sourceHandle: null, targetHandle: null }, imageCanvas.document.nodes, imageCanvas.document.edges, imageReader))
      .toBe("动态镜头视频参考只能连到视频生成节点");
  });

  it("规范化保留合法镜头参考边与映射，剥掉非法预览边", () => {
    const canvas = materialize(withDynamicFilmSet());
    const withRef = expectOk(apply(canvas, [{
      type: "edge.add",
      edge: { id: "edge-shot-ref", source: PREVIEW_ID, target: "video-1", sourceHandle: null, targetHandle: null }
    }]));
    // 归一化后合法参考边与 shot_reference 映射仍在。
    const normalized = normalizeCanvas(withRef);
    expect(normalized.document.edges.some((edge) => edge.id === "edge-shot-ref")).toBe(true);
    const mapping = (normalized.nodeData["video-1"] as { inputMapping?: { sourceNodeId: string; role: string }[] }).inputMapping ?? [];
    expect(mapping.some((entry) => entry.sourceNodeId === PREVIEW_ID && isShotReferenceRole(entry.role))).toBe(true);

    // 伪造的预览 → 图片边（非合法参考）在归一化时被剥掉。
    const illegal = normalizeCanvas({
      ...withRef,
      document: {
        ...withRef.document,
        edges: [...withRef.document.edges, { id: "edge-bad", source: PREVIEW_ID, target: "film", sourceHandle: null, targetHandle: null, data: {} }]
      }
    });
    expect(illegal.document.edges.some((edge) => edge.id === "edge-bad")).toBe(false);
  });

  it("能力门禁：拒绝更高结构版本的镜头参考边并拒绝写命令，不静默降级", () => {
    const canvas = materialize(withDynamicFilmSet());
    // 直接写命令：更高版本 → 明确拒绝。
    const rejected = apply(canvas, [{
      type: "edge.add",
      edge: { id: "edge-v99", source: PREVIEW_ID, target: "video-1", sourceHandle: null, targetHandle: null, data: { kind: SHOT_REFERENCE_EDGE_KIND, schemaVersion: 99 } }
    }]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.rejection.code).toBe("unsupported-shot-reference");

    // 反序列化：更高版本参考边在归一化时被剥掉，不猜语义。
    const normalized = normalizeCanvas({
      ...canvas,
      document: {
        ...canvas.document,
        edges: [{ id: "edge-v99", source: PREVIEW_ID, target: "video-1", sourceHandle: null, targetHandle: null, data: { kind: SHOT_REFERENCE_EDGE_KIND, schemaVersion: 99 } }]
      }
    });
    expect(normalized.document.edges.some((edge) => edge.id === "edge-v99")).toBe(false);
    expect(isSupportedShotReferenceEdgeData({ kind: SHOT_REFERENCE_EDGE_KIND, schemaVersion: 99 })).toBe(false);
  });

  it("原子创建入口（拉线/Agent 写路径）在同一次 node.add 里连出镜头参考边与映射", () => {
    const canvas = materialize(withDynamicFilmSet());
    const next = expectOk(apply(canvas, [{
      type: "node.add",
      node: { id: "video-2", type: "video", position: { x: 1200, y: 50 } },
      nodeData: { taskKind: "video-generation", taskStatus: "idle" },
      connect: { fromNodeId: PREVIEW_ID, edgeId: "edge-atomic-ref" }
    } as never]));
    const edge = next.document.edges.find((entry) => entry.id === "edge-atomic-ref")!;
    expect(edge.data?.kind).toBe(SHOT_REFERENCE_EDGE_KIND);
    expect(edge.data?.schemaVersion).toBe(SHOT_REFERENCE_SCHEMA_VERSION);
    const mapping = (next.nodeData["video-2"] as { inputMapping?: { sourceNodeId: string; role: string }[] }).inputMapping ?? [];
    expect(mapping.some((entry) => entry.sourceNodeId === PREVIEW_ID && entry.role === SHOT_REFERENCE_ROLE)).toBe(true);
  });

  it("原子创建入口拒绝非视频目标（不产生悬空节点或边）", () => {
    const canvas = materialize(withDynamicFilmSet());
    const rejected = apply(canvas, [{
      type: "node.add",
      node: { id: "image-2", type: "image", position: { x: 1200, y: 50 } },
      nodeData: { taskKind: "image-generation", taskStatus: "idle" },
      connect: { fromNodeId: PREVIEW_ID, edgeId: "edge-atomic-bad" }
    } as never]);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.rejection.code).toBe("invalid-connection");
  });

  it("镜头参考边不携带媒体结果字段（只保存稳定身份）", () => {
    const canvas = materialize(withDynamicFilmSet());
    const next = expectOk(apply(canvas, [{
      type: "edge.add",
      edge: { id: "edge-shot-ref", source: PREVIEW_ID, target: "video-1", sourceHandle: null, targetHandle: null }
    }]));
    const edge = next.document.edges.find((entry) => entry.id === "edge-shot-ref")!;
    for (const field of ["outputAssetId", "resultUrl", "url", "posterUrl", "textureHandle"]) {
      expect(edge.data?.[field]).toBeUndefined();
    }
    const previewData = next.nodeData[PREVIEW_ID] as Record<string, unknown>;
    expect(previewData.outputAssetId).toBeUndefined();
  });
});

describe("镜头参考内容身份（任务 8.1 / D9）", () => {
  function decodedAnimation(canvas: ServerCanvas) {
    const decoded = decodeFilmSetNodeData(canvas.nodeData.film);
    if (!decoded.ok) throw new Error(decoded.reason);
    return decoded.value;
  }

  it("同一镜头重命名不改变内容身份，也不改变缓存键", () => {
    const canvas = materialize(withDynamicFilmSet());
    const before = shotReferenceContentIdentity({ animation: decodedAnimation(canvas), clipId: "clip-1" })!;
    const renamed = expectOk(apply(canvas, [clipPatch(canvas, { kind: "rename", name: "换了个名字" })]));
    const after = shotReferenceContentIdentity({ animation: decodedAnimation(renamed), clipId: "clip-1" })!;
    expect(after).toBe(before);
    expect(shotReferenceCacheKey({
      canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: before
    })).toBe(shotReferenceCacheKey({
      canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: after
    }));
  });

  it("不同录制 profile 产生不同身份与缓存键", () => {
    const animation = decodedAnimation(materialize(withDynamicFilmSet()));
    const base = shotReferenceContentIdentity({ animation, clipId: "clip-1" })!;
    const half = shotReferenceContentIdentity({
      animation,
      clipId: "clip-1",
      profile: { ...DEFAULT_SHOT_REFERENCE_RECORD_PROFILE, width: 640, height: 360 }
    })!;
    expect(half).not.toBe(base);
    expect(shotReferenceProfileKey({ ...DEFAULT_SHOT_REFERENCE_RECORD_PROFILE, width: 640, height: 360 }))
      .not.toBe(shotReferenceProfileKey(DEFAULT_SHOT_REFERENCE_RECORD_PROFILE));
    expect(shotReferenceCacheKey({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: half }))
      .not.toBe(shotReferenceCacheKey({ canvasId: "c1", filmSetNodeId: "film", clipId: "clip-1", contentIdentity: base }));
  });

  it("时间线时长变化改变身份（画面变化即新版本）", () => {
    const animation = decodedAnimation(materialize(withDynamicFilmSet()));
    const base = shotReferenceContentIdentity({ animation, clipId: "clip-1" })!;
    const collection = filmSetAnimationsOf(animation);
    const changed = {
      ...animation,
      filmSetAnimations: {
        ...collection,
        clips: collection.clips.map((clip) =>
          clip.id === "clip-1" ? { ...clip, timeline: { ...clip.timeline, duration: clip.timeline.duration + 1 } } : clip
        )
      }
    } as typeof animation;
    expect(shotReferenceContentIdentity({ animation: changed, clipId: "clip-1" })).not.toBe(base);
  });

  it("片段不存在时返回 null（明确拒绝，不猜测）", () => {
    const animation = decodedAnimation(materialize(withDynamicFilmSet()));
    expect(shotReferenceContentIdentity({ animation, clipId: "missing" })).toBeNull();
  });
});
