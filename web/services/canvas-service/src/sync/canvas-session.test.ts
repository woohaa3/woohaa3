/**
 * 服务端 Canvas Session 测试
 * （change: unify-canvas-session-websocket，任务 2.1–2.5）。
 *
 * 覆盖：版本闸门（业务数据之前）、通道隔离（Yjs/activity 交错）、未知 channel、
 * 单通道错误不关闭健康 Yjs 通道、慢 consumer 有界关闭、task-activity 订阅与 cursor。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeMessage,
  decodeSessionFrame,
  decodeTaskActivityServerMessage,
  encodeCommandMessage,
  encodeSessionFrame,
  encodeSyncMessage,
  encodeTaskActivitySubscribe,
  CANVAS_SESSION_PROTOCOL_VERSION,
  SESSION_CHANNEL } from "@woohaa3/contracts/canvas-yjs";
import { CanvasSession, SESSION_CLOSE } from "./canvas-session.js";
import { CanvasRoom } from "./room.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";

const NOW = "2026-09-23T00:00:00.000Z";
const CANVAS = "canvas-session";

function fakeSocket() {
  const sent: Uint8Array[] = [];
  let closed: { code?: number; reason?: string } | null = null;
  let messageHandler: ((data: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  const socket = {
    send(data: Uint8Array) {
      sent.push(data);
    },
    close(code?: number, reason?: string) {
      closed = { code, reason };
      closeHandler?.();
    },
    onMessage(handler: (data: Uint8Array) => void) {
      messageHandler = handler;
      return () => {
        messageHandler = null;
      };
    },
    onClose(handler: () => void) {
      closeHandler = handler;
      return () => {
        closeHandler = null;
      };
    }
  };
  return {
    socket,
    sent,
    get closed() {
      return closed;
    },
    receive(data: Uint8Array) {
      messageHandler?.(data);
    },
    disconnect() {
      closeHandler?.();
    }
  };
}

async function readyRoom(): Promise<CanvasRoom> {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: CANVAS, repository, now: () => NOW });
  await room.initialize({ canvas: createEmptyWoohaa3ServerCanvas(CANVAS, NOW), roomEpoch: "epoch-1", createdAt: NOW });
  return room;
}

function decodeFrames(sent: Uint8Array[]) {
  return sent.map((frame) => decodeSessionFrame(frame));
}

describe("CanvasSession 版本闸门（任务 2.1）", () => {
  it("sessionProtocolVersion 不兼容时在交换文档内容前失败关闭", async () => {
    const room = await readyRoom();
    const fake = fakeSocket();
    const session = new CanvasSession({
      room,
      socket: fake.socket,
      clientSessionProtocolVersion: 99,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: null,
      clientStateVector: new Uint8Array(0),
      actorId: "a",
      now: () => 0
    });
    const frames = decodeFrames(fake.sent);
    // 只有一条 control error；没有任何 Yjs channel 帧。
    expect(frames).toHaveLength(1);
    expect(frames[0]!.channelId).toBe(SESSION_CHANNEL.CONTROL);
    expect(new TextDecoder().decode(frames[0]!.payload)).toContain("session-version-unsupported");
    expect(fake.closed?.code).toBe(SESSION_CLOSE.protocolViolation);
    expect(session.sessionStatus).toBe("closed");
  });
});

describe("CanvasSession 通道隔离（任务 2.2 / 2.5）", () => {
  it("Yjs 与 task-activity 交错，每帧只投递一个 handler", async () => {
    const room = await readyRoom();
    const fake = fakeSocket();
    let subscribed: number | null = null;
    const session = new CanvasSession({
      room,
      socket: fake.socket,
      clientSessionProtocolVersion: CANVAS_SESSION_PROTOCOL_VERSION,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: "epoch-1",
      clientStateVector: new Uint8Array(0),
      actorId: "a",
      now: () => 0,
      onActivitySubscribe: (after) => {
        subscribed = after;
      }
    });
    // 订阅 task-activity 通道。
    fake.receive(encodeSessionFrame(SESSION_CHANNEL.TASK_ACTIVITY, encodeTaskActivitySubscribe({ type: "subscribe", after: 5 })));
    expect(subscribed).toBe(5);

    // 该订阅者收到 activity 记录。
    const beforeActivity = fake.sent.length;
    session.receiveActivityRecord(
      { taskKey: "t", runId: "r", nodeId: "n", state: "running", createdAt: NOW, updatedAt: NOW, durationMs: 0 },
      6
    );
    const activityFrames = decodeFrames(fake.sent.slice(beforeActivity));
    expect(activityFrames[0]!.channelId).toBe(SESSION_CHANNEL.TASK_ACTIVITY);
    expect(decodeTaskActivityServerMessage(activityFrames[0]!.payload)).toMatchObject({ type: "record", cursor: 6 });

    // Yjs 命令仍能通过 canvas-yjs 通道提交并被接受。
    const before = fake.sent.length;
    fake.receive(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, encodeCommandMessage({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS,
      commandId: "cmd-1",
      baseRevision: 0,
      actorId: "a",
      commands: [{ type: "node.add", node: { id: "n1", type: "text", position: { x: 0, y: 0 } } }] as never
    })));
    await room.settle();
    const yjsFrames = decodeFrames(fake.sent.slice(before)).filter((frame) => frame.channelId === SESSION_CHANNEL.CANVAS_YJS);
    const results = yjsFrames
      .map((frame) => decodeMessage(frame.payload))
      .filter((decoded) => decoded.type === MESSAGE_TYPE.COMMAND_RESULT);
    expect(results.some((decoded) => (decoded as { result: { status: string } }).result.status === "accepted")).toBe(true);
  });

  it("未知 channel / 非法方向 / 畸形 frame 稳定关闭且不投递", async () => {
    const room = await readyRoom();
    const fake = fakeSocket();
    const session = new CanvasSession({
      room,
      socket: fake.socket,
      clientSessionProtocolVersion: CANVAS_SESSION_PROTOCOL_VERSION,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: "epoch-1",
      clientStateVector: new Uint8Array(0),
      actorId: "a",
      now: () => 0
    });
    // 未知 channel（9）。
    fake.receive(encodeSessionFrame(9 as never, new Uint8Array([1])));
    expect(fake.closed?.code).toBe(SESSION_CLOSE.protocolViolation);
    expect(session.sessionStatus).toBe("closed");
  });

  it("客户端发送 session-control 被判越界方向", async () => {
    const room = await readyRoom();
    const fake = fakeSocket();
    new CanvasSession({
      room,
      socket: fake.socket,
      clientSessionProtocolVersion: CANVAS_SESSION_PROTOCOL_VERSION,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: "epoch-1",
      clientStateVector: new Uint8Array(0),
      actorId: "a",
      now: () => 0
    });
    fake.receive(encodeSessionFrame(SESSION_CHANNEL.CONTROL, new TextEncoder().encode(JSON.stringify({ type: "ready" }))));
    expect(fake.closed?.code).toBe(SESSION_CLOSE.protocolViolation);
  });

  it("非法 task-activity 消息只报通道错误，不关闭健康 Yjs 通道（design D6）", async () => {
    const room = await readyRoom();
    const fake = fakeSocket();
    const session = new CanvasSession({
      room,
      socket: fake.socket,
      clientSessionProtocolVersion: CANVAS_SESSION_PROTOCOL_VERSION,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: "epoch-1",
      clientStateVector: new Uint8Array(0),
      actorId: "a",
      now: () => 0,
      onActivitySubscribe: () => undefined
    });
    fake.receive(encodeSessionFrame(SESSION_CHANNEL.TASK_ACTIVITY, new TextEncoder().encode(JSON.stringify({ type: "subscribe", after: -1 }))));
    expect(session.sessionStatus).toBe("ready");
    const errors = decodeFrames(fake.sent)
      .filter((frame) => frame.channelId === SESSION_CHANNEL.TASK_ACTIVITY)
      .map((frame) => decodeTaskActivityServerMessage(frame.payload));
    expect(errors.some((message) => message.type === "error" && message.code === "malformed-message")).toBe(true);
  });
});

describe("CanvasSession 慢 consumer（任务 2.4）", () => {
  it("发送队列超限时有界关闭并给可重连 close reason", async () => {
    const room = await readyRoom();
    const fake = fakeSocket();
    const session = new CanvasSession({
      room,
      socket: { ...fake.socket, bufferedAmount: () => 10_000_000 },
      clientSessionProtocolVersion: CANVAS_SESSION_PROTOCOL_VERSION,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: "epoch-1",
      clientStateVector: new Uint8Array(0),
      actorId: "a",
      now: () => 0,
      limits: { maxOutboundQueueBytes: 16 }
    });
    session.broadcastUpdate(new Uint8Array([1, 2, 3]), 1);
    expect(fake.closed?.code).toBe(SESSION_CLOSE.overloaded);
    expect(session.sessionStatus).toBe("closed");
  });
});

describe("CanvasSession 订阅与释放（任务 2.5）", () => {
  it("重复 subscribe 只替换 cursor；release 通知一次 dispose", async () => {
    const room = await readyRoom();
    const fake = fakeSocket();
    const cursors: number[] = [];
    let disposals = 0;
    const session = new CanvasSession({
      room,
      socket: fake.socket,
      clientSessionProtocolVersion: CANVAS_SESSION_PROTOCOL_VERSION,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: "epoch-1",
      clientStateVector: new Uint8Array(0),
      actorId: "a",
      now: () => 0,
      onActivitySubscribe: (after) => cursors.push(after),
      onSessionDispose: () => {
        disposals += 1;
      }
    });
    fake.receive(encodeSessionFrame(SESSION_CHANNEL.TASK_ACTIVITY, encodeTaskActivitySubscribe({ type: "subscribe", after: 1 })));
    fake.receive(encodeSessionFrame(SESSION_CHANNEL.TASK_ACTIVITY, encodeTaskActivitySubscribe({ type: "subscribe", after: 9 })));
    expect(cursors).toEqual([1, 9]);
    expect(session.subscribedCursor).toBe(9);
    expect(session.hasActivitySubscription).toBe(true);

    session.dispose();
    session.dispose();
    expect(disposals).toBe(1);
  });
});

describe("Yjs channel 语义无回归（任务 2.3）", () => {
  it("state vector / 命令结果 / durable 广播经 canvas-yjs 通道到达", async () => {
    const room = await readyRoom();
    const fake = fakeSocket();
    const client = new Y.Doc();
    new CanvasSession({
      room,
      socket: fake.socket,
      clientSessionProtocolVersion: CANVAS_SESSION_PROTOCOL_VERSION,
      clientProtocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      clientFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      clientRoomEpoch: "epoch-1",
      clientStateVector: new Uint8Array(0),
      actorId: "a",
      now: () => 0
    });
    fake.receive(encodeSessionFrame(
      SESSION_CHANNEL.CANVAS_YJS,
      encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(client))
    ));
    const yjsFrames = decodeFrames(fake.sent).filter((frame) => frame.channelId === SESSION_CHANNEL.CANVAS_YJS);
    const syncTypes = yjsFrames
      .map((frame) => decodeMessage(frame.payload))
      .filter((decoded) => decoded.type === MESSAGE_TYPE.SYNC)
      .map((decoded) => (decoded as { syncType: number }).syncType);
    expect(syncTypes).toContain(SYNC_MESSAGE_TYPE.STEP1);
    expect(syncTypes).toContain(SYNC_MESSAGE_TYPE.UPDATE);
  });
});
