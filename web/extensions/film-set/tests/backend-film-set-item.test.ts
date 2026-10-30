import { migrateLegacyFilmSetToGroup, readFilmSetAnimationProjection } from "@woohaa3/contracts";
/**
 * 片场对象级权威写入服务测试
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 2.3/7.1）。
 */
import { describe, expect, it } from "vitest";
import {
  filmSetContentContribution,
  filmSetNodeDataFields,
  createFilmSetSnapshot,
  ContentContributionRegistry,
  createEmptyWoohaa3ServerCanvas,
  createModel3DNodeData,
  filmSetItemById,
  type CanvasNodeData,
  type ServerCanvas
} from "@woohaa3/contracts";
import { InMemoryYjsDocumentRepository } from "../../../services/canvas-service/src/sync/index.js";
import { CanvasRoom } from "../../../services/canvas-service/src/sync/room.js";
import { FilmSetItemService } from "../src/backend.js";

const NOW = "2026-10-09T00:00:00.000Z";
const SCRIPT = "scene.box({ id: 'torso' });";

async function readyRoom(withItem = true): Promise<CanvasRoom> {
  const repository = new InMemoryYjsDocumentRepository();
  const content = new ContentContributionRegistry();
  content.register(filmSetContentContribution);
  const room = new CanvasRoom({ canvasId: "c1", repository, now: () => NOW, content });
  const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
  const snapshot = createFilmSetSnapshot({
    title: "片场",
    model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" },
    motionScript: "",
    timeline: { duration: 0, loop: false },
    ...(withItem
      ? {
          filmSetContent: {
            schemaVersion: 4 as const,
            items: [
              {
                id: "obj-a",
                kind: "model" as const,
                name: "模型",
                localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
                model: createModel3DNodeData({ title: "m", model: { modelScript: SCRIPT, modelScriptVersion: "woohaa-model-js-v2" } }).model!
              }
            ]
          }
        }
      : {})
  });
  const canvas: ServerCanvas = {
    ...base,
    document: {
      ...base.document,
      nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }],
      edges: []
    },
    nodeData: { film: filmSetNodeDataFields(snapshot) as CanvasNodeData },
    assets: []
  };
  const migrated = migrateLegacyFilmSetToGroup(canvas, "film", { commandId: "fixture", groupId: "film" });
  if (!migrated.ok) throw new Error(migrated.reason);
  await room.initialize({ canvas: migrated.canvas, roomEpoch: "epoch-1", createdAt: NOW });
  return room;
}

function service(room: CanvasRoom): FilmSetItemService {
  return new FilmSetItemService({ resolveRoom: async () => room, now: () => NOW });
}

describe("FilmSetItemService（任务 2.3）", () => {
  it("transform 只改目标对象，幂等 requestId 不重复", async () => {
    const room = await readyRoom();
    const svc = service(room);
    const first = await svc.mutate({
      canvasId: "c1",
      requestId: "r1",
      nodeId: "film",
      itemId: "obj-a",
      op: { kind: "transform", localTransform: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 } }
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const retry = await svc.mutate({
      canvasId: "c1",
      requestId: "r1",
      nodeId: "film",
      itemId: "obj-a",
      op: { kind: "transform", localTransform: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 } }
    });
    expect(retry.ok && retry.itemCount).toBe(first.itemCount);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    const content = readFilmSetAnimationProjection(exported.canvas, "film")!.filmSetContent;
    expect(filmSetItemById(content, "obj-a")?.localTransform.offset.x).toBe(2);
  });

  it("对象不存在时拒绝，不写入", async () => {
    const room = await readyRoom();
    const outcome = await service(room).mutate({
      canvasId: "c1",
      requestId: "r1",
      nodeId: "film",
      itemId: "missing",
      op: { kind: "delete" }
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("unknown-item");
  });

  it("content precondition 冲突拒绝", async () => {
    const room = await readyRoom();
    const outcome = await service(room).mutate({
      canvasId: "c1",
      requestId: "r1",
      nodeId: "film",
      itemId: "obj-a",
      op: { kind: "delete" },
      expectedContentHash: "stale"
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("stale-content");
  });

  it("连续静态修改保留已有变换，动作只能经片段 binding 写入", async () => {
    const room = await readyRoom();
    const svc = service(room);
    await svc.mutate({
      canvasId: "c1", requestId: "r1", nodeId: "film", itemId: "obj-a",
      op: { kind: "transform", localTransform: { offset: { x: 1, y: 0, z: 0 }, scale: 1, yaw: 0 } }
    });
    // 再次静态修改（模拟并发第二个请求），基于最新集合派生，保留此前变换。
    const second = await svc.mutate({
      canvasId: "c1", requestId: "r2", nodeId: "film", itemId: "obj-a",
      op: { kind: "transform", localTransform: { offset: { x: 2, y: 0, z: 0 }, scale: 1, yaw: 0 } }
    });
    expect(second.ok).toBe(true);
    const exported = room.exportCanvas();
    if (!exported.ok) throw new Error("export");
    const content = readFilmSetAnimationProjection(exported.canvas, "film")!.filmSetContent;
    const item = filmSetItemById(content, "obj-a");
    expect(item?.localTransform.offset.x).toBe(2);
    // items-only：静态内容不携带任何对象级 motion/playback（动作只在片段 binding）。
    expect(item?.playback).toBeUndefined();
    expect(item?.motion).toBeUndefined();
  });
});
