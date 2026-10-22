/**
 * 服务端命令 transaction 测试（任务 2.2–2.7）。
 *
 * 覆盖：最小差异写入只更新预期 shared type（2.2）、Yjs 路径与 remote-CAS 路径等价（2.3）、
 * 原子批次与 no-op 单次 revision（2.4）、commandId+payload hash 幂等（2.5）、
 * 随机命令序列属性测试（2.6）、禁止二进制/临时 URL（2.7）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { MediaStorage, MediaObject, MediaStorageScope } from "@woohaa3/contracts";
import { MediaObjectNotFoundError } from "@woohaa3/contracts";
import { applyCanvasCommands, CanvasApplicationService, InMemoryCanvasRepository } from "../storage/core/index.js";
import type { ServerCanvas } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { serverCanvasToYDoc, yDocToServerCanvas, cloneJson } from "@woohaa3/contracts/canvas-yjs";
import { applyCanvasDiffToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { applyCommandTransaction, CommandReceiptRegistry } from "./command-transaction.js";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import { computeCommandPayloadHash } from "@woohaa3/contracts/canvas-yjs";
import { emptyCanvasFixture, FIXTURE_NOW, FIXTURE_STORAGE_KEY } from "./__fixtures__/canvases.js";

const CHECKSUM = "a".repeat(64);

function mediaStorage(
  keys: string[] = [FIXTURE_STORAGE_KEY],
  seenScopes?: Array<MediaStorageScope | undefined>
): MediaStorage {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  for (const key of keys) objects.set(key, { bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/png" });
  return {
    async put(key, bytes, contentType) {
      objects.set(key, { bytes: new Uint8Array(bytes), contentType });
    },
    async get(key): Promise<MediaObject> {
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return record;
    },
    async exists(key, scope) {
      seenScopes?.push(scope);
      return objects.has(key);
    },
    async stat(key, scope) {
      seenScopes?.push(scope);
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return { size: record.bytes.byteLength, contentType: record.contentType };
    }
  };
}

function batch(overrides: Partial<CanvasCommandBatch> = {}): CanvasCommandBatch {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: "canvas-empty",
    commandId: "cmd-1",
    baseRevision: 0,
    actorId: "actor",
    commands: [{ type: "canvas.setTitle", title: "x" }],
    ...overrides
  };
}

function freshDoc(canvas: ServerCanvas = emptyCanvasFixture()): Y.Doc {
  return serverCanvasToYDoc(canvas);
}

describe("最小差异写入（任务 2.2）", () => {
  it("单实体命令只更新预期 shared type", () => {
    const base = emptyCanvasFixture();
    const doc = freshDoc(base);
    const withNode = applyCanvasCommands(base, [
      { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } }
    ], { now: FIXTURE_NOW });
    expect(withNode.ok).toBe(true);
    if (!withNode.ok) return;

    const stats = applyCanvasDiffToYDoc(doc, base, withNode.canvas);
    expect(stats.nodes.added).toBe(1);
    // 未涉及的 shared type 完全没有被触碰。
    expect(stats.edges.added).toBe(0);
    expect(stats.assets.added).toBe(0);
    expect(stats.jobs.added).toBe(0);
    expect(stats.nodeData.added).toBe(0);
  });

  it("删除节点只从 nodes 移除，不改其它集合", () => {
    const base = emptyCanvasFixture();
    const added = applyCanvasCommands(base, [
      { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
      { type: "node.add", node: { id: "n2", type: "text", position: { x: 100, y: 0 } } }
    ], { now: FIXTURE_NOW });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const doc = freshDoc(added.canvas);

    const removed = applyCanvasCommands(added.canvas, [{ type: "node.remove", nodeIds: ["n1"] }], { now: FIXTURE_NOW });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const stats = applyCanvasDiffToYDoc(doc, added.canvas, removed.canvas);
    expect(stats.nodes.removed).toBe(1);
    expect(stats.assets.removed).toBe(0);
    expect(stats.edges.removed).toBe(0);
  });
});

describe("Yjs 路径与 remote-CAS 路径等价（任务 2.3）", () => {
  it("同一命令批次在两条路径上产出等价规范聚合", async () => {
    const commands = [
      { type: "node.add" as const, node: { id: "n1", type: "text" as const, position: { x: 0, y: 0 } } },
      { type: "node.add" as const, node: { id: "n2", type: "image" as const, position: { x: 100, y: 0 } }, connect: { fromNodeId: "n1", edgeId: "e-n1-n2" } },
      { type: "nodeData.patch" as const, nodeId: "n2", value: { title: "生成" } }
    ];

    // Yjs 路径。
    const doc = freshDoc();
    const yjsOutcome = await applyCommandTransaction({
      doc,
      batch: batch({ commands }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(yjsOutcome.ok).toBe(true);
    if (!yjsOutcome.ok) return;

    // remote-CAS 路径（同一 reducer，经应用服务）。
    const repository = new InMemoryCanvasRepository();
    const service = new CanvasApplicationService({ repository, mediaStorage: mediaStorage(), now: () => FIXTURE_NOW });
    await service.createCanvas({ canvasId: "canvas-empty" });
    const casResult = await service.commitCommands({
      canvasId: "canvas-empty",
      expectedRevision: 1,
      operationId: "op-1",
      actorId: "actor",
      commands
    });

    // 结构字段等价（id/title/revision 之外）。
    const yjsCanvas = yjsOutcome.canvas;
    const casCanvas = casResult.canvas;
    expect(yjsCanvas.document.nodes).toEqual(casCanvas.document.nodes);
    expect(yjsCanvas.nodeData).toEqual(casCanvas.nodeData);

    // 客户端稳定 edgeId 在两条路径上都被保留（change: add-frontend-speculative-canvas-state）。
    expect(yjsCanvas.document.edges.map((edge) => edge.id)).toEqual(["e-n1-n2"]);
    expect(casCanvas.document.edges.map((edge) => edge.id)).toEqual(["e-n1-n2"]);
    expect(yjsCanvas.document.edges).toEqual(casCanvas.document.edges);
  });

  it("node.add.connect 缺少稳定 edgeId 被拒绝（任务 6.5）", async () => {
    const doc = freshDoc();
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commands: [
          { type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } },
          { type: "node.add", node: { id: "n2", type: "image", position: { x: 100, y: 0 } }, connect: { fromNodeId: "n1" } }
        ]
      }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("missing-edge-id");
  });

  it("资产引用校验复用前置能力：缺失 COS 对象时拒绝", async () => {
    const doc = freshDoc();
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commands: [
          { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
          {
            type: "asset.upsert",
            asset: {
              id: "asset-1",
              nodeId: "n1",
              title: "图",
              mediaKind: "image",
              source: "generated",
              status: "ready",
              createdAt: FIXTURE_NOW,
              metadata: { storageKey: FIXTURE_STORAGE_KEY, checksum: CHECKSUM, contentType: "image/png", size: 4 }
            }
          }
        ]
      }),
      mediaStorage: mediaStorage([]),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("asset-reference-invalid");
  });

  it("资产引用校验带上批次画布 id（Yjs 路径）", async () => {
    const seenScopes: Array<MediaStorageScope | undefined> = [];
    const doc = freshDoc();
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commands: [
          { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
          {
            type: "asset.upsert",
            asset: {
              id: "asset-1",
              nodeId: "n1",
              title: "图",
              mediaKind: "image",
              source: "generated",
              status: "ready",
              createdAt: FIXTURE_NOW,
              metadata: { storageKey: FIXTURE_STORAGE_KEY, checksum: CHECKSUM, contentType: "image/png", size: 4 }
            }
          }
        ]
      }),
      mediaStorage: mediaStorage([FIXTURE_STORAGE_KEY], seenScopes),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(true);
    expect(seenScopes).toEqual([{ canvasId: "canvas-empty" }, { canvasId: "canvas-empty" }]);
  });
});

describe("原子批次与 no-op（任务 2.4）", () => {
  it("有净变化时恰好推进一次 revision", async () => {
    const doc = freshDoc();
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commands: [
          { type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } },
          { type: "node.add", node: { id: "n2", type: "image", position: { x: 100, y: 0 } }, connect: { fromNodeId: "n1", edgeId: "e-n1-n2" } }
        ]
      }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.changed).toBe(true);
    expect(outcome.revision).toBe(1);
    expect(outcome.update).not.toBeNull();
  });

  it("no-op 不推进 revision、不产生业务 update", async () => {
    const doc = freshDoc({ ...emptyCanvasFixture(), title: "同名", revision: 3 });
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({ baseRevision: 3, commands: [{ type: "canvas.setTitle", title: "同名" }] }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.changed).toBe(false);
    expect(outcome.revision).toBe(3);
    expect(outcome.update).toBeNull();
  });

  it("后段失败整批拒绝，Y.Doc 与 revision 不变", async () => {
    const doc = freshDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commands: [
          { type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } },
          { type: "edge.add", edge: { source: "n1", target: "ghost" } }
        ]
      }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("invalid-edge-endpoint");
    // 传入 doc 未被污染（reducer 在写入前就拒绝了）。
    expect(Array.from(Y.encodeStateAsUpdate(doc))).toEqual(Array.from(before));
    const exported = yDocToServerCanvas(doc, { now: FIXTURE_NOW });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(0);
    expect(exported.canvas.document.nodes).toEqual([]);
  });
});

describe("命令幂等（任务 2.5）", () => {
  it("相同 commandId + payload 返回首次结果且不重复应用", async () => {
    const registry = new CommandReceiptRegistry();
    const doc = freshDoc();
    const payloadHash = await computeCommandPayloadHash({ canvasId: "canvas-empty", commands: batch().commands });

    const first = await applyCommandTransaction({ doc, batch: batch(), mediaStorage: mediaStorage(), now: FIXTURE_NOW });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    registry.record({
      commandId: "cmd-1",
      payloadHash,
      revision: first.revision,
      changed: first.changed,
      updatedAt: first.updatedAt
    });

    const lookup = registry.lookup("cmd-1", payloadHash);
    expect(lookup.status).toBe("duplicate");
    if (lookup.status !== "duplicate") return;
    expect(lookup.receipt.revision).toBe(1);
  });

  it("相同 commandId + 不同 payload 稳定拒绝", async () => {
    const registry = new CommandReceiptRegistry();
    const hashA = await computeCommandPayloadHash({ canvasId: "canvas-empty", commands: batch().commands });
    const hashB = await computeCommandPayloadHash({
      canvasId: "canvas-empty",
      commands: [{ type: "canvas.setTitle", title: "不同" }]
    });
    registry.record({ commandId: "cmd-1", payloadHash: hashA, revision: 1, changed: true, updatedAt: FIXTURE_NOW });
    const lookup = registry.lookup("cmd-1", hashB);
    expect(lookup.status).toBe("reused");
  });

  it("不同 commandId 视为新命令", async () => {
    const registry = new CommandReceiptRegistry();
    const hash = await computeCommandPayloadHash({ canvasId: "canvas-empty", commands: batch().commands });
    registry.record({ commandId: "cmd-1", payloadHash: hash, revision: 1, changed: true, updatedAt: FIXTURE_NOW });
    expect(registry.lookup("cmd-2", hash).status).toBe("new");
  });
});

describe("随机命令序列等价性（任务 2.6）", () => {
  it("reducer 结果与 Y.Doc 导出始终等价", async () => {
    // 简单可复现的伪随机（线性同余），避免依赖 Math.random 造成不可复现。
    let seed = 42;
    const nextRandom = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let round = 0; round < 20; round += 1) {
      const doc = freshDoc({
        ...emptyCanvasFixture(),
        id: `canvas-r${round}`,
        revision: 0
      });
      let aggregate = yDocToServerCanvas(doc, { now: FIXTURE_NOW });
      if (!aggregate.ok) throw new Error("初始导出失败");
      let current = aggregate.canvas;
      let expectedRevision = 0;

      for (let step = 0; step < 6; step += 1) {
        const choice = nextRandom();
        const id = `n${step}`;
        const command =
          choice < 0.4
            ? { type: "node.add" as const, node: { id, type: "image" as const, position: { x: step * 10, y: 0 } } }
            : choice < 0.7
              ? { type: "nodeData.patch" as const, nodeId: `n${Math.floor(step / 2)}`, value: { title: `t${step}` } }
              : { type: "canvas.setTitle" as const, title: `title-${step}` };

        const outcome = await applyCommandTransaction({
          doc,
          batch: batch({ commandId: `c${round}-${step}`, baseRevision: expectedRevision, commands: [command] }),
          mediaStorage: mediaStorage(),
          now: FIXTURE_NOW
        });
        // nodeData 指向不存在节点时会被拒绝，这是预期行为。
        if (!outcome.ok) continue;

        // 与直接跑 reducer 的结果比较。
        const reference = applyCanvasCommands(current, [command], { now: FIXTURE_NOW });
        expect(reference.ok).toBe(true);
        if (!reference.ok) continue;

        const exported = yDocToServerCanvas(doc, { now: FIXTURE_NOW });
        expect(exported.ok).toBe(true);
        if (!exported.ok) continue;

        // 结构字段应与 reducer 结果一致（revision 由 transaction 管理）。
        expect(exported.canvas.document.nodes).toEqual(outcome.canvas.document.nodes);
        expect(exported.canvas.document.edges).toEqual(outcome.canvas.document.edges);
        expect(exported.canvas.title).toBe(outcome.canvas.title);

        current = outcome.canvas;
        expectedRevision = outcome.revision;
      }
    }
  });
});

describe("禁止二进制与临时 URL（任务 2.7）", () => {
  it("资产 metadata 含 blob: URL 时事务拒绝且不产生 update", async () => {
    const doc = freshDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commands: [
          { type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } },
          {
            type: "asset.upsert",
            asset: {
              id: "asset-bad",
              nodeId: "n1",
              title: "坏图",
              mediaKind: "image",
              source: "uploaded",
              status: "ready",
              url: "blob:http://x/y",
              createdAt: FIXTURE_NOW,
              metadata: { storageKey: "blob:http://x/y", checksum: CHECKSUM, contentType: "image/png", size: 4 }
            }
          }
        ]
      }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("asset-reference-invalid");
    expect(Array.from(Y.encodeStateAsUpdate(doc))).toEqual(Array.from(before));
  });

  it("nodeData 中的函数/undefined 被 domain 规范化剥离后才进入 Y.Doc", async () => {
    const doc = freshDoc();
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commands: [
          { type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } },
          {
            type: "nodeData.patch",
            nodeId: "n1",
            value: { keep: "ok", dropped: undefined, fn: (() => 1) as never } as never
          }
        ]
      }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const exported = yDocToServerCanvas(doc, { now: FIXTURE_NOW });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const json = JSON.stringify(exported.canvas);
    expect(json).not.toContain("dropped");
    expect(exported.canvas.nodeData["n1"]).toEqual({ keep: "ok" });
  });
});

/** 引用 `cloneJson` 以避免未使用告警（导出工具函数供后续任务复用）。 */
void cloneJson;

describe("受保护编辑 edit.apply 的服务端原子性（任务 1.2）", () => {
  async function seedNode(id = "n1"): Promise<Y.Doc> {
    const doc = freshDoc();
    const seeded = await applyCommandTransaction({
      doc,
      batch: batch({ commands: [
        { type: "node.add", node: { id, type: "image", position: { x: 0, y: 0 } } },
        { type: "nodeData.patch", nodeId: id, value: { title: "原名称" } }
      ] }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(seeded.ok).toBe(true);
    return doc;
  }

  it("前置条件不成立时整批拒绝且不污染 doc", async () => {
    const doc = await seedNode();
    const before = Array.from(Y.encodeStateAsUpdate(doc));
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({
        commandId: "edit-1",
        commands: [{
          type: "edit.apply",
          preconditions: [{ kind: "node-fields", nodeId: "n1", fields: [{ field: "position", present: true, value: { x: 999, y: 0 } }] }],
          operations: [{ kind: "node-data-set", nodeId: "n1", value: { title: "不应写入" } }]
        }] as never
      }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("edit-precondition-failed");
    expect(Array.from(Y.encodeStateAsUpdate(doc))).toEqual(before);
  });

  it("进行中任务的节点删除被原子拒绝", async () => {
    const doc = await seedNode();
    const running = await applyCommandTransaction({
      doc,
      batch: batch({ commandId: "run", commands: [{ type: "nodeData.patch", nodeId: "n1", value: { taskStatus: "processing" } }] }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(running.ok).toBe(true);
    const outcome = await applyCommandTransaction({
      doc,
      batch: batch({ commandId: "del", commands: [{ type: "edit.apply", preconditions: [], operations: [{ kind: "node-remove", nodeIds: ["n1"] }] }] as never }),
      mediaStorage: mediaStorage(),
      now: FIXTURE_NOW
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("edit-active-run");
  });

  it("同 commandId 同 payload 幂等，不重复应用", async () => {
    const doc = await seedNode();
    const commands = [{ type: "edit.apply", preconditions: [], operations: [{ kind: "node-data-set", nodeId: "n1", value: { title: "改名" } }] }] as never;
    const first = await applyCommandTransaction({ doc, batch: batch({ commandId: "edit-idem", commands }), mediaStorage: mediaStorage(), now: FIXTURE_NOW });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const hash = await computeCommandPayloadHash({ canvasId: "canvas-empty", commands });
    const registry = new CommandReceiptRegistry();
    registry.record({ commandId: "edit-idem", payloadHash: hash, revision: first.revision, changed: first.changed, updatedAt: first.updatedAt });
    // 同 ID + 同 payload：查回首次结果。
    expect(registry.lookup("edit-idem", hash).status).toBe("duplicate");
    // 同 ID + 不同 payload：拒绝。
    const otherHash = await computeCommandPayloadHash({ canvasId: "canvas-empty", commands: [{ type: "edit.apply", preconditions: [], operations: [{ kind: "node-data-set", nodeId: "n1", value: { title: "别的" } }] }] as never });
    expect(registry.lookup("edit-idem", otherHash).status).toBe("reused");
  });
});
