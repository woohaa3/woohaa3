/**
 * Canvas Session wire 契约测试
 * （change: unify-canvas-session-websocket，任务 1.1 / 1.2 / 1.3）。
 *
 * 覆盖：envelope round-trip、未知 channel、畸形 frame、尾随 bytes、超限 payload、
 * channel 方向、task-activity 严格 decoder，以及「既有 Yjs 帧作为 canvas-yjs payload
 * 原样往返」的兼容 fixture。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CANVAS_SESSION_PROTOCOL_VERSION,
  SESSION_CHANNEL,
  SESSION_CHANNEL_NAMES,
  SESSION_LIMITS,
  SessionProtocolError,
  assertSessionChannelDirection,
  decodeSessionControlMessage,
  decodeSessionFrame,
  decodeTaskActivityClientMessage,
  decodeTaskActivityServerMessage,
  encodeSessionControlMessage,
  encodeSessionFrame,
  encodeTaskActivityError,
  encodeTaskActivityReady,
  encodeTaskActivityRecord,
  encodeTaskActivitySubscribe
} from "./session.js";
import {
  MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  decodeMessage,
  encodeCommandMessage,
  encodeStatusMessage,
  encodeSyncMessage
} from "./yjs/protocol.js";
import type { CanvasCommandBatch } from "./yjs/commands.js";
import type { CanvasTaskActivity } from "../task/activity.js";

const ACTIVITY: CanvasTaskActivity = {
  taskKey: "worker-1",
  runId: "run-1",
  nodeId: "n1",
  state: "running",
  modelType: "image",
  modelKey: "litellm:m1",
  progress: 0.5,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
  durationMs: 1000
};

function expectError(code: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SessionProtocolError);
    expect((error as SessionProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}`);
}

describe("Canvas Session envelope（任务 1.1）", () => {
  it("固定版本与稳定 channel ID/名称", () => {
    expect(CANVAS_SESSION_PROTOCOL_VERSION).toBe(1);
    expect(SESSION_CHANNEL).toEqual({ CONTROL: 0, CANVAS_YJS: 1, TASK_ACTIVITY: 2 });
    expect(SESSION_CHANNEL_NAMES[0]).toBe("session-control");
    expect(SESSION_CHANNEL_NAMES[1]).toBe("canvas-yjs");
    expect(SESSION_CHANNEL_NAMES[2]).toBe("task-activity");
  });

  it("envelope round-trip 保留 channel 与 payload 字节", () => {
    const payload = new Uint8Array([1, 2, 3, 200, 255]);
    const frame = encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, payload);
    const decoded = decodeSessionFrame(frame);
    expect(decoded.channelId).toBe(SESSION_CHANNEL.CANVAS_YJS);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 200, 255]);
  });

  it("空 payload 合法", () => {
    const decoded = decodeSessionFrame(encodeSessionFrame(SESSION_CHANNEL.CONTROL, new Uint8Array(0)));
    expect(decoded.channelId).toBe(SESSION_CHANNEL.CONTROL);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it("未知 channel 被拒绝", () => {
    const frame = encodeSessionFrame(9 as never, new Uint8Array([1]));
    expectError("unknown-channel", () => decodeSessionFrame(frame));
  });

  it("畸形 frame（空/截断）被拒绝", () => {
    expectError("malformed-frame", () => decodeSessionFrame(new Uint8Array(0)));
    // channel=1 但缺少 payload 长度/内容。
    expectError("malformed-frame", () => decodeSessionFrame(new Uint8Array([1])));
  });

  it("尾随 bytes 被拒绝", () => {
    const frame = encodeSessionFrame(SESSION_CHANNEL.TASK_ACTIVITY, new Uint8Array([9]));
    const withTrailing = new Uint8Array([...frame, 7]);
    expectError("trailing-bytes", () => decodeSessionFrame(withTrailing));
  });

  it("超限 frame / payload 被拒绝", () => {
    const big = new Uint8Array(SESSION_LIMITS.maxChannelPayloadBytes + 1);
    const frame = encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, big);
    expectError("payload-too-large", () => decodeSessionFrame(frame, { maxFrameBytes: frame.byteLength + 10 }));
    expectError("payload-too-large", () => decodeSessionFrame(frame));
  });

  it("真实画布规模的 Yjs 初始快照可通过服务端上限（回归：画布静止）", () => {
    // 完整 Yjs 初始快照是单条 frame，可超过客户端默认 1 MiB 上限；浏览器接收侧使用服务端
    // 上限（`maxServerFrameBytes`）。旧组合把它们混用会让较大画布握手被拒（画布静止不可动）。
    // 既有实测画布快照约 1.25 MiB；这里用 4 MiB 断言仍被接受。
    const snapshot = new Uint8Array(4 * 1024 * 1024);
    const frame = encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, snapshot);
    expect(frame.byteLength).toBeGreaterThan(SESSION_LIMITS.maxFrameBytes);
    const decoded = decodeSessionFrame(frame, {
      maxFrameBytes: SESSION_LIMITS.maxServerFrameBytes,
      maxChannelPayloadBytes: SESSION_LIMITS.maxServerChannelPayloadBytes
    });
    expect(decoded.channelId).toBe(SESSION_CHANNEL.CANVAS_YJS);
    expect(decoded.payload.byteLength).toBe(snapshot.byteLength);
  });

  it("channel 方向约束稳定", () => {
    expect(() => assertSessionChannelDirection(SESSION_CHANNEL.CANVAS_YJS, "client-to-server")).not.toThrow();
    expect(() => assertSessionChannelDirection(SESSION_CHANNEL.CONTROL, "client-to-server")).toThrow();
    expectError("invalid-direction", () =>
      assertSessionChannelDirection(SESSION_CHANNEL.CONTROL, "client-to-server")
    );
  });
});

describe("session-control payload", () => {
  it("ready/closing/error round-trip", () => {
    expect(decodeSessionControlMessage(encodeSessionControlMessage({ type: "ready" }))).toEqual({ type: "ready" });
    expect(decodeSessionControlMessage(encodeSessionControlMessage({ type: "closing", reason: "bye" }))).toEqual({
      type: "closing",
      reason: "bye"
    });
    expect(
      decodeSessionControlMessage(encodeSessionControlMessage({ type: "error", code: "task-unavailable", retryable: true }))
    ).toEqual({ type: "error", code: "task-unavailable", retryable: true });
  });

  it("非法 payload 被拒绝", () => {
    expectError("invalid-json", () => decodeSessionControlMessage(new TextEncoder().encode("{")));
    expectError("malformed-message", () =>
      decodeSessionControlMessage(new TextEncoder().encode(JSON.stringify({ type: "nope" })))
    );
  });
});

describe("task-activity payload（任务 1.2）", () => {
  it("subscribe round-trip 且拒绝非法 cursor/身份字段", () => {
    expect(decodeTaskActivityClientMessage(encodeTaskActivitySubscribe({ type: "subscribe", after: 12 }))).toEqual({
      type: "subscribe",
      after: 12
    });
    expectError("malformed-message", () =>
      decodeTaskActivityClientMessage(new TextEncoder().encode(JSON.stringify({ type: "subscribe", after: -1 })))
    );
    expectError("malformed-message", () =>
      decodeTaskActivityClientMessage(new TextEncoder().encode(JSON.stringify({ type: "subscribe", after: 1.5 })))
    );
    expectError("malformed-message", () =>
      decodeTaskActivityClientMessage(
        new TextEncoder().encode(JSON.stringify({ type: "subscribe", after: 0, canvasId: "other" }))
      )
    );
  });

  it("ready/record/error round-trip 并裁剪字段", () => {
    expect(decodeTaskActivityServerMessage(encodeTaskActivityReady({ type: "ready", cursor: 3 }))).toEqual({
      type: "ready",
      cursor: 3
    });
    const record = decodeTaskActivityServerMessage(
      encodeTaskActivityRecord({ type: "record", cursor: 5, record: ACTIVITY })
    );
    expect(record).toMatchObject({ type: "record", cursor: 5, record: { taskKey: "worker-1" } });
    expect(
      decodeTaskActivityServerMessage(encodeTaskActivityError({ type: "error", code: "unavailable", retryable: false }))
    ).toEqual({ type: "error", code: "unavailable", retryable: false });
  });

  it("record 必须是安全活动项（缺 runId 拒绝）", () => {
    expectError("malformed-message", () =>
      decodeTaskActivityServerMessage(
        new TextEncoder().encode(
          JSON.stringify({ type: "record", cursor: 1, record: { taskKey: "t", nodeId: "n" } })
        )
      )
    );
  });

  it("超限 payload 被拒绝", () => {
    const huge = new Uint8Array(SESSION_LIMITS.maxTaskActivityPayloadBytes + 1);
    expectError("payload-too-large", () => decodeTaskActivityServerMessage(huge));
  });
});

describe("canvas-yjs payload 兼容 fixture（任务 1.3）", () => {
  const batch: CanvasCommandBatch = {
    protocolVersion: 1,
    canvasId: "canvas-a",
    commandId: "cmd-1",
    baseRevision: 0,
    actorId: "actor",
    commands: [{ type: "canvas.setTitle", title: "x" }]
  };

  it("state vector / update / command / result / status 嵌套后字节不变", () => {
    const frames: Uint8Array[] = [
      encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(new Y.Doc())),
      encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, Y.encodeStateAsUpdate(new Y.Doc())),
      encodeCommandMessage(batch),
      encodeStatusMessage({ status: "synced", revision: 3 })
    ];
    for (const inner of frames) {
      const outer = encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, inner);
      const decoded = decodeSessionFrame(outer);
      expect(decoded.channelId).toBe(SESSION_CHANNEL.CANVAS_YJS);
      // 字节级完全一致（嵌套不改变内层 Yjs 协议帧）。
      expect(Array.from(decoded.payload)).toEqual(Array.from(inner));
    }
  });

  it("嵌套的 command 帧仍能按 Yjs 协议解码", () => {
    const inner = encodeCommandMessage(batch);
    const payload = decodeSessionFrame(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, inner)).payload;
    const decoded = decodeMessage(payload);
    expect(decoded.type).toBe(MESSAGE_TYPE.COMMAND);
    expect((decoded as { batch: CanvasCommandBatch }).batch.commandId).toBe("cmd-1");
  });
});
