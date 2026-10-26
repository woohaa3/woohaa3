import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
/**
 * 片场媒体条目受控导入（change: 2026-10-19-extend-film-set-for-motion-graphics，D5）。
 *
 * 覆盖：agent 放入 ready 图片/视频、来源未就绪/类型不符、precondition 过期、来源保持不变。
 *
 * 这里用进程内伪权威（`applyCanvasCommands`）而不是 CanvasRoom，让该用例只依赖 contracts 与
 * 片场扩展本身，不牵入画布服务的持久化装配。
 */
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  createFilmSetSnapshot,
  decodeFilmSetNodeData,
  filmSetContentHash,
  filmSetNodeDataFields,
  type CanvasAuthority,
  type CanvasNodeData,
  type FilmSetContent,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import { FilmSetMediaService } from "../src/authoring/backend/film-set-media.js";

const NOW = "2026-10-19T00:00:00.000Z";
const SCRIPT = "scene.box({ id: 'torso' });";

function imageAsset(overrides: Record<string, unknown> = {}): StoredAsset {
  return {
    id: "asset-image",
    title: "图",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 4, width: 1600, height: 900 },
    ...overrides
  } as StoredAsset;
}

function videoAsset(): StoredAsset {
  return {
    id: "asset-video",
    title: "视",
    mediaKind: "video",
    source: "generated",
    status: "ready",
    createdAt: NOW,
    metadata: { storageKey: `sha256-${"b".repeat(64)}`, checksum: "b".repeat(64), contentType: "video/mp4", size: 8, width: 1920, height: 1080, duration: 6 },
    durationSeconds: 6
  } as StoredAsset;
}

function baseCanvas(assets: StoredAsset[] = [imageAsset(), videoAsset()]): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
  return {
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
        motionScript: "motion.model.rotate('torso', { speed: 1 });",
        timeline: { duration: 4, loop: false }
      })) as CanvasNodeData,
      img: { title: "图", outputAssetId: "asset-image" } as CanvasNodeData,
      vid: { title: "视", outputAssetId: "asset-video" } as CanvasNodeData,
      txt: { title: "文本" } as CanvasNodeData
    },
    assets
  };
}

/** 进程内伪权威：命令走真实 reducer，保留幂等 commandId 语义。 */
function authority(initial: ServerCanvas = baseCanvas()): CanvasAuthority & { canvas(): ServerCanvas } {
  let current = initial;
  const seen = new Set<string>();
  return {
    canvas: () => current,
    exportCanvas: () => ({ ok: true as const, canvas: current }),
    async submit(batch: CanvasCommandBatch) {
      return this.submitDerived({
        commandId: batch.commandId,
        derive: () => ({ ok: true as const, batch })
      });
    },
    async submitDerived({ commandId, derive }) {
      if (seen.has(commandId)) return { ok: true, status: "duplicate", commandId, revision: current.revision, noop: true };
      const derived = derive(current);
      if (!derived.ok) return derived;
      const applied = applyCanvasCommands(current, derived.batch.commands, { now: NOW });
      if (!applied.ok) return { ok: false, code: applied.rejection.code, message: applied.rejection.message };
      current = applied.canvas;
      seen.add(commandId);
      return { ok: true, status: "accepted", commandId, revision: current.revision, noop: !applied.changed };
    }
  };
}

function service(room: CanvasAuthority): FilmSetMediaService {
  return new FilmSetMediaService({ resolveRoom: async () => room, now: () => NOW });
}

function contentOf(room: CanvasAuthority & { canvas(): ServerCanvas }): FilmSetContent {
  const decoded = decodeFilmSetNodeData(room.canvas().nodeData.film);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value.filmSetContent;
}

describe("add_film_set_media（D5）", () => {
  it("imports a ready image with its intrinsic aspect ratio and keeps the source node untouched", async () => {
    const room = authority();
    const sourceBefore = room.canvas().document.nodes.find(node => node.id === "img");
    const outcome = await service(room).addMedia({ canvasId: "c1", nodeId: "film", requestId: "r1", sourceNodeId: "img" });
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.itemKind).toBe("image");
    const item = contentOf(room).items.find(entry => entry.id === outcome.itemId);
    expect(item).toMatchObject({ kind: "image", assetId: "asset-image", aspectRatio: 1600 / 900 });
    expect(item && "origin" in item ? item.origin?.sourceNodeId : undefined).toBe("img");
    expect(room.canvas().document.nodes.find(node => node.id === "img")).toEqual(sourceBefore);
  });

  it("imports a ready video and extends an existing dynamic timeline with its duration", async () => {
    const room = authority();
    const outcome = await service(room).addMedia({ canvasId: "c1", nodeId: "film", requestId: "r2", sourceNodeId: "vid" });
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.itemKind).toBe("video");
    const decoded = decodeFilmSetNodeData(room.canvas().nodeData.film);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value.filmSetAnimations?.clips[0]?.timeline.duration).toBeGreaterThanOrEqual(6);
  });

  it("honours an explicit itemId, name and transform", async () => {
    const room = authority();
    const outcome = await service(room).addMedia({
      canvasId: "c1",
      nodeId: "film",
      requestId: "r3",
      sourceNodeId: "img",
      itemId: "card-image",
      name: "第一张卡片",
      transform: { offset: { x: 1, y: 2, z: 3 }, scale: 0.5, yaw: 0.25 }
    });
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.itemId).toBe("card-image");
    const item = contentOf(room).items.find(entry => entry.id === "card-image");
    expect(item?.name).toBe("第一张卡片");
    expect(item?.localTransform).toEqual({ offset: { x: 1, y: 2, z: 3 }, scale: 0.5, yaw: 0.25 });
  });

  it("is idempotent for the same requestId", async () => {
    const room = authority();
    const svc = service(room);
    const first = await svc.addMedia({ canvasId: "c1", nodeId: "film", requestId: "r4", sourceNodeId: "img" });
    const retry = await svc.addMedia({ canvasId: "c1", nodeId: "film", requestId: "r4", sourceNodeId: "img" });
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.itemCount).toBe(first.itemCount);
    expect(retry.duplicate).toBe(true);
  });

  it("rejects non-media sources and stale preconditions without touching content", async () => {
    const room = authority();
    const svc = service(room);
    const before = contentOf(room);
    expect(await svc.addMedia({ canvasId: "c1", nodeId: "film", requestId: "r5", sourceNodeId: "txt" }))
      .toMatchObject({ ok: false, code: "unsupported-source" });
    expect((await svc.addMedia({ canvasId: "c1", nodeId: "film", requestId: "r6", sourceNodeId: "model" })).ok).toBe(false);
    expect(await svc.addMedia({
      canvasId: "c1",
      nodeId: "film",
      requestId: "r7",
      sourceNodeId: "img",
      expectedContentHash: "not-current"
    })).toMatchObject({ ok: false, code: "stale-content" });
    expect(contentOf(room).items.map(item => item.id)).toEqual(before.items.map(item => item.id));
  });

  it("accepts the current content hash as precondition", async () => {
    const room = authority();
    const current = filmSetContentHash(contentOf(room));
    const outcome = await service(room).addMedia({
      canvasId: "c1",
      nodeId: "film",
      requestId: "r8",
      sourceNodeId: "img",
      expectedContentHash: current
    });
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
  });

  it("rejects non-ready assets with a concrete reason", async () => {
    const room = authority(baseCanvas([imageAsset({ status: "pending" }), videoAsset()]));
    const outcome = await service(room).addMedia({ canvasId: "c1", nodeId: "film", requestId: "r9", sourceNodeId: "img" });
    expect(outcome).toMatchObject({ ok: false, code: "asset-not-ready" });
  });
});
