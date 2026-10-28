/**
 * 画布会话的 room-epoch 缓存自愈测试
 * （修复：本地 Yjs cache 与服务端分叉导致 canonical revision 冻结、pending 永不清除）。
 *
 * 场景：本地 IndexedDB 缓存属于**旧 room epoch**（服务端曾重建 Y.Doc）。若不处理：
 * - 客户端把旧缓存 apply 进本地 doc → 带着服务端没有的结构发起 sync step1；
 * - 服务端只按该 state vector 补差量，**不会删除**本地多余结构 → 本地 canonical 永久
 *   与服务端不一致，revision 冻结，pending 批次永远清不掉（UI 卡「等待确认」）。
 *
 * 期望：服务端在任何 update 前声明 room epoch；不一致时客户端先换成空 Y.Doc，
 * 再应用服务端全量内容（等价于手动删 IndexedDB 的自动版，不需要二次连接）。
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeMessage,
  encodeStatusMessage,
  encodeSyncMessage,
  serverCanvasToYDoc,
  yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import type { SyncSocket } from "@woohaa3/contracts/canvas-yjs";
import { CanvasDatabase, IndexedDbYjsCacheRepository } from "./canvas-state/index.js";
import { createCanvasSession, HOST_RECONNECTING_SUBMIT_CODE } from "./canvas-session.js";
import type { CanvasRemoteService } from "../contracts.js";

const CANVAS = "canvas-epoch";
const OLD_EPOCH = "epoch-old";
const NEW_EPOCH = "epoch-new";
const NOW = "2026-09-29T00:00:00.000Z";

/** 收集出站 state vector / 记录连接时携带的 room epoch。 */
function fakeSocket(epochsSeen: Array<string | null>) {
  let messageHandler: ((data: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  const sentStateVectors: Uint8Array[] = [];
  const socket: SyncSocket & { receive: (data: Uint8Array) => void; disconnect: () => void } = {
    send(data) {
      const decoded = decodeMessage(data);
      if (decoded.type === MESSAGE_TYPE.SYNC && decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
        sentStateVectors.push(decoded.payload);
      }
    },
    close() {
      closeHandler?.();
    },
    onMessage(handler) {
      messageHandler = handler;
      return () => {
        messageHandler = null;
      };
    },
    onClose(handler) {
      closeHandler = handler;
      return () => {
        closeHandler = null;
      };
    },
    receive: (data: Uint8Array) => messageHandler?.(data),
    disconnect: () => closeHandler?.()
  };
  void epochsSeen;
  return { socket, sentStateVectors };
}

async function writeCacheWithEpoch(factory: IDBFactory, epoch: string): Promise<void> {
  const db = new CanvasDatabase({ indexedDb: factory });
  const repository = new IndexedDbYjsCacheRepository({ indexedDb: factory, open: () => db.open() });
  // 写一条与服务端**不同**的内容，模拟分叉的旧缓存。
  const staleDoc = serverCanvasToYDoc(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
  staleDoc.getMap("__showcase_stale").set("leftover", "server-does-not-have-this");
  const update = Y.encodeStateAsUpdate(staleDoc);
  await repository.appendUpdate({ canvasId: CANVAS, seq: 1, update, createdAt: NOW });
  await repository.saveMetadata({
    canvasId: CANVAS,
    formatVersion: YJS_CANVAS_FORMAT_VERSION, protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    roomEpoch: epoch,
    revision: 1,
    updatedAt: NOW
  });
  await db.close();
}

describe("收到权威握手时自动丢弃缓存并全量重同步", () => {
  it("旧 epoch 缓存：在首条 update 前清空缓存、换空 doc，并以服务端内容自愈", async () => {
    const factory = new IDBFactory();
    // session 以 `globalThis.indexedDB` 判断是否启用缓存，这里注入测试用 factory。
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    await writeCacheWithEpoch(factory, OLD_EPOCH);

    // 服务端文档（权威内容）与旧缓存不同：一个真实节点。
    const serverCanvas = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
    serverCanvas.document.nodes.push({
      id: "server-node",
      type: "text",
      position: { x: 10, y: 20 },
      width: 200,
      height: 100,
      zIndex: 1
    });
    serverCanvas.revision = 7;
    const serverDoc = serverCanvasToYDoc(serverCanvas);

    const connects: Array<string | null> = [];
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const remote: CanvasRemoteService = {
      openCanvasSession: (_canvasId: string, roomEpoch: string | null) => {
        const entry = fakeSocket(connects);
        connects.push(roomEpoch);
        sockets.push(entry);
        return entry.socket;
      },
      closeCanvasSession: () => undefined,
      reconnectCanvasSession: () => undefined
    } as unknown as CanvasRemoteService;

    let provider: Awaited<ReturnType<typeof createCanvasSession>> | undefined;
    try {
      provider = await createCanvasSession({ canvasId: CANVAS, remote, database: new CanvasDatabase({ indexedDb: factory }) });
      // 第一次连接携带旧 epoch。
      expect(connects).toEqual([OLD_EPOCH]);

      // 服务端先声明权威 epoch；前端此时必须换空 doc，随后才接收全量 diff。
      const first = sockets[0]!;
      first.socket.receive(
        encodeStatusMessage({ status: "syncing", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: NEW_EPOCH, revision: 7 })
      );
      first.socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(serverDoc)));
      first.socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(serverDoc)));
      first.socket.receive(
        encodeStatusMessage({ status: "synced", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: NEW_EPOCH, revision: 7 })
      );

      // epoch 不一致不再事后重连；服务端 STEP1 得到的是替换后的空 doc state vector。
      expect(sockets).toHaveLength(1);
      const emptyVector = Y.encodeStateVector(new Y.Doc());
      expect(Array.from(first.sentStateVectors.at(-1)!)).toEqual(Array.from(emptyVector));

      // 旧 epoch 的缓存不再被沿用：元数据已换成服务端的 new epoch（旧结构被丢弃）。
      const repository = new IndexedDbYjsCacheRepository({
        indexedDb: factory,
        open: () => new CanvasDatabase({ indexedDb: factory }).open()
      });
      await expect.poll(async () => (await repository.load(CANVAS))?.metadata.roomEpoch).toBe(NEW_EPOCH);
      const afterResync = await repository.load(CANVAS);
      expect(afterResync?.metadata.roomEpoch).toBe(NEW_EPOCH);
      const canonical = (globalThis as { __canvasCanonical?: { revision: number; document: { nodes: Array<{ id: string }> } } })
        .__canvasCanonical;
      expect(canonical?.revision).toBe(7);
      expect(canonical?.document.nodes.map((node) => node.id)).toContain("server-node");
    } finally {
      provider?.shutdown();
      delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });

  it("epoch 一致时也重建本地文档并清掉同 epoch 污染", async () => {
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    await writeCacheWithEpoch(factory, OLD_EPOCH);

    const serverDoc = serverCanvasToYDoc(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    const connects: Array<string | null> = [];
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const remote: CanvasRemoteService = {
      openCanvasSession: (_canvasId: string, roomEpoch: string | null) => {
        const entry = fakeSocket(connects);
        connects.push(roomEpoch);
        sockets.push(entry);
        return entry.socket;
      },
      closeCanvasSession: () => undefined,
      reconnectCanvasSession: () => undefined
    } as unknown as CanvasRemoteService;

    const session = await createCanvasSession({ canvasId: CANVAS, remote, database: new CanvasDatabase({ indexedDb: factory }) });
    try {
      expect(connects).toEqual([OLD_EPOCH]);
      sockets[0]!.socket.receive(
        encodeStatusMessage({ status: "syncing", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: OLD_EPOCH, revision: 1 })
      );
      sockets[0]!.socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(serverDoc)));
      // 服务端回报**同一个** epoch：仍不重连，但本地 doc/cache 已先重建。
      sockets[0]!.socket.receive(
        encodeStatusMessage({ status: "synced", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: OLD_EPOCH, revision: 1 })
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sockets.length).toBe(1);
      expect(session.isWritable()).toBe(true);
      // 同 epoch 也重建本地 doc：旧缓存里的分叉结构必须被清掉（等价于手动删 IndexedDB）。
      const repository = new IndexedDbYjsCacheRepository({
        indexedDb: factory,
        open: () => new CanvasDatabase({ indexedDb: factory }).open()
      });
      const reloaded = await repository.load(CANVAS);
      // 缓存确实被重建过（不是空断言）：至少有一条服务端 update，且不含旧分叉结构。
      expect(reloaded?.updates.length ?? 0).toBeGreaterThan(0);
      const rebuilt = new Y.Doc();
      for (const entry of reloaded?.updates ?? []) Y.applyUpdate(rebuilt, entry.update);
      expect(rebuilt.getMap("__showcase_stale").get("leftover")).toBeUndefined();
    } finally {
      session.shutdown();
      delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });
});

describe("显式重连（change: 2026-10-21-recover-canvas-connection-explicitly）", () => {
  const RECONNECT_CANVAS = "canvas-reconnect";

  const syncingMessage = () =>
    encodeStatusMessage({ status: "syncing", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: "epoch-1", revision: 1 });
  const syncedMessage = () =>
    encodeStatusMessage({ status: "synced", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: "epoch-1", revision: 1 });

  /** 建一个已同步的会话；返回 fake remote 的调用计数与首个 fake socket。 */
  async function createReadySession(options: { reconnectTimeoutMs?: number } = {}) {
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const calls = { open: 0, reconnects: 0, closes: 0 };
    const remote = {
      openCanvasSession: () => {
        calls.open += 1;
        const entry = fakeSocket([]);
        sockets.push(entry);
        return entry.socket;
      },
      closeCanvasSession: () => {
        calls.closes += 1;
      },
      reconnectCanvasSession: () => {
        calls.reconnects += 1;
      }
    } as unknown as CanvasRemoteService;
    const session = await createCanvasSession({
      canvasId: RECONNECT_CANVAS,
      remote,
      database: new CanvasDatabase({ indexedDb: new IDBFactory() }),
      ...(options.reconnectTimeoutMs !== undefined ? { reconnectTimeoutMs: options.reconnectTimeoutMs } : {})
    });
    const socket = sockets[0]!.socket;
    socket.receive(syncingMessage());
    socket.receive(syncedMessage());
    expect(session.getStatus().remote.mode).toBe("remote");
    return { session, socket, sockets, calls };
  }

  it("断线后 reconnect() 置灰并重建连接，恢复后清除置灰", async () => {
    const { session, socket, calls } = await createReadySession();
    try {
      // 物理断开：只读，且来源是「这条会话连接被关闭」而不是整机断网。
      socket.disconnect();
      expect(session.getStatus().remote).toMatchObject({
        mode: "offline",
        phase: "offline",
        offlineReason: "session-closed"
      });
      expect(session.isWritable()).toBe(false);

      const pending = session.reconnect();
      // 显式重连：清掉旧错误、置灰标记，并立即请求 transport 重建（不等退避）。
      expect(session.getStatus().remote.reconnecting).toBe(true);
      expect(session.getStatus().error).toBeNull();
      expect(calls.reconnects).toBe(1);
      expect(calls.open).toBe(1);

      socket.receive(syncedMessage());
      await pending;
      expect(session.getStatus().remote).toMatchObject({
        mode: "remote",
        reconnecting: false,
        offlineReason: null
      });
      expect(session.isWritable()).toBe(true);
    } finally {
      session.shutdown();
    }
  });

  it("reconnect() 幂等：并发调用共享同一次重建", async () => {
    const { session, socket, calls } = await createReadySession();
    try {
      socket.disconnect();
      const first = session.reconnect();
      const second = session.reconnect();
      expect(second).toBe(first);
      expect(calls.reconnects).toBe(1);

      socket.receive(syncedMessage());
      await Promise.all([first, second]);
      expect(session.getStatus().remote.reconnecting).toBe(false);
      expect(session.getStatus().remote.mode).toBe("remote");
    } finally {
      session.shutdown();
    }
  });

  it("超时只清置灰并保留只读，不谎称已连接", async () => {
    const { session, socket, calls } = await createReadySession({ reconnectTimeoutMs: 20 });
    try {
      socket.disconnect();
      await session.reconnect();
      expect(calls.reconnects).toBe(1);
      expect(session.getStatus().remote.reconnecting).toBe(false);
      expect(session.getStatus().remote.mode).toBe("offline");
      expect(session.getStatus().error).toContain("重新连接超时");
      expect(session.isWritable()).toBe(false);
    } finally {
      session.shutdown();
    }
  });

  it("浏览器断网发布 offlineReason=browser-offline（与会话关闭区分）", async () => {
    const { session, socket } = await createReadySession();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
    try {
      socket.receive(syncedMessage());
      expect(session.getStatus().remote).toMatchObject({
        mode: "offline",
        offlineReason: "browser-offline"
      });
      expect(session.isWritable()).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
      else delete (globalThis as { navigator?: unknown }).navigator;
      session.shutdown();
    }
  });

  it("没有 provider 时回落为一次完整 attach（不重开画布、不打回启动态）", async () => {
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const calls = { reconnects: 0 };
    let failAttach = false;
    const remote = {
      openCanvasSession: () => {
        if (failAttach) throw new Error("连接失败");
        const entry = fakeSocket([]);
        sockets.push(entry);
        return entry.socket;
      },
      closeCanvasSession: () => undefined,
      reconnectCanvasSession: () => {
        calls.reconnects += 1;
      }
    } as unknown as CanvasRemoteService;
    const session = await createCanvasSession({
      canvasId: RECONNECT_CANVAS,
      remote,
      database: new CanvasDatabase({ indexedDb: new IDBFactory() })
    });
    try {
      // retry 会打回启动态；本次 attach 失败后 provider 已被 detach 清空。
      failAttach = true;
      await expect(session.retry()).rejects.toThrow();
      expect(session.getStatus().phase).toBe("loading");
      failAttach = false;

      const pending = session.reconnect();
      // 回落为完整 attach：走 openCanvasSession 而不是 transport 重建。
      expect(calls.reconnects).toBe(0);
      expect(sockets).toHaveLength(2);
      sockets[1]!.socket.receive(syncedMessage());
      await pending;
      expect(session.getStatus().phase).toBe("ready");
      expect(session.isWritable()).toBe(true);
      expect(session.getStatus().remote.reconnecting).toBe(false);
    } finally {
      session.shutdown();
    }
  });
});

describe("内容权限只读（进画布即判定，不等第一次写入被拒）", () => {
  it("canWrite=false：isWritable=false、提交被本地拒绝、状态带只读原因", async () => {
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const remote = {
      openCanvasSession: () => {
        const entry = fakeSocket([]);
        sockets.push(entry);
        return entry.socket;
      },
      closeCanvasSession: () => undefined,
      reconnectCanvasSession: () => undefined
    } as unknown as CanvasRemoteService;

    const session = await createCanvasSession({
      canvasId: CANVAS,
      remote,
      database: new CanvasDatabase({ indexedDb: factory }),
      access: { canRead: true, canWrite: false }
    });
    try {
      sockets[0]!.socket.receive(
        encodeStatusMessage({ status: "synced", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: "epoch-1", revision: 1 })
      );
      expect(session.getStatus().phase).toBe("ready");
      // 链路是正常的，但权限说不可写：写入门禁必须已经是关的。
      expect(session.getStatus().remote.mode).toBe("remote");
      expect(session.getStatus().remote.readOnly).toBe(true);
      expect(session.getStatus().remote.readOnlyReason).toContain("只读权限");
      expect(session.isWritable()).toBe(false);
      const rejected = session.submitCommands([], "cmd-1");
      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false && rejected.code).toBe("read-only");
    } finally {
      session.shutdown();
      delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });

  it("没有权限答案（null）：不判只读，行为与之前一致", async () => {
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const remote = {
      openCanvasSession: () => {
        const entry = fakeSocket([]);
        sockets.push(entry);
        return entry.socket;
      },
      closeCanvasSession: () => undefined,
      reconnectCanvasSession: () => undefined
    } as unknown as CanvasRemoteService;

    const session = await createCanvasSession({
      canvasId: CANVAS,
      remote,
      database: new CanvasDatabase({ indexedDb: factory }),
      access: null
    });
    try {
      sockets[0]!.socket.receive(
        encodeStatusMessage({ status: "synced", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: "epoch-1", revision: 1 })
      );
      expect(session.getStatus().remote.readOnly).toBe(false);
      expect(session.isWritable()).toBe(true);
    } finally {
      session.shutdown();
      delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });
});

describe("规范投影复用（change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 8.1）", () => {
  const REUSE_CANVAS = "canvas-projection-reuse";
  const syncing = () => encodeStatusMessage({
    status: "syncing",
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    roomEpoch: "epoch-1",
    revision: 4
  });
  const synced = () => encodeStatusMessage({
    status: "synced",
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    roomEpoch: "epoch-1",
    revision: 4
  });

  it("同一 doc/epoch/revision 的重复状态通知复用同一规范投影对象", async () => {
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const remote = {
      openCanvasSession: () => {
        const entry = fakeSocket([]);
        sockets.push(entry);
        return entry.socket;
      },
      closeCanvasSession: () => undefined,
      reconnectCanvasSession: () => undefined
    } as unknown as CanvasRemoteService;

    const session = await createCanvasSession({
      canvasId: REUSE_CANVAS,
      remote,
      database: new CanvasDatabase({ indexedDb: factory })
    });
    try {
      const canvas = createEmptyWoohaa3ServerCanvas(REUSE_CANVAS, NOW);
      canvas.document.nodes.push({ id: "n1", type: "text", position: { x: 1, y: 2 }, width: 10, height: 10, zIndex: 1 });
      canvas.revision = 4;
      const serverDoc = serverCanvasToYDoc(canvas);
      sockets[0]!.socket.receive(syncing());
      sockets[0]!.socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(serverDoc)));
      sockets[0]!.socket.receive(synced());
      const first = (globalThis as { __canvasCanonical?: unknown }).__canvasCanonical;
      expect(first).toBeTruthy();

      // 与内容无关的状态通知（revision 未变、无新 update）：复用同一已验证投影。
      for (let i = 0; i < 20; i += 1) sockets[0]!.socket.receive(synced());
      expect((globalThis as { __canvasCanonical?: unknown }).__canvasCanonical).toBe(first);
      expect(session.getStatus().remote.confirmedRevision).toBe(4);
      expect(session.getStatus().phase).toBe("ready");

      // revision 前进：同一 doc 谱系上继续写入（新客户端 id 的并发写会按 Yjs 冲突规则落败）。
      serverDoc.getMap("meta").set("revision", 5);
      sockets[0]!.socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(serverDoc)));
      sockets[0]!.socket.receive(
        encodeStatusMessage({
          status: "synced",
          protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
          roomEpoch: "epoch-1",
          revision: 5
        })
      );
      const after = (globalThis as { __canvasCanonical?: { revision: number } }).__canvasCanonical;
      expect(after?.revision).toBe(5);
      expect(after).not.toBe(first);
    } finally {
      session.shutdown();
      delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });
});

describe("yDocToServerCanvas 参考（确保测试断言用的是权威派生）", () => {
  it("服务端 doc 派生 revision 与节点", () => {
    const canvas = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
    canvas.revision = 7;
    const exported = yDocToServerCanvas(serverCanvasToYDoc(canvas));
    expect(exported.ok && exported.canvas.revision).toBe(7);
  });
});

describe("确认回流只发布一次规范/working 快照", () => {
  async function fixture() {
    const entry = fakeSocket([]);
    const events: import("@woohaa3/contracts").TelemetryEventInput[] = [];
    const remote = {
      openCanvasSession: () => entry.socket,
      closeCanvasSession: () => undefined,
      reconnectCanvasSession: () => undefined
    } as unknown as CanvasRemoteService;
    const session = await createCanvasSession({ canvasId: CANVAS, remote,
      database: new CanvasDatabase({ indexedDb: new IDBFactory() }),
      telemetry: { record: (event: import("@woohaa3/contracts").TelemetryEventInput) => events.push(event) } as unknown as import("./telemetry-primitives.js").TelemetryClient });
    const canvas = createEmptyWoohaa3ServerCanvas(CANVAS, NOW);
    canvas.document.nodes.push({ id: "n1", type: "image", position: { x: 0, y: 0 } });
    const doc = serverCanvasToYDoc(canvas);
    const synced = (revision: number) => entry.socket.receive(encodeStatusMessage({ status: "synced", revision }));
    entry.socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(doc)));
    synced(0);
    return { session, socket: entry.socket, doc, synced, events };
  }

  it("重复 synced 和提交不重新导出规范画布；新文档事务才替换快照", async () => {
    const { session, doc, synced, socket } = await fixture();
    const store = (await import("./canvas-state/index.js")).woohaa3CanvasStore;
    try {
      const original = store.getState().canvas;
      let publications = 0;
      const unsubscribe = store.subscribe(() => publications++);
      try {
        synced(0); synced(0);
        expect(store.getState().canvas).toBe(original);
        expect(publications).toBe(0);
        const first = session.submitCommands([{ type: "node.update", nodeId: "n1", position: { x: 10, y: 0 } }], "move-first");
        const second = session.submitCommands([{ type: "node.update", nodeId: "n1", position: { x: 20, y: 0 } }], "move-second");
        expect(first.ok && second.ok).toBe(true);
        expect(store.getState().canvas).toBe(original);
        const before = Y.encodeStateVector(doc);
        doc.transact(() => {
          doc.getMap("nodes").set("n1", { id: "n1", type: "image", position: { x: 10, y: 0 } });
          doc.getMap("meta").set("revision", 1);
        });
        socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(doc, before)));
        publications = 0;
        const seen: number[] = [];
        const stop = store.subscribe(state => seen.push(state.working!.document.nodes[0]!.position.x));
        synced(1);
        stop();
        // The second local edit must not briefly roll back to the first edit.
        expect(seen).toEqual([20]);
        expect(publications).toBe(1);
        expect(store.getState().canvas).not.toBe(original);
        synced(1);
        expect(publications).toBe(1);
      } finally { unsubscribe(); }
    } finally { session.shutdown(); }
  });

  it.each(["result-first", "update-first"])("canvas.save waits for durable result and canonical coverage: %s", async order => {
    const { session, doc, synced, socket, events } = await fixture();
    const { encodeJsonMessage } = await import("@woohaa3/contracts/canvas-yjs");
    let clock = 10;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const submitted = session.submitCommands([{ type: "node.update", nodeId: "n1", position: { x: 10, y: 0 } }], "move-save");
      expect(submitted.ok).toBe(true);
      const before = Y.encodeStateVector(doc);
      doc.transact(() => {
        doc.getMap("nodes").set("n1", { id: "n1", type: "image", position: { x: 10, y: 0 } });
        doc.getMap("meta").set("revision", 1);
      });
      const result = () => socket.receive(encodeJsonMessage(MESSAGE_TYPE.COMMAND_RESULT, { commandId: "move-save", status: "accepted", revision: 1 }));
      const update = () => {
        socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(doc, before)));
        synced(1);
      };
      const saves = () => events.filter(event => event.name === "canvas.save");
      clock = 410;
      (order === "result-first" ? result : update)();
      expect(saves()).toHaveLength(0);
      clock = 610;
      (order === "result-first" ? update : result)();
      expect(saves()).toEqual([expect.objectContaining({ result: "success", surface: "sync", durationMs: 600 })]);
      // 每条画布动作都必须带同一组 canvas / session 属性：管理端的会话与画布聚合
      // 完全依赖它们，漏一个动作就会让时间线缺一步。
      expect(saves()[0]?.attributes).toMatchObject({
        canvas: CANVAS,
        session: expect.stringMatching(/^[0-9a-f]{32}$/)
      });
      expect(session.getStatus().remote.pendingCount).toBe(0);
      if (submitted.ok) expect((await submitted.handle.settled).state).toBe("committed");
      synced(1); result();
      expect(saves()).toHaveLength(1);
    } finally { now.mockRestore(); session.shutdown(); }
  });
});
describe("宿主重连门禁（change: 2026-10-21-harden-extension-fault-isolation，D6）", () => {
  it("重连中提交返回可重试的 host-reconnecting：不发送、不登记 pending；恢复后正常提交", async () => {
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    const serverDoc = serverCanvasToYDoc(createEmptyWoohaa3ServerCanvas(CANVAS, NOW));
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const sent: Uint8Array[] = [];
    const remote: CanvasRemoteService = {
      openCanvasSession: () => {
        const entry = fakeSocket([]);
        const original = entry.socket.send.bind(entry.socket);
        entry.socket.send = (data: Uint8Array) => {
          sent.push(data);
          original(data);
        };
        sockets.push(entry);
        return entry.socket;
      },
      closeCanvasSession: () => undefined
    } as unknown as CanvasRemoteService;
    let blocked = true;
    const session = await createCanvasSession({
      canvasId: CANVAS,
      remote,
      database: new CanvasDatabase({ indexedDb: factory }),
      blocksSubmissions: () => blocked
    });
    try {
      sockets[0]!.socket.receive(
        encodeStatusMessage({ status: "syncing", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: OLD_EPOCH, revision: 1 })
      );
      sockets[0]!.socket.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(serverDoc)));
      sockets[0]!.socket.receive(
        encodeStatusMessage({ status: "synced", protocolVersion: YJS_SYNC_PROTOCOL_VERSION, roomEpoch: OLD_EPOCH, revision: 1 })
      );
      await expect.poll(() => session.isWritable()).toBe(true);
      const command = { type: "node.add", node: { id: "n-1", type: "text", position: { x: 0, y: 0 } } } as never;
      const before = sent.length;
      const rejected = session.submitCommands([command], "cmd-blocked");
      expect(rejected).toEqual({ ok: false, reason: "本机服务正在重新连接，请稍后重试", code: HOST_RECONNECTING_SUBMIT_CODE });
      expect(sent.length).toBe(before);
      expect(session.getStatus().remote.pendingCount).toBe(0);
      blocked = false;
      const accepted = session.submitCommands([command], "cmd-after");
      expect(accepted.ok).toBe(true);
      expect(sent.length).toBeGreaterThan(before);
    } finally {
      session.shutdown();
      delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });
});
