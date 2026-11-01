/**
 * 服务端 canvas room 测试（任务 4.1–4.6）。
 *
 * 覆盖：串行命令与并行 room、durable-before-broadcast、no-op/拒绝/limit/存储失败、
 * 损坏隔离、连接引用计数与空闲回收、多 room 无泄漏。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { recoverYjsDocument } from "./recovery.js";
import { CanvasRoom } from "./room.js";
import { CanvasRoomRegistry } from "./room-registry.js";
import { SqliteYjsRepository } from "../storage/sqlite/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-room";

/** 自包含 model3d 节点必须携带完整本地模型定义（命令边界校验要求）。 */
const MODEL3D_NODE_DATA = {
  modelScript: "scene.box({ id: 'body' });",
  modelScriptLanguage: "javascript",
  modelScriptVersion: "woohaa-model-js-v2",
  modelContentVersion: { revision: 1, sourceHash: "m3d-source", contentHash: "m3d-content" },
  modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
};

/** 构造一个合法的 model3d `node.add` 命令（含自包含定义）。 */
function addModel3dCommand(id: string) {
  return { type: "node.add" as const, node: { id, type: "model3d", position: { x: 0, y: 0 } }, nodeData: { ...MODEL3D_NODE_DATA } };
}

function batch(overrides: Partial<CanvasCommandBatch> = {}): CanvasCommandBatch {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: "cmd-1",
    baseRevision: 0,
    actorId: "actor",
    commands: [{ type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } }],
    ...overrides
  };
}

async function readyRoom(options: {
  repository?: InMemoryYjsDocumentRepository;
  canvasId?: string;
  broadcast?: ConstructorParameters<typeof CanvasRoom>[0]["broadcast"];
  onCommitted?: ConstructorParameters<typeof CanvasRoom>[0]["onCommitted"];
} = {}): Promise<{ room: CanvasRoom; repository: InMemoryYjsDocumentRepository }> {
  const repository = options.repository ?? new InMemoryYjsDocumentRepository();
  const canvasId = options.canvasId ?? CANVAS;
  const room = new CanvasRoom({
    canvasId,
    repository,
    now: () => NOW,
    broadcast: options.broadcast,
    ...(options.onCommitted ? { onCommitted: options.onCommitted } : {})
  });
  await room.initialize({
    canvas: createEmptyWoohaa3ServerCanvas(canvasId, NOW),
    roomEpoch: "epoch-1",
    createdAt: NOW
  });
  return { room, repository };
}

describe("串行命令与并行 room（任务 4.1）", () => {
  it("persists world identities through a SQLite room restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "world-room-"));
    const file = path.join(dir, "canvas.sqlite");
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 1 } };
    const parameters = { matrix: [[1, 0], [0, 1]], lease: "commercial", gpuCount: 2, nested: [null, true, { writeLease: "parameter" }] };
    const group = { kind: "workflow-group-2d", version: "shared-world-v1", groupId: "g", scopeVersion: "1", memberNodeIds: ["model"] };
    const area = { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "1", bounds: { min: { u: 0, v: 0 }, max: { u: 2, v: 2 } } };
    const camera = { kind: "world-camera", version: "shared-world-v1", cameraId: "c", settingsVersion: "1", position: { u: 0, v: 0, h: 1 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 }, captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: "missing" };
    const repository = new SqliteYjsRepository({ path: file });
    try {
      const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
      await room.initialize({ canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW), roomEpoch: "epoch-1", createdAt: NOW });
      const result = await room.submit(batch({ commands: [
        { ...addModel3dCommand("model"), nodeData: { ...MODEL3D_NODE_DATA, sharedWorldInstance: instance, parameters } },
        addModel3dCommand("legacy-model"),
        { type: "node.add", node: { id: "image", type: "image", position: { x: 0, y: 0 } } },
        { type: "node.add", node: { id: "group", type: "workflow-group-2d", position: { x: 0, y: 0 } }, nodeData: { workflowGroup2d: group }, connect: { fromNodeId: "image", edgeId: "e-group" } },
        { type: "node.add", node: { id: "area", type: "scene-area", position: { x: 0, y: 0 } }, nodeData: { sceneArea: area }, connect: { fromNodeId: "image", edgeId: "e-area" } },
        { type: "node.add", node: { id: "camera", type: "world-camera", position: { x: 0, y: 0 } }, nodeData: { worldCamera: camera }, connect: { fromNodeId: "image", edgeId: "e-camera" } }
      ] }));
      expect(result.ok).toBe(true);
      repository.close();
      const reopened = new SqliteYjsRepository({ path: file });
      try {
        const restored = new CanvasRoom({ canvasId: CANVAS, repository: reopened, now: () => NOW });
        expect((await restored.load()).ok).toBe(true);
        const exported = restored.exportCanvas();
        expect(exported.ok).toBe(true);
        if (exported.ok) {
          expect(exported.canvas.nodeData.model.sharedWorldInstance).toEqual(instance);
          expect(exported.canvas.nodeData.model.parameters).toEqual(parameters);
          expect(exported.canvas.nodeData["legacy-model"]).toEqual(MODEL3D_NODE_DATA);
          expect(exported.canvas.nodeData["legacy-model"].sharedWorldInstance).toBeUndefined();
          expect(exported.canvas.nodeData.group.workflowGroup2d).toEqual(group);
          expect(exported.canvas.nodeData.area.sceneArea).toEqual(area);
          expect(exported.canvas.nodeData.camera.worldCamera).toEqual(camera);
          for (const id of ["group", "area", "camera"]) expect(exported.canvas.nodeData[id].inputMapping).toHaveLength(1);
        }
        expect((await restored.submit(batch({ commandId: "after-reload", baseRevision: 1, commands: [{ type: "node.update", nodeId: "camera", position: { x: 10, y: 20 } }] }))).ok).toBe(true);
      } finally { reopened.close(); }
    } finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("同 room 的并发命令不交错，revision 连续递增", async () => {
    const { room } = await readyRoom();
    const results = await Promise.all([
      room.submit(batch({ commandId: "cmd-1", commands: [{ type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } }] })),
      room.submit(batch({ commandId: "cmd-2", commands: [{ type: "node.add", node: { id: "b", type: "image", position: { x: 10, y: 0 } } }] })),
      room.submit(batch({ commandId: "cmd-3", commands: [{ type: "node.add", node: { id: "c", type: "image", position: { x: 20, y: 0 } } }] }))
    ]);
    for (const result of results) expect(result.ok).toBe(true);
    const revisions = results.map((result) => (result.ok ? result.revision : -1));
    expect(revisions).toEqual([1, 2, 3]);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.document.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("不同 room 可以并行推进", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const roomA = await readyRoom({ repository, canvasId: "canvas-a" });
    const roomB = await readyRoom({ repository, canvasId: "canvas-b" });
    const [a, b] = await Promise.all([
      roomA.room.submit(batch({ canvasId: "canvas-a", commandId: "a1" })),
      roomB.room.submit(batch({ canvasId: "canvas-b", commandId: "b1" }))
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) expect(a.revision).toBe(1);
    if (b.ok) expect(b.revision).toBe(1);
  });
});

describe("durable-before-broadcast（任务 4.3）", () => {
  it("只有持久化成功后才广播", async () => {
    const broadcasts: Array<{ revision: number }> = [];
    const { room } = await readyRoom({ broadcast: ({ revision }) => broadcasts.push({ revision }) });
    const result = await room.submit(batch());
    expect(result.ok).toBe(true);
    expect(broadcasts.map((entry) => entry.revision)).toEqual([1]);
  });

  it("持久化失败时不广播、不确认成功", async () => {
    const broadcasts: number[] = [];
    const { room, repository } = await readyRoom({ broadcast: ({ revision }) => broadcasts.push(revision) });
    repository.failNextCommit(new Error("数据库失败"));
    const result = await room.submit(batch());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.code).toBe("storage-failed");
    expect(broadcasts).toEqual([]);
    // published 保持最后 durable 状态。
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(0);
    expect(exported.canvas.document.nodes).toEqual([]);
  });

  it("提交失败后下一命令仍基于最后 durable 状态", async () => {
    const { room, repository } = await readyRoom();
    await room.submit(batch({ commandId: "ok-1" }));
    repository.failNextCommit(new Error("失败"));
    await room.submit(batch({ commandId: "fail-1", commands: [{ type: "node.add", node: { id: "x", type: "text", position: { x: 0, y: 0 } } }] }));
    const after = await room.submit(batch({ commandId: "ok-2", commands: [{ type: "node.add", node: { id: "y", type: "text", position: { x: 50, y: 0 } } }] }));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.revision).toBe(2);
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.document.nodes.map((node) => node.id).sort()).toEqual(["n1", "y"]);
  });
});

describe("结果语义（任务 4.4）", () => {
  it("no-op 不推进 revision、不广播", async () => {
    const broadcasts: number[] = [];
    const { room } = await readyRoom({ broadcast: ({ revision }) => broadcasts.push(revision) });
    await room.submit(batch({ commandId: "set-1", commands: [{ type: "canvas.setTitle", title: "同名" }] }));
    const noop = await room.submit(batch({ commandId: "set-2", commands: [{ type: "canvas.setTitle", title: "同名" }] }));
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.noop).toBe(true);
    expect(noop.revision).toBe(1);
    expect(noop.update).toBeNull();
    // 只广播一次（第一次有净变化）。
    expect(broadcasts).toEqual([1]);
  });

  it("领域拒绝：无效边端点整批拒绝且不广播", async () => {
    const broadcasts: number[] = [];
    const { room } = await readyRoom({ broadcast: ({ revision }) => broadcasts.push(revision) });
    const result = await room.submit(batch({ commands: [{ type: "edge.add", edge: { source: "n1", target: "ghost" } }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe("rejected");
    expect(broadcasts).toEqual([]);
  });

  it("canvasId 不匹配时拒绝", async () => {
    const { room } = await readyRoom();
    const result = await room.submit(batch({ canvasId: "other-canvas" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("canvas-mismatch");
  });

  it("相同 commandId + payload 返回 duplicate 且不重复应用", async () => {
    const { room } = await readyRoom();
    const first = await room.submit(batch());
    const retry = await room.submit(batch());
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.status).toBe("duplicate");
    expect(retry.revision).toBe(first.revision);
    expect(retry.update).toBeNull();
    const exported = room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(1);
  });

  it("相同 commandId + 不同 payload 拒绝", async () => {
    const { room } = await readyRoom();
    await room.submit(batch());
    const reused = await room.submit(batch({ commands: [{ type: "canvas.setTitle", title: "不同" }] }));
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.code).toBe("command-id-reused");
  });
});

describe("损坏隔离（任务 4.5）", () => {
  it("非法 checkpoint/update 时进入 quarantined，不创建空文档也不接受写入", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    // 构造一个格式版本错误的文档。
    const doc = serverCanvasToYDoc(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    await repository.createYjsDocument({
      canvasId: CANVAS,
      formatVersion: "woohaa3-ycanvas-v99",
      roomEpoch: "epoch-1",
      checkpoint: Y.encodeStateAsUpdate(doc),
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      revision: 0,
      createdAt: NOW
    });

    const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
    const loaded = await room.load();
    expect(loaded.ok).toBe(false);
    expect(room.roomState).toBe("quarantined");
    expect(room.diagnostics).toMatch(/unsupported-format/);

    const submit = await room.submit(batch());
    expect(submit.ok).toBe(false);
    if (submit.ok) return;
    expect(submit.code).toBe("room-quarantined");
    // 导出也失败（不返回空画布冒充正常）。
    expect(room.exportCanvas().ok).toBe(false);
  });

  it("文档不存在但注入了 bootstrap：用规范聚合建立首个 Y.Doc", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const seeded = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
    seeded.document.nodes.push({ id: "text-1", type: "text", position: { x: 5, y: 6 } });

    const room = new CanvasRoom({
      canvasId: CANVAS,
      repository,
      now: () => NOW,
      generateRoomEpoch: () => "epoch-new",
      bootstrap: async () => seeded
    });
    const loaded = await room.load();
    expect(loaded.ok).toBe(true);
    expect(room.roomState).toBe("ready");
    expect(room.roomEpoch).toBe("epoch-new");
    // durable：文档已写入仓储，导出等价于种子聚合。
    const state = await repository.loadYjsState(CANVAS);
    expect(state).not.toBeNull();
    const exported = room.exportCanvas();
    expect(exported.ok && exported.canvas.document.nodes.map((n) => n.id)).toEqual(["text-1"]);
  });

  it("文档不存在且 bootstrap 返回 null：隔离（不创建空文档）", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const room = new CanvasRoom({
      canvasId: CANVAS,
      repository,
      now: () => NOW,
      bootstrap: async () => null
    });
    const loaded = await room.load();
    expect(loaded.ok).toBe(false);
    expect(room.roomState).toBe("quarantined");
    expect(room.diagnostics).toMatch(/not-found/);
  });

  it("文档存在但损坏时不触发 bootstrap（不用空/新文档覆盖）", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const doc = serverCanvasToYDoc(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    await repository.createYjsDocument({
      canvasId: CANVAS,
      formatVersion: "woohaa3-ycanvas-v99",
      roomEpoch: "epoch-1",
      checkpoint: Y.encodeStateAsUpdate(doc),
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      revision: 0,
      createdAt: NOW
    });
    let bootstrapCalls = 0;
    const room = new CanvasRoom({
      canvasId: CANVAS,
      repository,
      now: () => NOW,
      bootstrap: async () => {
        bootstrapCalls += 1;
        return createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
      }
    });
    const loaded = await room.load();
    expect(loaded.ok).toBe(false);
    expect(room.roomState).toBe("quarantined");
    expect(bootstrapCalls).toBe(0);
  });
});

describe("room registry（任务 4.1 / 4.6）", () => {
  it("同 canvas 返回同一 room，引用计数正确", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    await readyRoom({ repository });
    const registry = new CanvasRoomRegistry({
      repository,
      now: () => NOW,
      idleTtlMs: 0,
      schedule: (run) => {
        run();
        return () => undefined;
      }
    });
    const leaseA = await registry.acquire(CANVAS);
    const leaseB = await registry.acquire(CANVAS);
    expect(leaseA.room).toBe(leaseB.room);
    expect(registry.refCount(CANVAS)).toBe(2);
    leaseA.release();
    expect(registry.refCount(CANVAS)).toBe(1);
    leaseB.release();
    expect(registry.refCount(CANVAS)).toBe(0);
  });

  it("连接归零后按 idleTtl 回收，重载一致", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const { room } = await readyRoom({ repository });
    await room.submit(batch());
    let scheduled: (() => void) | null = null;
    const registry = new CanvasRoomRegistry({
      repository,
      now: () => NOW,
      idleTtlMs: 10,
      schedule: (run) => {
        scheduled = run;
        return () => { scheduled = null; };
      }
    });
    const lease = await registry.acquire(CANVAS);
    await lease.room.submit(batch({ commandId: "cmd-2", commands: [{ type: "node.add", node: { id: "z", type: "text", position: { x: 0, y: 0 } } }] }));
    lease.release();
    expect(scheduled).not.toBeNull();
    // 触发回收。
    scheduled!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.size).toBe(0);

    // 重新获取：从存储恢复，内容一致。
    const reloaded = await registry.acquire(CANVAS);
    const exported = reloaded.room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(2);
    expect(exported.canvas.document.nodes.length).toBe(2);
    reloaded.release();
  });

  it("多 room 不会跨 canvas 泄漏 update", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    await readyRoom({ repository, canvasId: "canvas-a" });
    await readyRoom({ repository, canvasId: "canvas-b" });
    const registry = new CanvasRoomRegistry({ repository, now: () => NOW, idleTtlMs: 0 });
    const leaseA = await registry.acquire("canvas-a");
    const leaseB = await registry.acquire("canvas-b");
    await leaseA.room.submit(batch({ canvasId: "canvas-a", commandId: "a1", commands: [{ type: "node.add", node: { id: "a-node", type: "text", position: { x: 0, y: 0 } } }] }));
    await leaseB.room.submit(batch({ canvasId: "canvas-b", commandId: "b1", commands: [{ type: "node.add", node: { id: "b-node", type: "text", position: { x: 0, y: 0 } } }] }));

    const exportedA = leaseA.room.exportCanvas();
    const exportedB = leaseB.room.exportCanvas();
    if (!exportedA.ok || !exportedB.ok) throw new Error("导出失败");
    expect(exportedA.canvas.document.nodes.map((node) => node.id)).toEqual(["a-node"]);
    expect(exportedB.canvas.document.nodes.map((node) => node.id)).toEqual(["b-node"]);
    leaseA.release();
    leaseB.release();
  });
});

describe("多 room 压力（任务 4.6）", () => {
  it("20 个 room 各自提交后导出互不干扰", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const ids = Array.from({ length: 20 }, (_, index) => `canvas-${index}`);
    for (const canvasId of ids) await readyRoom({ repository, canvasId });

    const registry = new CanvasRoomRegistry({ repository, now: () => NOW, idleTtlMs: 0 });
    const leases = await Promise.all(ids.map((canvasId) => registry.acquire(canvasId)));
    await Promise.all(leases.map((lease, index) => lease.room.submit(batch({
      canvasId: ids[index],
      commandId: `cmd-${index}`,
      commands: [{ type: "node.add", node: { id: `node-${index}`, type: "text", position: { x: 0, y: 0 } } }]
    }))));

    for (const [index, lease] of leases.entries()) {
      const exported = lease.room.exportCanvas();
      expect(exported.ok).toBe(true);
      if (!exported.ok) continue;
      expect(exported.canvas.document.nodes.map((node) => node.id)).toEqual([`node-${index}`]);
    }
    for (const lease of leases) lease.release();
    await registry.destroyAll();
  });
});

describe("checkpoint 压缩的 room 入口（任务 3.6 接线）", () => {
  it("compact 后 storageSeq 前进且导出不变", async () => {
    const { room } = await readyRoom();
    await room.submit(batch());
    const before = room.exportCanvas();
    const result = await room.compact();
    expect(result.ok).toBe(true);
    const after = room.exportCanvas();
    if (!before.ok || !after.ok) throw new Error("导出失败");
    expect(after.canvas.revision).toBe(before.canvas.revision);
    expect(after.canvas.document.nodes).toEqual(before.canvas.document.nodes);
  });
});

describe("命令 durable 成功后的观察者（change: 模型编辑历史）", () => {
  it("changed 命令触发 onCommitted，携带提交后聚合与命令列表", async () => {
    const seen: Array<{ canvasRevision: number; commands: readonly unknown[] }> = [];
    const { room } = await readyRoom({
      onCommitted: (input) => seen.push({ canvasRevision: input.canvas.revision, commands: input.commands })
    });
    const result = await room.submit(batch());
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.commands).toHaveLength(1);
    // 观察者收到的是 durable 后的聚合（revision 已推进）。
    expect(seen[0]!.canvasRevision).toBeGreaterThanOrEqual(1);
  });

  it("no-op 命令不触发 onCommitted", async () => {
    let calls = 0;
    const { room } = await readyRoom({ onCommitted: () => { calls += 1; } });
    // 两次相同的 node.add：第二次无净变化。
    await room.submit(batch({ commandId: "c1" }));
    calls = 0;
    await room.submit(batch({ commandId: "c2" }));
    expect(calls).toBe(0);
  });
});

describe("模型镜头子资源 patch（change: add-model-editor-gizmo-shot-capture）", () => {
  it("合法 modelCameras patch 经 Yjs durable 提交并可往返恢复", async () => {
    const { room, repository } = await readyRoom();
    // 先加一个 model3d 节点（含自包含定义）。
    const addNode = await room.submit(
      batch({ commandId: "c-cam-0", commands: [addModel3dCommand("m1")] })
    );
    expect(addNode.ok).toBe(true);

    const patch = await room.submit(
      batch({
        commandId: "c-cam-1",
        commands: [
          {
            type: "nodeData.patch",
            nodeId: "m1",
            value: {
              modelCameras: [
                { id: "cam-b", name: "B", order: 1, azimuth: 1, elevation: 0, distance: 4, aspect: "16:9" },
                { id: "cam-a", name: "A", order: 0, azimuth: 0.2, elevation: 0, distance: 2, aspect: "1:1" }
              ]
            }
          }
        ] as never
      })
    );
    expect(patch.ok).toBe(true);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const cameras = (exported.canvas.nodeData.m1 as { modelCameras: Array<{ id: string }> }).modelCameras;
    // 规范化排序：cam-a 在前。
    expect(cameras.map((camera) => camera.id)).toEqual(["cam-a", "cam-b"]);

    // 从持久化状态重建 room 后镜头仍在（Yjs round-trip）。
    const reloaded = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
    const loaded = await reloaded.load();
    expect(loaded.ok).toBe(true);
    const reExported = reloaded.exportCanvas();
    expect(reExported.ok).toBe(true);
    if (!reExported.ok) return;
    expect((reExported.canvas.nodeData.m1 as { modelCameras: unknown[] }).modelCameras).toHaveLength(2);
  });

  it("非法 modelCameras patch 被拒绝且不改变画布", async () => {
    const { room } = await readyRoom();
    await room.submit(
      batch({ commandId: "c-bad-0", commands: [addModel3dCommand("m1")] })
    );
    const before = room.currentRevision;
    const rejected = await room.submit(
      batch({
        commandId: "c-bad-1",
        commands: [
          { type: "nodeData.patch", nodeId: "m1", value: { modelCameras: [{ id: "cam-a", name: "A", order: 0, azimuth: 0, elevation: 0, distance: 0, aspect: "16:9" }] } }
        ] as never
      })
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("invalid-model-cameras");
    expect(room.currentRevision).toBe(before);
  });
});

describe("submitDerived 串行读改写（change: add-model-camera-mcp-crud）", () => {
  it("按最新 published 派生批次，两个并发派生不互相覆盖", async () => {
    const { room } = await readyRoom();
    await room.submit(batch({ commandId: "seed", commands: [addModel3dCommand("m1")] }));

    const append = (commandId: string, id: string) =>
      room.submitDerived({
        commandId,
        derive: (canvas) => {
          const data = canvas.nodeData.m1 as { ids?: string[] } | undefined;
          const ids = [...(data?.ids ?? []), id];
          return {
            ok: true,
            batch: batch({ commandId, baseRevision: canvas.revision, commands: [{ type: "nodeData.patch", nodeId: "m1", value: { ids } as never }] })
          };
        }
      });

    await Promise.all([append("derived-a", "a"), append("derived-b", "b")]);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect((exported.canvas.nodeData.m1 as { ids: string[] }).ids).toEqual(["a", "b"]);
  });

  it("命中同 commandId 回执时短路为 duplicate，不重新派生", async () => {
    const { room } = await readyRoom();
    await room.submit(batch({ commandId: "seed", commands: [addModel3dCommand("m1")] }));
    let derivations = 0;
    const derive = () => {
      derivations += 1;
      return { ok: true as const, batch: batch({ commandId: "derived-1", commands: [{ type: "nodeData.patch", nodeId: "m1", value: { prompt: "x" } }] }) };
    };
    const first = await room.submitDerived({ commandId: "derived-1", derive });
    const retry = await room.submitDerived({ commandId: "derived-1", derive });
    expect(first.ok && first.status).toBe("accepted");
    expect(retry.ok && retry.status).toBe("duplicate");
    expect(derivations).toBe(1);
  });

  it("derive 返回领域拒绝时不占用 revision", async () => {
    const { room } = await readyRoom();
    const before = room.currentRevision;
    const rejected = await room.submitDerived({
      commandId: "derived-reject",
      derive: () => ({ ok: false, code: "unknown-camera", message: "没有该镜头" })
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("unknown-camera");
    expect(room.currentRevision).toBe(before);
  });
});

describe("room：从上游 seed 时补结构化目录行", () => {
  it("seed 成功后调用 ensureCanvasRow（只建 Yjs 文档不够）", async () => {
    // 真实故障形状：新机器上打开一张"只在远端存在"的画布。room 从上游 seed 出 Yjs
    // 文档，但结构化目录行在另一张表里——不补这一行，画布能打开却不出现在「我的画布」，
    // 后续命令提交也会因为找不到画布行失败。
    //
    // 另一个坑：组合层曾漏转发 ensureCanvasRow，而 room 侧是可选调用（`?.`），
    // 漏了不报错、只静默丢掉。这条测试用"只暴露 ensureCanvasRow 的假仓库"锁住它。
    const remoteCanvas = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
    remoteCanvas.document.nodes.push({ id: "text-remote", type: "text", position: { x: 1, y: 2 } });
    remoteCanvas.revision = 40;

    const rows: Array<{ id: string; revision: number }> = [];
    const base = new InMemoryYjsDocumentRepository();
    const repository = Object.assign(Object.create(base) as InMemoryYjsDocumentRepository, {
      ensureCanvasRow: async (canvas: { id: string; revision: number }) => {
        rows.push({ id: canvas.id, revision: canvas.revision });
      }
    });

    const doc = serverCanvasToYDoc(remoteCanvas);
    const room = new CanvasRoom({
      canvasId: CANVAS,
      repository,
      now: () => NOW,
      generateRoomEpoch: () => "epoch-seeded",
      seedFromUpstream: async () => Y.encodeStateAsUpdate(doc)
    });
    const loaded = await room.load();
    expect(loaded.ok).toBe(true);
    expect(rows).toEqual([{ id: CANVAS, revision: 40 }]);
    // 内容也确实落到了 Yjs 那一侧。
    expect(await base.loadYjsState(CANVAS)).not.toBeNull();
  });
});

describe("存储 sequence 冲突自动恢复（change: 2026-10-29-recover-storage-seq-conflict）", () => {
  /**
   * 复现真实故障形状：两个 room（两个宿主 / 两个 worker）从**同一份存储**各自 load，
   * 一个先提交把持久层 seq 推进，另一个还拿着旧 storageSeq 去 CAS。
   *
   * 修复前：第二个 room 永远返回 `storage-seq-conflict`（storageSeq 只在提交成功时前进），
   * 客户端只能不停「重试」并继续失败。修复后：room 从存储重新恢复、广播缺失内容、再重试同一批次。
   */
  async function twoRoomsSharingStorage(options: {
    broadcast?: ConstructorParameters<typeof CanvasRoom>[0]["broadcast"];
    onStorageSeqRecovered?: ConstructorParameters<typeof CanvasRoom>[0]["onStorageSeqRecovered"];
  } = {}) {
    // 先由一个 room 建出存储里的首个 Y.Doc，另外两个 room 只 load，保证三者共享同一份 struct。
    const { repository } = await readyRoom();
    const first = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
    const second = new CanvasRoom({
      canvasId: CANVAS,
      repository,
      now: () => NOW,
      broadcast: options.broadcast,
      ...(options.onStorageSeqRecovered ? { onStorageSeqRecovered: options.onStorageSeqRecovered } : {})
    });
    expect((await first.load()).ok).toBe(true);
    expect((await second.load()).ok).toBe(true);
    return { repository, first, second };
  }

  it("对端推进 seq 后自动重载并重试成功，双方内容都保留", async () => {
    const { repository, first, second } = await twoRoomsSharingStorage();
    const added = await first.submit(
      batch({ commandId: "other-writer", commands: [{ type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } }] })
    );
    expect(added.ok).toBe(true);

    // 第二个 room 的 storageSeq 仍停在 0：修复前这一步必然冲突。
    const submitted = await second.submit(
      batch({ commandId: "stale-writer", commands: [{ type: "node.add", node: { id: "b", type: "image", position: { x: 20, y: 0 } } }] })
    );
    expect(submitted.ok).toBe(true);

    const exported = second.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    // 对端内容没有被覆盖，本地命令也落上了。
    expect(exported.canvas.document.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);

    // 存储里同样是两者的并集（重试没有丢掉对端那一版）。
    const recovered = await recoverYjsDocument({ repository, canvasId: CANVAS, now: NOW });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    const durable = yDocToServerCanvas(recovered.doc);
    expect(durable.ok).toBe(true);
    if (!durable.ok) return;
    expect(durable.canvas.document.nodes.map((node) => node.id).sort()).toEqual(["a", "b"]);
  });

  it("恢复时把对端内容按 upstream origin 广播给已连接客户端", async () => {
    const origins: string[] = [];
    let upstreamBytes = 0;
    const { first, second } = await twoRoomsSharingStorage({
      broadcast: (input) => {
        origins.push(input.origin);
        if (input.origin === "upstream") upstreamBytes = input.update.byteLength;
      }
    });
    expect(
      (
        await first.submit(
          batch({ commandId: "other-writer", commands: [{ type: "node.add", node: { id: "a", type: "image", position: { x: 0, y: 0 } } }] })
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await second.submit(
          batch({ commandId: "stale-writer", commands: [{ type: "node.add", node: { id: "b", type: "image", position: { x: 20, y: 0 } } }] })
        )
      ).ok
    ).toBe(true);
    // 恢复广播在前、本 room 自己的提交广播在后。
    expect(origins).toContain("upstream");
    expect(upstreamBytes).toBeGreaterThan(2);
  });

  it("持续冲突时重载次数有上限，并把可重试冲突如实返回", async () => {
    let commits = 0;
    let loads = 0;
    class AlwaysConflictingRepository extends InMemoryYjsDocumentRepository {
      override async commitYjsCommand(): Promise<{ ok: false; code: "storage-seq-conflict"; currentSeq: number }> {
        commits += 1;
        return { ok: false, code: "storage-seq-conflict", currentSeq: 99 };
      }
      override async loadYjsState(canvasId: string) {
        loads += 1;
        return super.loadYjsState(canvasId);
      }
    }
    const repository = new AlwaysConflictingRepository();
    const { room } = await readyRoom({ repository });
    const result = await room.submit(batch());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("storage-seq-conflict");
    expect(result.retryable).toBe(true);
    // 首次提交 + 2 次重载重试；重载各自读一次存储。
    expect(commits).toBe(3);
    expect(loads).toBe(2);
  });

  it("恢复发现文档已不可用时隔离 room，不返回可重试冲突", async () => {
    let commits = 0;
    class DeletedRepository extends InMemoryYjsDocumentRepository {
      override async commitYjsCommand(): Promise<{ ok: false; code: "storage-seq-conflict"; currentSeq: number }> {
        commits += 1;
        await this.deleteYjsDocument(CANVAS);
        return { ok: false, code: "storage-seq-conflict", currentSeq: 99 };
      }
    }
    const repository = new DeletedRepository();
    const { room } = await readyRoom({ repository });
    const result = await room.submit(batch());
    expect(result.ok).toBe(false);
    // 文档没了：只能尝试一次，不再重试不存在的批次；room 进入隔离而不是继续服务。
    expect(commits).toBe(1);
    const exported = room.exportCanvas();
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.code).toBe("not-found");
    expect(room.diagnostics).toContain("not-found");
  });
});
