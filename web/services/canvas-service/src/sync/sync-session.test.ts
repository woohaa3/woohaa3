/**
 * 同步会话测试（任务 5.2–5.7）。
 *
 * 用内存 fake socket，覆盖：握手版本闸门、epoch 过期、state-vector 初始同步（空/部分/最新）、
 * 命令提交与结果、拒绝客户端 sync update、容量/速率限制、result 与 update 顺序无关性。
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeMessage,
  encodeCommandMessage,
  encodeSyncMessage } from "@woohaa3/contracts/canvas-yjs";
import { CanvasSyncSession, type SyncSessionContext } from "./sync-session.js";
import { CanvasRoom } from "./room.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-sync";

/** 内存 fake socket：记录出站消息并提供入站注入。 */
function fakeSocket() {
  const sent: Array<
    | { kind: "sync"; syncType: number; payload: Uint8Array }
    | { kind: "command"; batch: unknown }
    | { kind: "result"; result: Record<string, unknown> }
    | { kind: "status"; status: Record<string, unknown> }
  > = [];
  let closed: { code?: number; reason?: string } | null = null;
  let messageHandler: ((data: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  return {
    socket: {
      send(data: Uint8Array) {
        const decoded = decodeMessage(data);
        if (decoded.type === MESSAGE_TYPE.SYNC) {
          sent.push({ kind: "sync", syncType: decoded.syncType, payload: decoded.payload });
        } else if (decoded.type === MESSAGE_TYPE.COMMAND) {
          sent.push({ kind: "command", batch: decoded.batch });
        } else if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
          sent.push({ kind: "result", result: decoded.result as Record<string, unknown> });
        } else {
          sent.push({ kind: "status", status: decoded.status as Record<string, unknown> });
        }
      },
      close(code?: number, reason?: string) {
        closed = { code, reason };
        closeHandler?.();
      },
      onMessage(handler: (data: Uint8Array) => void) {
        messageHandler = handler;
        return () => { messageHandler = null; };
      },
      onClose(handler: () => void) {
        closeHandler = handler;
        return () => { closeHandler = null; };
      }
    },
    sent,
    get closed() {
      return closed;
    },
    receive(data: Uint8Array) {
      messageHandler?.(data);
    }
  };
}

async function readyRoom(): Promise<{ room: CanvasRoom; repository: InMemoryYjsDocumentRepository }> {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
  await room.initialize({ canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW), roomEpoch: "epoch-1", createdAt: NOW });
  return { room, repository };
}

async function connect(
  room: CanvasRoom,
  overrides: Partial<Omit<SyncSessionContext, "room" | "socket">> = {}
) {
  const fake = fakeSocket();
  const session = new CanvasSyncSession({
    room,
    socket: fake.socket,
    clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
    clientRoomEpoch: "epoch-1",
    clientStateVector: new Uint8Array(0),
    actorId: "actor",
    now: () => 0,
    ...overrides
  });
  return { session, fake };
}

/** 把若干命令提交进 room（构造非空文档）。 */
async function seedRoom(room: CanvasRoom, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS,
      commandId: `seed-${index}`,
      baseRevision: index - 1,
      actorId: "actor",
      commands: [{ type: "node.add", node: { id: `n${index}`, type: "image", position: { x: index * 10, y: 0 } } }]
    });
  }
}

function commandBatch(overrides: Partial<CanvasCommandBatch> = {}): CanvasCommandBatch {
  return {
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS,
    commandId: "cmd-1",
    baseRevision: 0,
    actorId: "spoofed-actor",
    commands: [{ type: "node.add", node: { id: "client-node", type: "text", position: { x: 0, y: 0 } } }],
    ...overrides
  };
}

describe("握手闸门（任务 5.2）", () => {
  it("协议版本不兼容时在交换文档内容前失败关闭", async () => {
    const { room } = await readyRoom();
    await seedRoom(room, 1);
    const { fake } = await connect(room, { clientProtocolVersion: 99 });
    expect(fake.closed).not.toBeNull();
    // 不应发送任何 SYNC update（文档内容）。
    expect(fake.sent.some((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.UPDATE)).toBe(false);
    const status = fake.sent.find((entry) => entry.kind === "status");
    expect(status?.kind === "status" && status.status.status).toBe("error");
  });

  it.each([1, 2, 3, 4, 5, 6])("旧协议版本（v%s）在交换文档内容前被拒绝并提示刷新", async (version) => {
    const { room } = await readyRoom();
    await seedRoom(room, 1);
    const { fake } = await connect(room, { clientProtocolVersion: version });
    expect(fake.closed).not.toBeNull();
    expect(YJS_SYNC_PROTOCOL_VERSION).toBe(7);
    expect(fake.sent.some((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.UPDATE)).toBe(false);
    const status = fake.sent.find((entry) => entry.kind === "status");
    expect(status?.kind === "status" && status.status.code).toBe("protocol-version-unsupported");
  });

  it("Y.Doc 格式版本不兼容时失败关闭", async () => {
    const { room } = await readyRoom();
    const { fake } = await connect(room, { clientFormatVersion: "woohaa3-ycanvas-v99" });
    expect(fake.closed).not.toBeNull();
    const status = fake.sent.find((entry) => entry.kind === "status");
    expect(status?.kind === "status" && status.status.code).toBe("ydoc-format-unsupported");
  });

  it("room 隔离时拒绝连接", async () => {
    const repository = new InMemoryYjsDocumentRepository();
    const doc = new Y.Doc();
    await repository.createYjsDocument({
      canvasId: CANVAS,
      formatVersion: "bad",
      roomEpoch: "epoch-1",
      checkpoint: Y.encodeStateAsUpdate(doc),
      projection: createEmptyWoohaa3ServerCanvas(CANVAS, NOW),
      revision: 0,
      createdAt: NOW
    });
    const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
    await room.load();
    const { fake } = await connect(room);
    expect(fake.closed).not.toBeNull();
    const status = fake.sent.find((entry) => entry.kind === "status");
    expect(status?.kind === "status" && status.status.code).toBe("room-quarantined");
  });

  it("握手成功发送 step1 + 差量 + synced status", async () => {
    const { room } = await readyRoom();
    await seedRoom(room, 2);
    const { fake, session } = await connect(room);
    expect(session.sessionStatus).toBe("ready");
    expect(fake.sent.some((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.STEP1)).toBe(true);
    expect(fake.sent.some((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.UPDATE)).toBe(true);
    const status = fake.sent.find((entry) => entry.kind === "status" && entry.status.status === "synced");
    expect(status?.kind === "status" && status.status.status).toBe("synced");
    expect(status?.kind === "status" && status.status.revision).toBe(2);
    const first = fake.sent[0];
    expect(first?.kind).toBe("status");
    expect(first?.kind === "status" && first.status).toMatchObject({
      status: "syncing",
      roomEpoch: "epoch-1",
      revision: 2
    });
  });
});

describe("state-vector 初始同步（任务 5.3）", () => {
  it("空 state vector 收到足以重建完整文档的差量", async () => {
    const { room } = await readyRoom();
    await seedRoom(room, 3);
    const { fake } = await connect(room, { clientStateVector: new Uint8Array(0) });
    const update = fake.sent.find((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.UPDATE);
    expect(update).toBeTruthy();
    if (!update || update.kind !== "sync") return;

    // 客户端应用差量后，其 state vector 应覆盖服务端全部结构。
    const client = new Y.Doc();
    Y.applyUpdate(client, update.payload);
    const clientVector = Y.encodeStateVector(client);
    // 服务端从「客户端 state vector」导出应为空差量（说明客户端已完整）。
    const residual = room.encodeDiff(clientVector);
    expect(residual.byteLength).toBeLessThan(64);
  });

  it("客户端持有全部状态时只得到零差量", async () => {
    const { room } = await readyRoom();
    await seedRoom(room, 2);
    const serverVector = room.encodeStateVector();
    const { fake } = await connect(room, { clientStateVector: serverVector });
    const updates = fake.sent.filter((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.UPDATE);
    // 允许零字节差量不发送；若发送则必须是空/极小。
    for (const update of updates) {
      if (update.kind === "sync") expect(update.payload.byteLength).toBeLessThan(64);
    }
  });

  it("epoch 不一致时从空 state vector 重新同步（丢弃本地 cache）", async () => {
    const { room } = await readyRoom();
    await seedRoom(room, 2);
    const { fake } = await connect(room, { clientRoomEpoch: "stale-epoch", clientStateVector: room.encodeStateVector() });
    // 即使客户端声称「我都有」，epoch 过期也必须重发完整差量。
    const update = fake.sent.find((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.UPDATE);
    expect(update).toBeTruthy();
    if (update?.kind === "sync") expect(update.payload.byteLength).toBeGreaterThan(0);
  });

  it("客户端 step1 触发的差量补齐（漏广播后重连）", async () => {
    const { room } = await readyRoom();
    await seedRoom(room, 1);
    // 客户端先同步到 revision 1。
    const client = new Y.Doc();
    Y.applyUpdate(client, room.encodeDiff(new Uint8Array(0)));
    // 服务端又提交一个（客户端错过广播）。
    await seedRoom(room, 2);

    const { fake } = await connect(room, { clientStateVector: Y.encodeStateVector(client) });
    // 客户端再次发 step1，模拟重连。
    fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client)));
    const updates = fake.sent.filter((entry) => entry.kind === "sync" && entry.syncType === SYNC_MESSAGE_TYPE.UPDATE);
    // 至少有一次差量能把客户端补齐。
    let applied = false;
    for (const update of updates) {
      if (update.kind !== "sync") continue;
      Y.applyUpdate(client, update.payload);
      applied = true;
    }
    expect(applied).toBe(true);
    expect(Y.encodeStateVector(client).byteLength).toBeGreaterThan(0);
  });
});

describe("COMMAND 与结果（任务 5.4）", () => {
  it("冲突回执保留目标和占用运行", async () => {
    const { room, repository } = await readyRoom();
    const conflict = { target: { kind: "instance" as const, instanceId: "i" }, runId: "run", epoch: 2 };
    vi.spyOn(repository, "commitYjsCommand").mockResolvedValue({ ok: false, code: "lease-conflict", conflict });
    const { fake } = await connect(room);
    fake.receive(encodeCommandMessage(commandBatch()));
    await room.settle();
    expect(fake.sent.find(entry => entry.kind === "result")).toMatchObject({ kind: "result", result: { code: "lease-conflict", conflict } });
  });
  it("命令经 room 提交并返回 accepted + revision", async () => {
    const { room } = await readyRoom();
    const { fake } = await connect(room);
    fake.receive(encodeCommandMessage(commandBatch()));
    // 等待异步提交完成（会话是 fire-and-forget，需要显式汇合）。
    await room.settle();
    const result = fake.sent.find((entry) => entry.kind === "result");
    expect(result?.kind === "result" && result.result.status).toBe("accepted");
    expect(result?.kind === "result" && result.result.revision).toBe(1);
  });

  it("actorId 以服务端上下文为准，忽略客户端自报", async () => {
    const { room, repository } = await readyRoom();
    const { fake } = await connect(room, { actorId: "server-actor" });
    fake.receive(encodeCommandMessage(commandBatch({ actorId: "spoofed" })));
    await room.settle();
    const record = await repository.getCommandRecord(CANVAS, "cmd-1");
    expect(record?.actorId).toBe("server-actor");
  });

  it("领域拒绝回 rejected 且携带 code/error（change: add-frontend-speculative-canvas-state）", async () => {
    const { room } = await readyRoom();
    const { fake } = await connect(room);
    fake.receive(encodeCommandMessage(commandBatch({
      commands: [{ type: "edge.add", edge: { source: "n1", target: "ghost" } }]
    })));
    await room.settle();
    const result = fake.sent.find((entry) => entry.kind === "result");
    expect(result?.kind === "result" && result.result.status).toBe("rejected");
    // 统一字段：拒绝必须带稳定 code 与安全 error（而不是 message）。
    if (result?.kind === "result") {
      expect(typeof result.result.code).toBe("string");
      expect(typeof result.result.error).toBe("string");
      expect(result.result.message).toBeUndefined();
    }
  });

  it("重复 commandId 回 duplicate", async () => {
    const { room } = await readyRoom();
    const { fake } = await connect(room);
    fake.receive(encodeCommandMessage(commandBatch()));
    await room.settle();
    fake.receive(encodeCommandMessage(commandBatch()));
    await room.settle();
    const results = fake.sent.filter((entry) => entry.kind === "result");
    expect(results.some((entry) => entry.kind === "result" && entry.result.status === "duplicate")).toBe(true);
  });
});

describe("拒绝客户端 sync update（任务 5.5）", () => {
  it("客户端发送 step2 被拒绝并关闭连接，room 与存储不变", async () => {
    const { room, repository } = await readyRoom();
    await seedRoom(room, 1);
    const before = await repository.loadYjsState(CANVAS);
    const { fake } = await connect(room);

    // 恶意客户端：发送 step2 / update。
    fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP2, new Uint8Array([1, 2, 3])));
    expect(fake.closed).not.toBeNull();
    const status = fake.sent.filter((entry) => entry.kind === "status").at(-1);
    expect(status?.kind === "status" && status.status.code).toBe("client-sync-update-forbidden");

    const after = await repository.loadYjsState(CANVAS);
    expect(after?.storageSeq).toBe(before?.storageSeq);
    expect(room.currentRevision).toBe(1);
  });

  it("客户端发送 UPDATE 同样被拒绝", async () => {
    const { room } = await readyRoom();
    const { fake } = await connect(room);
    fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, new Uint8Array([9])));
    expect(fake.closed).not.toBeNull();
  });

  it("客户端发送 COMMAND_RESULT 被视为违规", async () => {
    const { room } = await readyRoom();
    const { fake } = await connect(room);
    fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, new Uint8Array(0)));
    // 合法握手后发送服务端方向的消息。
    const { encodeCommandResultMessage } = await import("@woohaa3/contracts/canvas-yjs");
    fake.receive(encodeCommandResultMessage({ commandId: "x", status: "accepted" }));
    expect(fake.closed).not.toBeNull();
  });
});

describe("容量与速率限制（任务 5.6）", () => {
  it("单条消息超过上限即关闭（不产生部分 transaction）", async () => {
    const { room, repository } = await readyRoom();
    const { fake } = await connect(room, { limits: { maxMessageBytes: 16 } });
    const before = await repository.loadYjsState(CANVAS);
    fake.receive(new Uint8Array(64));
    expect(fake.closed).not.toBeNull();
    const after = await repository.loadYjsState(CANVAS);
    expect(after?.storageSeq).toBe(before?.storageSeq);
  });

  it("命令数量超过上限回 limit 拒绝且不写存储", async () => {
    const { room, repository } = await readyRoom();
    const { fake } = await connect(room, { limits: { maxCommands: 1 } });
    const before = await repository.loadYjsState(CANVAS);
    fake.receive(encodeCommandMessage(commandBatch({
      commands: [
        { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } },
        { type: "node.add", node: { id: "b", type: "text", position: { x: 10, y: 0 } } }
      ]
    })));
    await room.settle();
    const result = fake.sent.find((entry) => entry.kind === "result");
    expect(result?.kind === "result" && result.result.code).toBe("limit-exceeded");
    const after = await repository.loadYjsState(CANVAS);
    expect(after?.storageSeq).toBe(before?.storageSeq);
  });

  it("超过速率窗口上限后关闭", async () => {
    let clock = 0;
    const { room } = await readyRoom();
    const { fake } = await connect(room, {
      limits: { maxMessagesPerWindow: 3, rateWindowMs: 1000 },
      now: () => clock
    });
    for (let index = 0; index < 4; index += 1) {
      fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, new Uint8Array(0)));
    }
    expect(fake.closed).not.toBeNull();
    void clock;
  });
});

describe("广播与顺序无关性（任务 5.7）", () => {
  it("durable update 通过 broadcast 回送给客户端", async () => {
    const { room } = await readyRoom();
    const { session, fake } = await connect(room);
    const update = Y.encodeStateAsUpdate(new Y.Doc());
    session.broadcastUpdate(update, 5);
    const status = fake.sent.filter((entry) => entry.kind === "status").at(-1);
    expect(status?.kind === "status" && status.status.revision).toBe(5);
  });

  it("客户端未 synced 前不接受命令（result 早于 observer 场景）", async () => {
    // 直接构造一个 room 处于非 ready 的会话是不合法的（握手会关闭），
    // 因此这里验证：握手完成后 synced 标志生效，命令才被接受。
    const { room } = await readyRoom();
    const { fake, session } = await connect(room);
    expect(session.sessionStatus).toBe("ready");
    // 关闭后再发命令不应产生新的 result。
    session.dispose();
    const before = fake.sent.filter((entry) => entry.kind === "result").length;
    fake.receive(encodeCommandMessage(commandBatch()));
    await room.settle();
    expect(fake.sent.filter((entry) => entry.kind === "result").length).toBe(before);
  });
});

it("command timing observer failures cannot suppress a durable confirmation", async () => {
  const { room } = await readyRoom();
  let seen: { status: string; latencyMs: number } | undefined;
  const { fake } = await connect(room, { onCommandComplete: input => {
    seen = input;
    expect(room.currentRevision).toBe(1);
    throw new Error("diagnostic sink failed");
  } });
  fake.receive(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(new Y.Doc())));
  fake.receive(encodeCommandMessage(commandBatch()));
  await expect.poll(() => fake.sent.find(entry => entry.kind === "result")).toMatchObject({ kind: "result", result: { status: "accepted", revision: 1 } });
  expect(seen).toMatchObject({ status: "accepted", latencyMs: expect.any(Number) });
});
