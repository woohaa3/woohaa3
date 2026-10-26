import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
/**
 * 拍摄镜头预览生命周期与保护测试
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 2.1–2.3）。
 *
 * 覆盖：源镜头集增删/复制驱动的预览闭包、稳定 ID 与同画布唯一性、绕过保护的独立增删/改归属
 * 拒绝、owner 移动闭包（含显式落点优先与同 group 重父化）以及保存字段不被普通 patch 篡改。
 */
import { describe, expect, it } from "vitest";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";

import { createFilmSetSnapshot } from "./animation-snapshot.js";
import { canonicalFilmSetFields, filmSetAnimationsOf } from "./film-set-clip-view.js";
import { filmSetClipPrecondition, type FilmSetClipPatchOp } from "./film-set-clip-ops.js";
import { decodeFilmSetNodeData } from "./canvas-node-model.js";
import {
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  shotPreviewNodeId
} from "./film-set-shot-preview.js";
import { managedNodeRelationOf } from "./managed-node.js";

const NOW = "2026-10-15T00:00:00.000Z";

/** 带一个动态拍摄镜头（`clip-1`）的片场画布。 */
function withFilmSet(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("c1", NOW);
  canvas.document.nodes.push({
    id: "film",
    type: COMPOSITE_ASSET_NODE_TYPE,
    position: { x: 100, y: 50 },
    width: 320,
    height: 240
  });
  const animation = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: `motion.model.rotate("body", { speed: 1 });`,
    timeline: { duration: 5, loop: false }
  });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  return canvas;
}

function apply(canvas: ServerCanvas, commands: unknown[]): ReturnType<typeof applyCanvasCommands> {
  return applyCanvasCommands(canvas, commands as never, { now: NOW });
}

function expectOk(result: ReturnType<typeof applyCanvasCommands>): ServerCanvas {
  if (!result.ok) throw new Error(`期望成功，实际 ${result.rejection.code}: ${result.rejection.message}`);
  return result.canvas;
}

/** 让源镜头派生出的预览节点在权威画布中就位（真实写入后由同一批次 reconciliation 完成）。 */
function materialize(canvas: ServerCanvas): ServerCanvas {
  return expectOk(apply(canvas, [{ type: "canvas.setTitle", title: canvas.title ?? "" }]));
}

function previewNodes(canvas: ServerCanvas) {
  return canvas.document.nodes.filter((node) => managedNodeRelationOf(canvas.nodeData[node.id])?.extensionId === "film-set");
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

const PREVIEW_ID = shotPreviewNodeId("film", "clip-1");

describe("预览闭包随源镜头生命周期维护（任务 2.1）", () => {
  it("源镜头存在时同批创建固定身份的预览节点，重复写入不新增副本", () => {
    const canvas = materialize(withFilmSet());
    const previews = previewNodes(canvas);
    expect(previews).toHaveLength(1);
    expect(previews[0]!.id).toBe(PREVIEW_ID);
    expect(previews[0]!.type).toBe("video");
    expect(managedNodeRelationOf(canvas.nodeData[PREVIEW_ID])).toEqual({ schemaVersion: 1, extensionId: "film-set", ownerNodeId: "film", entityId: "clip-1", lifecycle: "owner-managed" });
    expect(canvas.nodeData[PREVIEW_ID].mediaContent).toEqual({ providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: "film", clipId: "clip-1" } });
    expect(canvas.nodeData[PREVIEW_ID].shotPreview).toBeUndefined();

    const again = expectOk(apply(canvas, [{ type: "canvas.setTitle", title: "改名" }]));
    expect(previewNodes(again)).toHaveLength(1);
    expect(previewNodes(again)[0]!.id).toBe(PREVIEW_ID);
  });

  it("创建镜头时同批创建其预览；复制新增独立预览；删除镜头级联移除", () => {
    const canvas = materialize(withFilmSet());
    const created = expectOk(apply(canvas, [clipPatch(canvas, {
      kind: "create",
      clip: {
        id: "clip-2",
        name: "新镜头",
        kind: "static",
        timeline: { duration: 0, loop: false },
        initialCamera: (canvas.nodeData.film as { sceneCamera: unknown }).sceneCamera as never,
        cameraMotion: { motionScript: "", motionScriptLanguage: "javascript", motionScriptVersion: "woohaa-motion-js-v1", revision: 1, sourceHash: "s", basedOnModelVersion: { revision: 1, contentHash: "camera" } },
        bindings: []
      } as never
    }, "clip-2")]));
    expect(previewNodes(created).map((node) => node.id).sort())
      .toEqual([PREVIEW_ID, shotPreviewNodeId("film", "clip-2")].sort());

    const duplicated = expectOk(apply(created, [clipPatch(created, { kind: "duplicate", newClipId: "clip-copy", name: "副本" })]));
    expect(previewNodes(duplicated)).toHaveLength(3);

    const deleted = expectOk(apply(duplicated, [clipPatch(duplicated, { kind: "delete" }, "clip-copy")]));
    expect(previewNodes(deleted).some((node) => node.id === shotPreviewNodeId("film", "clip-copy"))).toBe(false);
    expect(deleted.nodeData[shotPreviewNodeId("film", "clip-copy")]).toBeUndefined();
  });

  it("删除整个片场时同批清理其预览节点与归属数据", () => {
    const canvas = materialize(withFilmSet());
    expect(canvas.document.nodes.some((node) => node.id === PREVIEW_ID)).toBe(true);
    const removed = expectOk(apply(canvas, [{ type: "node.remove", nodeIds: ["film"] }]));
    expect(removed.document.nodes.some((node) => node.id === PREVIEW_ID)).toBe(false);
    expect(removed.nodeData[PREVIEW_ID]).toBeUndefined();
  });

  it("源删除时同批清理从预览拉出的镜头参考边与目标映射（任务 8.2）", () => {
    const canvas = materialize(withFilmSet());
    canvas.document.nodes.push({
      id: "video-1",
      type: "video",
      position: { x: 600, y: 50 },
      width: 240,
      height: 180
    });
    canvas.nodeData["video-1"] = { taskKind: "video-generation", taskStatus: "idle" } as never;
    const linked = expectOk(apply(canvas, [{
      type: "edge.add",
      edge: { id: "edge-shot-ref", source: PREVIEW_ID, target: "video-1", sourceHandle: null, targetHandle: null }
    }]));
    expect(linked.document.edges.some((edge) => edge.id === "edge-shot-ref")).toBe(true);

    const removed = expectOk(apply(linked, [{ type: "node.remove", nodeIds: ["film"] }]));
    expect(removed.document.edges.some((edge) => edge.id === "edge-shot-ref")).toBe(false);
    const mapping = (removed.nodeData["video-1"] as { inputMapping?: unknown[] }).inputMapping ?? [];
    expect(mapping.some((entry) => (entry as { sourceNodeId: string }).sourceNodeId === PREVIEW_ID)).toBe(false);
  });

  it("源镜头变化时保留既有预览的 ID、位置与尺寸", () => {
    const canvas = materialize(withFilmSet());
    const moved = expectOk(apply(canvas, [{ type: "node.update", nodeId: PREVIEW_ID, position: { x: 500, y: 400 } }]));
    const before = moved.document.nodes.find((node) => node.id === PREVIEW_ID)!;
    expect(before.position).toEqual({ x: 500, y: 400 });

    const renamed = expectOk(apply(moved, [clipPatch(moved, { kind: "rename", name: "新名称" })]));
    const after = renamed.document.nodes.find((node) => node.id === PREVIEW_ID)!;
    expect(after.position).toEqual(before.position);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
  });
});

describe("预览保护（任务 2.2）", () => {
  it("拒绝独立删除受保护预览", () => {
    const canvas = materialize(withFilmSet());
    const result = apply(canvas, [{ type: "node.remove", nodeIds: [PREVIEW_ID] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("invalid-command");
  });

  it("拒绝伪造预览新增（缺归属或 ID 不匹配）", () => {
    const canvas = materialize(withFilmSet());
    const fakeId = "shot-preview:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const noOwnership = apply(canvas, [{ type: "node.add", node: { id: fakeId, type: FILM_SET_SHOT_PREVIEW_NODE_TYPE, position: { x: 0, y: 0 } } }]);
    expect(noOwnership.ok).toBe(false);
    const mismatched = apply(canvas, [{
      type: "node.add",
      node: { id: fakeId, type: FILM_SET_SHOT_PREVIEW_NODE_TYPE, position: { x: 0, y: 0 } },
      nodeData: { shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "clip-1" } }
    }]);
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.rejection.code).toBe("invalid-shot-preview");
  });

  it("拒绝改写预览归属，允许媒体缓存写回并保留来源", () => {
    const canvas = materialize(withFilmSet());
    const rewrite = apply(canvas, [{ type: "nodeData.patch", nodeId: PREVIEW_ID, value: { shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "other" } } }]);
    expect(rewrite.ok).toBe(false);
    const media = apply(canvas, [{ type: "nodeData.patch", nodeId: PREVIEW_ID, value: { outputAssetId: "asset-1" } }]);
    expect(media.ok).toBe(true);
    if (media.ok) expect(media.canvas.nodeData[PREVIEW_ID]).toEqual({ ...canvas.nodeData[PREVIEW_ID], outputAssetId: "asset-1" });
  });

  it("拒绝独立改变预览归属分组", () => {
    const canvas = materialize(withFilmSet());
    const grouped = expectOk(apply(canvas, [{ type: "node.add", node: { id: "g", type: "group", position: { x: 0, y: 0 } } }]));
    const result = apply(grouped, [{ type: "node.update", nodeId: PREVIEW_ID, parentId: "g" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe("invalid-shot-preview");
  });

  it("合法源级联不误拒绝（同批删除片场）", () => {
    const canvas = materialize(withFilmSet());
    const result = apply(canvas, [{ type: "node.remove", nodeIds: ["film"] }]);
    expect(result.ok).toBe(true);
  });

  it("拒绝把预览接入普通连线（edge.add 不进入边拓扑）", () => {
    const canvas = materialize(withFilmSet());
    const withImage = expectOk(apply(canvas, [{ type: "node.add", node: { id: "img", type: "image", position: { x: 0, y: 0 } } }]));
    const outgoing = apply(withImage, [{ type: "edge.add", edge: { id: "e1", source: PREVIEW_ID, target: "img", sourceHandle: null, targetHandle: null } }]);
    expect(outgoing.ok).toBe(false);
    const incoming = apply(withImage, [{ type: "edge.add", edge: { id: "e2", source: "img", target: PREVIEW_ID, sourceHandle: null, targetHandle: null } }]);
    expect(incoming.ok).toBe(false);
  });

  it("拒绝通过 edit.apply 伪造节点身份或独立写归属（绕过面覆盖）", () => {
    const canvas = materialize(withFilmSet());
    const byNewId = apply(canvas, [{
      type: "edit.apply",
      preconditions: [],
      operations: [{
        kind: "node-add",
        node: { id: "shot-preview:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", type: FILM_SET_SHOT_PREVIEW_NODE_TYPE, position: { x: 0, y: 0 } },
        nodeData: { shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "clip-1" } }
      }]
    }]);
    expect(byNewId.ok).toBe(false);
    if (!byNewId.ok) expect(byNewId.rejection.code).toBe("invalid-shot-preview");
    const rewriteOwnership = apply(canvas, [{
      type: "edit.apply",
      preconditions: [],
      operations: [{ kind: "node-data-set", nodeId: PREVIEW_ID, value: { shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "other" } } }]
    }]);
    expect(rewriteOwnership.ok).toBe(false);
  });
});

describe("owner 移动闭包（任务 2.3）", () => {
  function withPreviewAt(): ServerCanvas {
    const canvas = materialize(withFilmSet());
    return expectOk(apply(canvas, [{ type: "node.update", nodeId: PREVIEW_ID, position: { x: 480, y: 50 } }]));
  }

  it("移动片场时预览同步位移，保持世界相对位置", () => {
    const canvas = withPreviewAt();
    const before = getAbsolute(canvas, PREVIEW_ID);
    const moved = expectOk(apply(canvas, [{ type: "node.update", nodeId: "film", position: { x: 130, y: 30 } }]));
    const after = getAbsolute(moved, PREVIEW_ID);
    expect(after.x - before.x).toBeCloseTo(30, 6);
    expect(after.y - before.y).toBeCloseTo(-20, 6);
  });

  it("显式落点的预览不被再次叠加片场位移", () => {
    const canvas = withPreviewAt();
    const explicit = { x: 900, y: 800 };
    const moved = expectOk(apply(canvas, [
      { type: "node.update", nodeId: "film", position: { x: 130, y: 30 } },
      { type: "node.update", nodeId: PREVIEW_ID, position: explicit }
    ]));
    expect(getAbsolute(moved, PREVIEW_ID)).toEqual(explicit);
  });

  it("片场重父化到 group 时预览跟随同一 parent，保持世界相对位置", () => {
    const canvas = withPreviewAt();
    const before = getAbsolute(canvas, PREVIEW_ID);
    const grouped = expectOk(apply(canvas, [{ type: "node.add", node: { id: "g", type: "group", position: { x: 0, y: 0 }, width: 2000, height: 2000 } }]));
    const parented = expectOk(apply(grouped, [{ type: "node.update", nodeId: "film", parentId: "g" }]));
    const preview = parented.document.nodes.find((node) => node.id === PREVIEW_ID)!;
    expect(preview.parentId).toBe("g");
    expect(getAbsolute(parented, PREVIEW_ID)).toEqual(before);
  });
});

function getAbsolute(canvas: ServerCanvas, nodeId: string): { x: number; y: number } {
  const byId = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const node = byId.get(nodeId)!;
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const guard = new Set<string>();
  while (parentId && !guard.has(parentId)) {
    guard.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}
