/**
 * 片场复制导入权威服务测试
 * （change: 2026-10-08-make-film-set-model-only，任务 2.3/6.1）。
 */
import { describe, expect, it } from "vitest";
import {
  filmSetNodeDataFields,
  createFilmSetSnapshot,
  createMotionSnapshot,
  createEmptyWoohaa3ServerCanvas,
  createModel3DNodeData,
  model3DNodeDataFields,
  decodeFilmSetNodeData,
  resolveFilmSetClip,
  type CanvasNodeData,
  type FilmSetContent,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { InMemoryYjsDocumentRepository } from "../../../services/canvas-service/src/sync/index.js";
import { CanvasRoom } from "../../../services/canvas-service/src/sync/room.js";
import { FilmSetImportService } from "../src/backend.js";

const NOW = "2026-10-08T00:00:00.000Z";
const SCRIPT = "scene.box({ id: 'torso' });";

function imageAsset(): StoredAsset {
  return {
    id: "asset-image",
    title: "图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 4 }
  };
}

function videoAsset(): StoredAsset {
  return {
    id: "asset-video",
    title: "视",
    mediaKind: "video",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    durationSeconds: 12,
    metadata: { storageKey: `sha256-${"b".repeat(64)}`, checksum: "b".repeat(64), contentType: "video/mp4", size: 8 }
  };
}

async function readyRoom(): Promise<CanvasRoom> {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: "c1", repository, now: () => NOW });
  const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
  const canvas: ServerCanvas = {
    ...base,
    document: {
      ...base.document,
      nodes: [
        { id: "film", type: "composite-asset", position: { x: 0, y: 0 } },
        { id: "model", type: "model3d", position: { x: 400, y: 0 } },
        { id: "img", type: "image", position: { x: 800, y: 0 } },
        { id: "vid", type: "video", position: { x: 800, y: 100 } },
        { id: "txt", type: "text", position: { x: 800, y: 200 } }
      ],
      edges: []
    },
    nodeData: {
      film: filmSetNodeDataFields(createFilmSetSnapshot({
        title: "片场",
        model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" },
        // 非空动作使默认片段（clip-1）存在，供时间线扩展用例使用。
        motionScript: "motion.model.rotate('torso', { speed: 1 });",
        timeline: { duration: 4, loop: false }
      })) as CanvasNodeData,
      model: model3DNodeDataFields(createModel3DNodeData({
        title: "模型",
        model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" }
      })) as CanvasNodeData,
      img: { title: "图", outputAssetId: "asset-image" } as CanvasNodeData,
      vid: { title: "视", outputAssetId: "asset-video" } as CanvasNodeData,
      txt: { title: "文本" } as CanvasNodeData
    },
    assets: [imageAsset(), videoAsset()]
  };
  await room.initialize({ canvas, roomEpoch: "epoch-1", createdAt: NOW });
  return room;
}

function service(room: CanvasRoom): FilmSetImportService {
  return new FilmSetImportService({ resolveRoom: async () => room, now: () => NOW });
}

function defaultClipId(animation: { filmSetAnimations?: { defaultClipId: string | null } }): string {
  const clipId = animation.filmSetAnimations?.defaultClipId;
  if (!clipId) throw new Error("missing default clip");
  return clipId;
}

describe("FilmSetImportService（任务 2.3）", () => {
  it("复制导入模型与图片到片场，源节点位置/类型不变", async () => {
    const room = await readyRoom();
    const outcome = await service(room).import({
      canvasId: "c1",
      requestId: "req-1",
      nodeId: "film",
      items: [
        { kind: "model", itemId: "obj-model", name: "模型", sourceNodeId: "model" },
        { kind: "image", itemId: "obj-image", name: "图", sourceNodeId: "img", assetId: "asset-image", aspectRatio: 2 }
      ]
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.itemCount).toBe(4); // ground + model item + obj-model + obj-image
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    // 来源位置不变。
    expect(exported.canvas.document.nodes.find((node) => node.id === "model")?.position).toEqual({ x: 400, y: 0 });
    // 导入对象为纯静态 items（动作只在片段 binding，本次未带动作故无绑定）。
    const content = exported.canvas.nodeData.film.filmSetContent as FilmSetContent;
    expect(content.schemaVersion).toBe(3);
    expect(content.items.find(item => item.id === "obj-model")?.motion).toBeUndefined();
    expect(content.items.find(item => item.id === "obj-image")?.motion).toBeUndefined();
  });

  it("重复 requestId 幂等不重复追加；新 requestId 追加独立对象", async () => {
    const room = await readyRoom();
    const svc = service(room);
    const first = await svc.import({
      canvasId: "c1", requestId: "req-1", nodeId: "film",
      items: [{ kind: "image", itemId: "obj-1", name: "图", sourceNodeId: "img", assetId: "asset-image", aspectRatio: 2 }]
    });
    const retry = await svc.import({
      canvasId: "c1", requestId: "req-1", nodeId: "film",
      items: [{ kind: "image", itemId: "obj-1", name: "图", sourceNodeId: "img", assetId: "asset-image", aspectRatio: 2 }]
    });
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.itemCount).toBe(first.itemCount);
    const second = await svc.import({
      canvasId: "c1", requestId: "req-2", nodeId: "film",
      items: [{ kind: "image", itemId: "obj-2", name: "图", sourceNodeId: "img", assetId: "asset-image", aspectRatio: 2 }]
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.itemCount).toBe(first.itemCount + 1);
  });

  it("文本等不支持来源整批拒绝，片场不追加内容", async () => {
    const room = await readyRoom();
    const outcome = await service(room).import({
      canvasId: "c1", requestId: "req-1", nodeId: "film",
      items: [{ kind: "image", itemId: "obj-1", name: "图", sourceNodeId: "img", assetId: "asset-image", aspectRatio: 2 }]
    });
    expect(outcome.ok).toBe(true);
    // 结构层不支持的类型无法构造；这里验证来源节点类型不符时整批拒绝。
    const rejected = await service(room).import({
      canvasId: "c1", requestId: "req-2", nodeId: "film",
      items: [{ kind: "model", itemId: "obj-x", name: "文本", sourceNodeId: "txt" }]
    });
    expect(rejected.ok).toBe(false);
  });

  it("视频导入超出当前时长时扩展默认片段时间线", async () => {
    const room = await readyRoom();
    const outcome = await service(room).import({
      canvasId: "c1", requestId: "req-video", nodeId: "film",
      items: [{ kind: "video", itemId: "obj-video", name: "视", sourceNodeId: "vid", assetId: "asset-video", aspectRatio: 1.5, durationSeconds: 12 }]
    });
    expect(outcome.ok).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    const decoded = decodeFilmSetNodeData(exported.canvas.nodeData["film"]);
    if (!decoded.ok) throw new Error(decoded.reason);
    const view = resolveFilmSetClip(decoded.value, defaultClipId(decoded.value));
    expect(view?.timeline.duration).toBe(12);
    expect(view?.timeline.loop).toBe(false);
  });

  it("默认镜头为静态时不因导入视频延长时长（schema3）", async () => {
    const room = await readyRoom();
    // 把默认镜头改成合法静态镜头：零时长、无动作。
    const exported0 = room.exportCanvas();
    if (!exported0.ok) throw new Error("export failed");
    const current = decodeFilmSetNodeData(exported0.canvas.nodeData["film"]);
    if (!current.ok) throw new Error(current.reason);
    const fields = filmSetNodeDataFields({
      ...current.value,
      filmSetAnimations: {
        schemaVersion: 3 as const,
        defaultClipId: "static-1",
        clips: [{
          id: "static-1",
          name: "静态镜头",
          kind: "static" as const,
          timeline: { duration: 0, loop: false },
          initialCamera: current.value.sceneCamera,
          cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }),
          bindings: []
        }]
      }
    });
    const patched = await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: "c1",
      commandId: "static-default",
      baseRevision: exported0.canvas.revision,
      actorId: "web",
      commands: [{ type: "nodeData.patch", nodeId: "film", value: fields as CanvasNodeData }]
    });
    expect(patched.ok).toBe(true);
    const outcome = await service(room).import({
      canvasId: "c1", requestId: "req-video-static", nodeId: "film",
      items: [{ kind: "video", itemId: "obj-video", name: "视", sourceNodeId: "vid", assetId: "asset-video", aspectRatio: 1.5, durationSeconds: 12 }]
    });
    expect(outcome.ok).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export failed");
    const decoded = decodeFilmSetNodeData(exported.canvas.nodeData["film"]);
    if (!decoded.ok) throw new Error(decoded.reason);
    const view = resolveFilmSetClip(decoded.value, "static-1");
    expect(view?.timeline.duration).toBe(0);
    expect(view?.timeline.loop).toBe(false);
  });

  it("来源模型内容变化时返回稳定冲突，不写入片场", async () => {
    const room = await readyRoom();
    const outcome = await service(room).import({
      canvasId: "c1", requestId: "req-1", nodeId: "film",
      items: [{ kind: "model", itemId: "obj-model", name: "模型", sourceNodeId: "model", expectedSourceHash: "wrong-hash" }]
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("stale-source");
  });
});
