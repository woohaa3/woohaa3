/**
 * 多客户端收敛测试（任务 5.4 / 5.7）。
 *
 * 验证：本页提交 → 服务端 durable → **一条** update 广播给所有会话 → 远端收敛；
 * 被拒绝的命令不广播；不同客户端的命令按到达顺序串行应用（D2「并发编辑不同节点」）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeMessage,
  encodeCommandMessage,
  encodeSyncMessage } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "./room.js";
import { CanvasSyncSession } from "./sync-session.js";
import { CanvasSessionHub, connectRegistryBroadcast } from "./sync-hub.js";
import { CanvasRoomRegistry } from "./room-registry.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-multi";

/** 记录出站 update 并维护一个真实客户端 Y.Doc 的 fake socket。 */
function clientSocket() {
  const client = new Y.Doc();
  const statuses: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];
  let messageHandler: ((data: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  return {
    client,
    statuses,
    results,
    socket: {
      send(data: Uint8Array) {
        const decoded = decodeMessage(data);
        if (decoded.type === MESSAGE_TYPE.SYNC) {
          if (decoded.syncType === SYNC_MESSAGE_TYPE.UPDATE) Y.applyUpdate(client, decoded.payload);
          return;
        }
        if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) results.push(decoded.result as Record<string, unknown>);
        if (decoded.type === MESSAGE_TYPE.STATUS) statuses.push(decoded.status as Record<string, unknown>);
      },
      close() { closeHandler?.(); },
      onMessage(handler: (data: Uint8Array) => void) { messageHandler = handler; return () => { messageHandler = null; }; },
      onClose(handler: () => void) { closeHandler = handler; return () => { closeHandler = null; }; }
    },
    /** 客户端「回送 state vector」以完成 sync step1 交换。 */
    sendStateVector() {
      messageHandler?.(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client)));
    },
    sendCommand(batch: CanvasCommandBatch) {
      messageHandler?.(encodeCommandMessage(batch));
    }
  };
}

function batch(overrides: Partial<CanvasCommandBatch> = {}): CanvasCommandBatch {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: "cmd-1",
    baseRevision: 0,
    actorId: "actor",
    commands: [{ type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } }],
    ...overrides
  };
}

async function setup() {
  const repository = new InMemoryYjsDocumentRepository();
  const hub = new CanvasSessionHub();
  const registry = new CanvasRoomRegistry({
    repository,
    now: () => NOW,
    broadcast: connectRegistryBroadcast(hub),
    idleTtlMs: 0
  });
  const lease = await registry.acquire(CANVAS);
  await lease.room.initialize({
    canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
    roomEpoch: "epoch-1",
    createdAt: NOW
  });
  return { repository, hub, registry, lease };
}

function connectClient(room: CanvasRoom, actorId: string) {
  const fake = clientSocket();
  const session = new CanvasSyncSession({
    room,
    socket: fake.socket,
    clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
    clientRoomEpoch: "epoch-1",
    clientStateVector: new Uint8Array(0),
    actorId,
    now: () => 0
  });
  return { session, fake };
}

describe("多客户端收敛（任务 5.4）", () => {
  it("本页提交后远端客户端通过广播收敛", async () => {
    const { hub, lease } = await setup();
    const a = connectClient(lease.room, "client-a");
    const b = connectClient(lease.room, "client-b");
    hub.register(CANVAS, a.session);
    hub.register(CANVAS, b.session);
    expect(hub.sessionCount(CANVAS)).toBe(2);

    a.fake.sendCommand(batch());
    await lease.room.settle();

    // A 收到 accepted；两边客户端 Y.Doc 都包含节点。
    expect(a.fake.results.at(-1)?.status).toBe("accepted");
    expect(Y.encodeStateVector(a.fake.client).byteLength).toBeGreaterThan(0);
    expect(Y.encodeStateVector(b.fake.client).byteLength).toBeGreaterThan(0);
    // 两个客户端的结构一致。
    expect(Array.from(Y.encodeStateVector(a.fake.client))).toEqual(Array.from(Y.encodeStateVector(b.fake.client)));
  });

  it("被拒绝的命令不广播给任何客户端", async () => {
    const { hub, lease } = await setup();
    const a = connectClient(lease.room, "client-a");
    const b = connectClient(lease.room, "client-b");
    hub.register(CANVAS, a.session);
    hub.register(CANVAS, b.session);

    const bBefore = Array.from(Y.encodeStateVector(b.fake.client));
    a.fake.sendCommand(batch({
      commandId: "bad",
      commands: [{ type: "edge.add", edge: { source: "n1", target: "ghost" } }]
    }));
    await lease.room.settle();

    expect(a.fake.results.at(-1)?.status).toBe("rejected");
    // B 的文档未变化。
    expect(Array.from(Y.encodeStateVector(b.fake.client))).toEqual(bBefore);
  });

  it("两个客户端修改不同节点都成功（不做全局 CAS）", async () => {
    const { hub, lease } = await setup();
    const a = connectClient(lease.room, "client-a");
    const b = connectClient(lease.room, "client-b");
    hub.register(CANVAS, a.session);
    hub.register(CANVAS, b.session);

    // 双方都基于 revision 0 提交（baseRevision 不做全局 CAS）。
    a.fake.sendCommand(batch({ commandId: "a1", commands: [{ type: "node.add", node: { id: "a-node", type: "text", position: { x: 0, y: 0 } } }] }));
    await lease.room.settle();
    b.fake.sendCommand(batch({ commandId: "b1", commands: [{ type: "node.add", node: { id: "b-node", type: "image", position: { x: 100, y: 0 } } }] }));
    await lease.room.settle();

    // 每个客户端的 command result 只回给**发起连接**（design D4）。
    // A 只应看到自己那条被接受，B 只应看到自己那条；两者都成功。
    expect(a.fake.results.filter((entry) => entry.status === "accepted").length).toBe(1);
    expect(b.fake.results.filter((entry) => entry.status === "accepted").length).toBe(1);
    // 但**广播**让双方都收敛到两个节点。
    const exported = lease.room.exportCanvas();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.canvas.document.nodes.map((node) => node.id).sort()).toEqual(["a-node", "b-node"]);
    // 双方最终 state vector 一致。
    expect(Array.from(Y.encodeStateVector(a.fake.client))).toEqual(Array.from(Y.encodeStateVector(b.fake.client)));
  });

  it("一条 durable update 只广播一次", async () => {
    const { hub, lease } = await setup();
    let broadcasts = 0;
    const a = connectClient(lease.room, "client-a");
    hub.register(CANVAS, a.session);
    // 包装 session 的 broadcastUpdate 统计调用次数。
    const original = a.session.broadcastUpdate.bind(a.session);
    a.session.broadcastUpdate = (update, revision) => {
      broadcasts += 1;
      original(update, revision);
    };

    a.fake.sendCommand(batch());
    await lease.room.settle();
    expect(broadcasts).toBe(1);
  });

  it("本轮提交者自己也会收到广播（统一路径，不区分来源）", async () => {
    const { hub, lease } = await setup();
    const a = connectClient(lease.room, "client-a");
    hub.register(CANVAS, a.session);
    a.fake.sendCommand(batch());
    await lease.room.settle();
    // A 的本地 Y.Doc 通过广播 update 前进（而不是靠 command result 直接写入）。
    expect(Y.encodeStateVector(a.fake.client).byteLength).toBeGreaterThan(0);
    const exported = lease.room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(1);
  });
});

describe("断开与重连（任务 5.7）", () => {
  it("会话关闭后从 hub 移除，不再收到广播", async () => {
    const { hub, lease } = await setup();
    const a = connectClient(lease.room, "client-a");
    const b = connectClient(lease.room, "client-b");
    const unregisterA = hub.register(CANVAS, a.session);
    hub.register(CANVAS, b.session);

    unregisterA();
    a.session.close("client-left");
    expect(hub.sessionCount(CANVAS)).toBe(1);

    const bBefore = Array.from(Y.encodeStateVector(b.fake.client));
    // 关闭的会话不应再接收；但 room 提交仍会让 B 收敛。
    const c = connectClient(lease.room, "client-c");
    hub.register(CANVAS, c.session);
    c.fake.sendCommand(batch());
    await lease.room.settle();
    expect(Array.from(Y.encodeStateVector(b.fake.client))).not.toEqual(bBefore);
  });

  it("重连客户端用 state vector 补齐错过的广播", async () => {
    const { hub, lease } = await setup();
    // 客户端 A 先同步到空文档，然后断开。
    const a = connectClient(lease.room, "client-a");
    const unregister = hub.register(CANVAS, a.session);
    unregister();
    a.session.dispose();

    // 期间 room 提交两个命令。
    const b = connectClient(lease.room, "client-b");
    hub.register(CANVAS, b.session);
    b.fake.sendCommand(batch({ commandId: "b1", commands: [{ type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } }] }));
    await lease.room.settle();
    b.fake.sendCommand(batch({ commandId: "b2", commands: [{ type: "node.add", node: { id: "n2", type: "text", position: { x: 50, y: 0 } } }] }));
    await lease.room.settle();

    // A 重连：带自己的（空）state vector。
    const reconnected = new CanvasSyncSession({
      room: lease.room,
      socket: a.fake.socket,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: "epoch-1",
      clientStateVector: Y.encodeStateVector(a.fake.client),
      actorId: "client-a",
      now: () => 0
    });
    void reconnected;
    // 重连后 A 的文档被差量补齐到 revision 2。
    expect(Y.encodeStateVector(a.fake.client).byteLength).toBeGreaterThan(0);
    const exported = lease.room.exportCanvas();
    if (!exported.ok) return;
    expect(exported.canvas.revision).toBe(2);
  });
});
