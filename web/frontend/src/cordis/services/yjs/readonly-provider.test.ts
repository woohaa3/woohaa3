/**
 * 只读 provider 测试（任务 6.1 / 6.2 / 6.6）。
 *
 * 关键断言：本地 cache transaction 与本地 observer **绝不产生出站 raw update**；
 * 状态机门禁（syncing 前不可写）；命令生命周期（pending → accepted/rejected → committed）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeMessage,
  encodeCommandResultMessage,
  encodeStatusMessage,
  encodeSyncMessage,
  serverCanvasToYDoc } from "@woohaa3/contracts/canvas-yjs";
import { ReadonlyCanvasProvider } from "./readonly-provider.js";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";

const CANVAS = "canvas-provider";

function fakeSocket() {
  const outbound: Array<
    | { kind: "sync"; syncType: number; payload: Uint8Array }
    | { kind: "command"; batch: unknown }
  > = [];
  let messageHandler: ((data: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let openHandler: (() => void) | null = null;
  return {
    socket: {
      send(data: Uint8Array) {
        const decoded = decodeMessage(data);
        if (decoded.type === MESSAGE_TYPE.SYNC) {
          outbound.push({ kind: "sync", syncType: decoded.syncType, payload: decoded.payload });
        } else if (decoded.type === MESSAGE_TYPE.COMMAND) {
          outbound.push({ kind: "command", batch: decoded.batch });
        }
      },
      close() { closeHandler?.(); },
      onMessage(handler: (data: Uint8Array) => void) { messageHandler = handler; return () => { messageHandler = null; }; },
      onClose(handler: () => void) { closeHandler = handler; return () => { closeHandler = null; }; },
      isOpen: () => true,
      onOpen(handler: () => void) { openHandler = handler; return () => { openHandler = null; }; }
    },
    outbound,
    receive(data: Uint8Array) { messageHandler?.(data); },
    disconnect() { closeHandler?.(); },
    /** 模拟共享 transport 重连：重新触发通道 open（不重建 provider）。 */
    reopen() { openHandler?.(); }
  };
}

function commandBatch(overrides: Partial<CanvasCommandBatch> = {}): CanvasCommandBatch {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: "cmd-1",
    baseRevision: 0,
    actorId: "browser",
    commands: [{ type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } }],
    ...overrides
  };
}

/** 服务端文档（用于生成差量）。 */
function serverDoc() {
  return serverCanvasToYDoc(createEmptyWoohaa3ServerCanvas(CANVAS, "2026-09-23T00:00:00.000Z"));
}

describe("连接就绪前不出站（浏览器 WebSocket CONNECTING 回归）", () => {
  it("socket 未打开时延后握手，打开后才发送 step1", () => {
    const sent: Uint8Array[] = [];
    const handlers: Array<() => void> = [];
    let isOpen = false;
    const socket = {
      send: (data: Uint8Array) => sent.push(data),
      close: () => undefined,
      onMessage: () => () => undefined,
      onClose: () => () => undefined,
      isOpen: () => isOpen,
      onOpen: (handler: () => void) => {
        handlers.push(handler);
        return () => undefined;
      }
    };
    const provider = new ReadonlyCanvasProvider({ socket, canvasId: CANVAS, doc: serverDoc() });
    provider.start();
    // 未 open：不发送（浏览器会抛 "Still in CONNECTING state"）。
    expect(sent).toHaveLength(0);
    // 打开后才发送 step1。
    isOpen = true;
    handlers[0]?.();
    expect(sent).toHaveLength(1);
  });

  it("socket 已打开时立即握手", () => {
    const sent: Uint8Array[] = [];
    const socket = {
      send: (data: Uint8Array) => sent.push(data),
      close: () => undefined,
      onMessage: () => () => undefined,
      onClose: () => () => undefined,
      isOpen: () => true,
      onOpen: () => () => undefined
    };
    new ReadonlyCanvasProvider({ socket, canvasId: CANVAS, doc: serverDoc() }).start();
    expect(sent).toHaveLength(1);
  });
});

describe("只读性：本地 transaction 不出站（任务 6.1）", () => {
  it("本地 Y.Doc 修改不产生任何出站 sync update", () => {
    const fake = fakeSocket();
    const doc = serverDoc();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc, canvasId: CANVAS });
    provider.start();
    const outboundAfterStart = fake.outbound.length;

    // 本地修改（模拟 cache 写入 / 本地 observer）。
    doc.transact(() => {
      doc.getMap("nodes").set("local", { id: "local", type: "text", position: { x: 0, y: 0 } });
    });

    // 只有 start 时的 step1，没有新增出站。
    expect(fake.outbound.length).toBe(outboundAfterStart);
    expect(provider.outboundUpdates).toBe(0);
    expect(fake.outbound.every((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.STEP1)).toBe(true);
  });

  it("start 只发送 step1（带 state vector）", () => {
    const fake = fakeSocket();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc: serverDoc(), canvasId: CANVAS });
    provider.start();
    expect(fake.outbound.length).toBe(1);
    const first = fake.outbound[0];
    expect(first.kind).toBe("sync");
    if (first.kind === "sync") expect(first.syncType).toBe(SYNC_MESSAGE_TYPE.STEP1);
  });

  it("服务端 update 被应用进本地文档（收敛），但不回传", () => {
    const fake = fakeSocket();
    const client = new Y.Doc();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc: client, canvasId: CANVAS });
    provider.start();

    const remote = serverDoc();
    remote.getMap("meta").set("revision", 3);
    const update = Y.encodeStateAsUpdate(remote);
    fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, update));

    expect(Y.encodeStateVector(client).byteLength).toBeGreaterThan(0);
    // 应用服务端 update 不产生出站写 update。
    expect(provider.outboundUpdates).toBe(0);
  });

  it("onServerUpdate 只对服务端 published update 回调（任务 5.2）", () => {
    const fake = fakeSocket();
    const updates: Uint8Array[] = [];
    const provider = new ReadonlyCanvasProvider({
      socket: fake.socket,
      doc: new Y.Doc(),
      canvasId: CANVAS,
      onServerUpdate: (update) => updates.push(update)
    });
    provider.start();
    // 本地 transaction 不触发 onServerUpdate。
    provider.doc.transact(() => {
      provider.doc.getMap("nodes").set("local", { id: "local" });
    });
    expect(updates).toHaveLength(0);
    // 服务端 update 触发一次。
    const remote = serverDoc();
    remote.getMap("meta").set("revision", 2);
    fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(remote)));
    expect(updates).toHaveLength(1);
  });

  it("浏览器 outbound Yjs update 始终为零，cache 只记录 server origin（任务 6.4）", () => {
    const fake = fakeSocket();
    const client = new Y.Doc();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc: client, canvasId: CANVAS });
    provider.start();
    // 大量本地事务 + 多条服务端 update 交替。
    for (let i = 0; i < 5; i += 1) {
      client.transact(() => { client.getMap("nodes").set(`local-${i}`, { id: `local-${i}` }); });
      const remote = serverDoc();
      remote.getMap("meta").set("revision", i + 1);
      fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(remote)));
    }
    // 出站只有 step1，绝无写 update（STEP2/UPDATE）。
    expect(provider.outboundUpdates).toBe(0);
    const outboundSyncTypes = fake.outbound
      .filter((entry) => entry.kind === "sync")
      .map((entry) => (entry.kind === "sync" ? entry.syncType : -1));
    expect(outboundSyncTypes.every((syncType) => syncType === SYNC_MESSAGE_TYPE.STEP1)).toBe(true);
  });
});

describe("状态机与写入门禁（任务 6.2）", () => {
  it("syncing 阶段拒绝命令", () => {
    const fake = fakeSocket();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc: serverDoc(), canvasId: CANVAS });
    provider.start();
    expect(provider.providerState.phase).toBe("syncing");
    const result = provider.submitCommand(commandBatch());
    expect(result.ok).toBe(false);
  });

  it("收到 synced status 后进入 ready 并允许命令", () => {
    const fake = fakeSocket();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc: serverDoc(), canvasId: CANVAS });
    provider.start();
    fake.receive(encodeStatusMessage({ status: "synced", revision: 5, roomEpoch: "epoch-1" }));
    expect(provider.providerState.phase).toBe("ready");
    expect(provider.providerState.revision).toBe(5);

    const result = provider.submitCommand(commandBatch());
    expect(result.ok).toBe(true);
    expect(fake.outbound.some((entry) => entry.kind === "command")).toBe(true);
  });

  it("连接断开进入 offline-readonly 并关闭写入门禁", () => {
    const fake = fakeSocket();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc: serverDoc(), canvasId: CANVAS });
    provider.start();
    fake.receive(encodeStatusMessage({ status: "synced", revision: 1 }));
    fake.disconnect();
    expect(provider.providerState.phase).toBe("offline-readonly");
    expect(provider.submitCommand(commandBatch()).ok).toBe(false);
  });

  it("共享 session 重连后自动重新握手并恢复 ready（回归）", () => {
    const fake = fakeSocket();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc: serverDoc(), canvasId: CANVAS });
    provider.start();
    fake.receive(encodeStatusMessage({ status: "synced", revision: 1 }));
    expect(provider.providerState.phase).toBe("ready");

    // 物理断开：provider 进入 offline-readonly。
    fake.disconnect();
    expect(provider.providerState.phase).toBe("offline-readonly");

    // 共享 transport 透明重连（同一个逻辑通道再次 open）：provider 必须重新发 step1。
    const outboundBefore = fake.outbound.length;
    fake.reopen();
    const afterReopen = fake.outbound.slice(outboundBefore);
    expect(afterReopen.some((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.STEP1)).toBe(true);

    // 服务端确认后恢复可写。
    fake.receive(encodeStatusMessage({ status: "synced", revision: 2 }));
    expect(provider.providerState.phase).toBe("ready");
    expect(provider.submitCommand(commandBatch()).ok).toBe(true);
  });

  it("服务端 error status 进入 error 并保留可诊断原因", () => {
    const fake = fakeSocket();
    const provider = new ReadonlyCanvasProvider({ socket: fake.socket, doc: serverDoc(), canvasId: CANVAS });
    provider.start();
    fake.receive(encodeStatusMessage({ status: "error", code: "protocol-version-unsupported", error: "版本不兼容" }));
    expect(provider.providerState.phase).toBe("error");
    expect(provider.providerState.error).toContain("protocol-version-unsupported");
  });

  it("cache 格式不匹配时不进入 loading-cache（丢弃 cache）", () => {
    const fake = fakeSocket();
    const provider = new ReadonlyCanvasProvider({
      socket: fake.socket,
      doc: new Y.Doc(),
      canvasId: CANVAS,
      cacheFormatVersion: "woohaa3-ycanvas-v0"
    });
    expect(provider.providerState.phase).toBe("connecting");
    expect(provider.providerState.phase).not.toBe("loading-cache");
  });

  it("同格式 cache 允许先显示（loading-cache）", () => {
    const fake = fakeSocket();
    const provider = new ReadonlyCanvasProvider({
      socket: fake.socket,
      doc: serverDoc(),
      canvasId: CANVAS,
      cacheFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      cacheRoomEpoch: "epoch-0"
    });
    expect(provider.providerState.phase).toBe("loading-cache");
    // 但 cache 阶段不可写。
    expect(provider.submitCommand(commandBatch()).ok).toBe(false);
  });

  it("服务端 room epoch 改变时先丢弃旧 Y.Doc，再应用全量 update", () => {
    const fake = fakeSocket();
    const cached = serverDoc();
    cached.getMap("nodes").set("stale", { id: "stale", type: "text", position: { x: 0, y: 0 } });
    const discards: Array<{ cached: string | null; server: string | null; epochMismatch: boolean }> = [];
    const provider = new ReadonlyCanvasProvider({
      socket: fake.socket,
      doc: cached,
      canvasId: CANVAS,
      cacheFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      cacheRoomEpoch: "epoch-old",
      onCachedDocumentDiscarded: (input) => discards.push(input)
    });
    provider.start();

    fake.receive(encodeStatusMessage({ status: "syncing", revision: 0, roomEpoch: "epoch-new" }));
    expect(provider.doc).not.toBe(cached);
    expect(provider.doc.getMap("nodes").has("stale")).toBe(false);
    expect(discards).toEqual([{ cached: "epoch-old", server: "epoch-new", epochMismatch: true }]);

    const remote = serverDoc();
    remote.getMap("nodes").set("current", { id: "current", type: "text", position: { x: 1, y: 2 } });
    fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(remote)));
    fake.receive(encodeStatusMessage({ status: "synced", revision: 0, roomEpoch: "epoch-new" }));

    expect(provider.doc.getMap("nodes").has("current")).toBe(true);
    expect(provider.doc.getMap("nodes").has("stale")).toBe(false);
    expect(provider.providerState.phase).toBe("ready");
  });

  it("服务端 room epoch 未改变时也丢弃已加载 cache，避免同 epoch 污染残留", () => {
    const fake = fakeSocket();
    const cached = serverDoc();
    cached.getMap("nodes").set("local-only", { id: "local-only" });
    const discards: Array<{ cached: string | null; server: string | null; epochMismatch: boolean }> = [];
    const provider = new ReadonlyCanvasProvider({
      socket: fake.socket,
      doc: cached,
      canvasId: CANVAS,
      cacheFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      cacheRoomEpoch: "epoch-1",
      onCachedDocumentDiscarded: (input) => discards.push(input)
    });
    provider.start();
    fake.receive(encodeStatusMessage({ status: "syncing", revision: 0, roomEpoch: "epoch-1" }));
    expect(provider.doc).not.toBe(cached);
    expect(provider.doc.getMap("nodes").has("local-only")).toBe(false);
    expect(discards).toEqual([{ cached: "epoch-1", server: "epoch-1", epochMismatch: false }]);
  });
});

describe("命令生命周期（任务 6.6）", () => {
  it("pending → accepted → committed（result 先到）", () => {
    const fake = fakeSocket();
    const results: Array<Record<string, unknown>> = [];
    const provider = new ReadonlyCanvasProvider({
      socket: fake.socket,
      doc: serverDoc(),
      canvasId: CANVAS,
      onCommandResult: (result) => results.push(result as unknown as Record<string, unknown>)
    });
    provider.start();
    fake.receive(encodeStatusMessage({ status: "synced", revision: 0 }));

    provider.submitCommand(commandBatch());
    fake.receive(encodeCommandResultMessage({ commandId: "cmd-1", status: "accepted", revision: 1 }));
    expect(results).toEqual([{ commandId: "cmd-1", status: "accepted", revision: 1 }]);
  });

  it("rejected 结果被回传（宿主据此回滚 pending）", () => {
    const fake = fakeSocket();
    const results: Array<Record<string, unknown>> = [];
    const provider = new ReadonlyCanvasProvider({
      socket: fake.socket,
      doc: serverDoc(),
      canvasId: CANVAS,
      onCommandResult: (result) => results.push(result as unknown as Record<string, unknown>)
    });
    provider.start();
    fake.receive(encodeStatusMessage({ status: "synced", revision: 0 }));
    provider.submitCommand(commandBatch());
    fake.receive(encodeCommandResultMessage({ commandId: "cmd-1", status: "rejected", code: "invalid-edge-endpoint" }));
    expect(results.at(-1)).toMatchObject({ status: "rejected", code: "invalid-edge-endpoint" });
  });

  it("未知 result 与同 ID 重试（update 早于 result 也不影响）", () => {
    const fake = fakeSocket();
    const results: Array<Record<string, unknown>> = [];
    const provider = new ReadonlyCanvasProvider({
      socket: fake.socket,
      doc: serverDoc(),
      canvasId: CANVAS,
      onCommandResult: (result) => results.push(result as unknown as Record<string, unknown>)
    });
    provider.start();
    fake.receive(encodeStatusMessage({ status: "synced", revision: 0 }));

    // 服务端 update 先到（commit 后 broadcast），result 后到。
    const remote = serverDoc();
    remote.getMap("meta").set("revision", 1);
    fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(remote)));
    fake.receive(encodeCommandResultMessage({ commandId: "cmd-1", status: "accepted", revision: 1 }));

    // 重试同一 ID：服务端会回 duplicate。
    provider.submitCommand(commandBatch());
    fake.receive(encodeCommandResultMessage({ commandId: "cmd-1", status: "duplicate", revision: 1 }));
    expect(results.map((entry) => entry.status)).toEqual(["accepted", "duplicate"]);
  });
});
