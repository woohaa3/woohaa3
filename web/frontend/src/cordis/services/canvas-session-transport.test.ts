/**
 * Canvas Session 前端传输测试
 * （change: unify-canvas-session-websocket，任务 4.1 / 4.2 / 4.4）。
 *
 * 覆盖：URL/version/binary mode、单 socket、通道隔离、未知 channel、迟到消息、
 * bounded outbound queue、重连退避（无并行 timer）与 dispose 清理。
 */
import { describe, expect, it } from "vitest";
import {
  CANVAS_SESSION_PROTOCOL_VERSION,
  SESSION_CHANNEL,
  SessionProtocolError,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeSessionFrame,
  encodeSessionControlMessage,
  encodeSessionFrame,
  encodeTaskActivityRecord,
  decodeTaskActivityClientMessage
} from "@woohaa3/contracts/canvas-yjs";
import { canvasSessionUrl, createCanvasSessionTransport } from "./canvas-session-transport.js";
import type { CanvasTaskActivity } from "@woohaa3/contracts";

const ACTIVITY: CanvasTaskActivity = {
  taskKey: "t1",
  runId: "r1",
  nodeId: "n1",
  state: "running",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
  durationMs: 0
};

type Listener = (event: never) => void;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "";
  sent: Uint8Array[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.emit("close", undefined);
  }
  addEventListener(type: string, handler: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(handler);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, handler: Listener) {
    this.listeners.get(type)?.delete(handler);
  }
  emit(type: string, payload: unknown) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(payload as never);
  }
  open() {
    this.readyState = 1;
    this.emit("open", undefined);
  }
  receive(frame: Uint8Array) {
    this.emit("message", { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }
}

function reset() {
  FakeWebSocket.instances = [];
}

describe("canvasSessionUrl（任务 4.1）", () => {
  it("构造同源、版本化、带 roomEpoch 的 URL", () => {
    const url = canvasSessionUrl({
      basePath: "/api/canvases",
      canvasId: "c 1",
      roomEpoch: "epoch-1",
      location: { protocol: "https:", host: "example.test" }
    });
    expect(url).toContain("wss://example.test/api/canvases/c%201/sync");
    expect(url).toContain(`sessionProtocolVersion=${CANVAS_SESSION_PROTOCOL_VERSION}`);
    expect(url).toContain(`protocolVersion=${YJS_SYNC_PROTOCOL_VERSION}`);
    expect(url).toContain("formatVersion=");
    expect(url).toContain("roomEpoch=epoch-1");
  });
});

describe("Canvas Session transport（任务 4.1 / 4.2 / 4.4）", () => {
  it("接收超过 1 MiB 的完整文档", () => {
    reset();
    const transport = createCanvasSessionTransport({ url: "ws://x", webSocketImpl: FakeWebSocket as unknown as typeof WebSocket });
    try {
      const ws = FakeWebSocket.instances[0]!;
      ws.open();
      const received: Uint8Array[] = [];
      transport.channel(SESSION_CHANNEL.CANVAS_YJS).onMessage(data => received.push(data));
      const payload = new Uint8Array(1_241_176);
      ws.receive(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, payload));
      expect(received[0]).toEqual(payload);
      expect(transport.getState().status).toBe("open");
    } finally { transport.dispose(); }
  });

  it("超限立即关闭通道并忽略排队的迟到消息", () => {
    reset();
    const transport = createCanvasSessionTransport({ url: "ws://x", webSocketImpl: FakeWebSocket as unknown as typeof WebSocket });
    try {
      const ws = FakeWebSocket.instances[0]!;
      ws.open();
      // 模拟真实 WebSocket：close 事件晚于已排队的 message。
      ws.close = () => { ws.readyState = 2; };
      let closed = 0;
      const received: Uint8Array[] = [];
      const channel = transport.channel(SESSION_CHANNEL.CANVAS_YJS);
      channel.onClose(() => closed++);
      channel.onMessage(data => received.push(data));
      ws.receive(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, new Uint8Array(8 * 1024 * 1024 + 1)));
      ws.receive(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, new Uint8Array([1])));
      expect(transport.getState()).toMatchObject({ status: "closed", error: "payload-too-large" });
      expect(closed).toBe(1);
      expect(received).toHaveLength(0);
    } finally { transport.dispose(); }
  });

  it("二进制模式 + 单物理 socket + 通道隔离", () => {
    reset();
    const transport = createCanvasSessionTransport({
      url: "ws://x/api/canvases/c/sync?sessionProtocolVersion=1",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      schedule: () => () => undefined
    });
    const ws = FakeWebSocket.instances[0]!;
    try {
      expect(ws.binaryType).toBe("arraybuffer");
      ws.open();
      expect(transport.getState().status).toBe("open");
      expect(transport.generation()).toBe(1);

      const yjs = transport.channel(SESSION_CHANNEL.CANVAS_YJS);
      const activity = transport.channel(SESSION_CHANNEL.TASK_ACTIVITY);
      const yjsMessages: Uint8Array[] = [];
      const activityMessages: Uint8Array[] = [];
      yjs.onMessage((data) => yjsMessages.push(data));
      activity.onMessage((data) => activityMessages.push(data));

      yjs.send(new Uint8Array([1, 2]));
      activity.send(new Uint8Array([3]));
      expect(ws.sent.map((frame) => decodeSessionFrame(frame).channelId)).toEqual([
        SESSION_CHANNEL.CANVAS_YJS,
        SESSION_CHANNEL.TASK_ACTIVITY
      ]);

      // 交错到达：只交给对应通道。
      ws.receive(encodeSessionFrame(SESSION_CHANNEL.CANVAS_YJS, new Uint8Array([9])));
      ws.receive(encodeSessionFrame(SESSION_CHANNEL.TASK_ACTIVITY, encodeTaskActivityRecord({
        type: "record",
        cursor: 3,
        record: ACTIVITY
      })));
      expect(yjsMessages).toHaveLength(1);
      expect(activityMessages).toHaveLength(1);
    } finally {
      transport.dispose();
    }
  });

  it("未 open 时 enqueue，open 后 flush 并触发通道 onOpen 握手", () => {
    reset();
    const transport = createCanvasSessionTransport({
      url: "ws://x/sync",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      schedule: () => () => undefined
    });
    const ws = FakeWebSocket.instances[0]!;
    try {
      const yjs = transport.channel(SESSION_CHANNEL.CANVAS_YJS);
      const opens: number[] = [];
      yjs.onOpen!(() => opens.push(1));
      yjs.send(new Uint8Array([1]));
      expect(ws.sent).toHaveLength(0);
      expect(transport.queuedBytes()).toBeGreaterThan(0);

      ws.open();
      expect(opens).toHaveLength(1);
      expect(ws.sent).toHaveLength(1);
      expect(transport.queuedBytes()).toBe(0);
    } finally {
      transport.dispose();
    }
  });

  it("channel 的 onOpen 在已 open 时立即触发；activity 逻辑可发送 subscribe", () => {
    reset();
    const transport = createCanvasSessionTransport({
      url: "ws://x/sync",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      schedule: () => () => undefined
    });
    const ws = FakeWebSocket.instances[0]!;
    try {
      ws.open();
      const activity = transport.channel(SESSION_CHANNEL.TASK_ACTIVITY);
      activity.onOpen!(() => {
        activity.send(new TextEncoder().encode(JSON.stringify({ type: "subscribe", after: 4 })));
      });
      const frame = decodeSessionFrame(ws.sent[0]!);
      expect(frame.channelId).toBe(SESSION_CHANNEL.TASK_ACTIVITY);
      expect(decodeTaskActivityClientMessage(frame.payload)).toEqual({ type: "subscribe", after: 4 });
    } finally {
      transport.dispose();
    }
  });

  it("未知入站 channel 关闭连接且不投递（通道隔离兜底）", () => {
    reset();
    const transport = createCanvasSessionTransport({
      url: "ws://x/sync",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      schedule: () => () => undefined
    });
    const ws = FakeWebSocket.instances[0]!;
    try {
      ws.open();
      // 手工构造一个未知 channel（9）的 frame。
      const frame = encodeSessionFrame(9 as never, new Uint8Array([1]));
      ws.receive(frame);
      expect(transport.getState().status).toBe("closed");
      expect(ws.closedWith?.code).toBe(1008);
    } finally {
      transport.dispose();
    }
  });

  it("超出出站队列上限有界终止（不无限缓存）", () => {
    reset();
    const transport = createCanvasSessionTransport({
      url: "ws://x/sync",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      maxQueuedBytes: 16,
      schedule: () => () => undefined
    });
    const ws = FakeWebSocket.instances[0]!;
    try {
      const yjs = transport.channel(SESSION_CHANNEL.CANVAS_YJS);
      yjs.send(new Uint8Array(32));
      expect(transport.getState().error).toBe("outbound-queue-overflow");
      expect(transport.queuedBytes()).toBe(0);
      void ws;
    } finally {
      transport.dispose();
    }
  });

  it("物理断开后按退避重连，且每次 opens 只创建一个 socket", () => {
    reset();
    const timers: Array<() => void> = [];
    const transport = createCanvasSessionTransport({
      url: "ws://x/sync",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      schedule: (run) => {
        timers.push(run);
        return () => undefined;
      },
      random: () => 0
    });
    try {
      const first = FakeWebSocket.instances[0]!;
      first.open();
      expect(transport.generation()).toBe(1);
      // 触发远端关闭：不应立即重连，而是排一个退避 timer。
      first.emit("close", undefined);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(timers).toHaveLength(1);
      timers[0]!();
      expect(FakeWebSocket.instances).toHaveLength(2);
    } finally {
      transport.dispose();
    }
  });

  it("control closing 更新状态，dispose 清理 timer 与 socket", () => {
    reset();
    let scheduled = 0;
    const transport = createCanvasSessionTransport({
      url: "ws://x/sync",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      schedule: () => {
        scheduled += 1;
        return () => undefined;
      }
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive(encodeSessionFrame(SESSION_CHANNEL.CONTROL, encodeSessionControlMessage({ type: "closing", reason: "server-closing" })));
    expect(transport.getState().status).toBe("closed");
    expect(transport.getState().error).toBe("server-closing");
    transport.dispose();
    expect(ws.closedWith?.reason).toBe("client-dispose");
    // dispose 后不再调度重连。
    expect(scheduled).toBe(0);
  });
});

describe("断线恢复（change: 2026-10-21-recover-canvas-connection-explicitly）", () => {
  /** 可取消的假 timer：既能断言「取消被调用」，也能断言没有叠加第二个 timer。 */
  function setup(options: { random?: () => number } = {}) {
    reset();
    const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
    const transport = createCanvasSessionTransport({
      url: "ws://x/sync",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      schedule: (run, delayMs) => {
        const timer = { run, delayMs, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      random: options.random ?? (() => 0)
    });
    return { transport, timers };
  }

  const closing = (reason?: string) =>
    encodeSessionFrame(SESSION_CHANNEL.CONTROL, encodeSessionControlMessage({ type: "closing", ...(reason ? { reason } : {}) }));

  it("服务端 control closing 之后 socket close 仍会排重连（不再永久只读）", () => {
    const { transport, timers } = setup();
    try {
      const first = FakeWebSocket.instances[0]!;
      first.open();
      first.receive(closing("server-closing"));
      expect(transport.getState()).toMatchObject({ status: "closed", error: "server-closing" });
      // closing 本身不排 timer：等物理 close，避免和旧 socket 争一条连接。
      expect(timers).toHaveLength(0);

      first.emit("close", { reason: "server-closing" });
      expect(timers).toHaveLength(1);
      timers[0]!.run();
      expect(FakeWebSocket.instances).toHaveLength(2);
      FakeWebSocket.instances[1]!.open();
      expect(transport.getState().status).toBe("open");
      expect(transport.generation()).toBe(2);
    } finally {
      transport.dispose();
    }
  });

  it("服务端可重试的主动关闭原因（canvas-closing / server-shutdown）同样重连", () => {
    for (const reason of ["canvas-closing", "server-shutdown"]) {
      const { transport, timers } = setup();
      try {
        const first = FakeWebSocket.instances[0]!;
        first.open();
        first.receive(closing(reason));
        first.emit("close", { reason });
        expect(timers).toHaveLength(1);
      } finally {
        transport.dispose();
      }
    }
  });

  it.each(["read-revoked", "canvas-deleted", "session-version-unsupported", "unauthenticated"])(
    "不可重试原因 %s：停在明确错误上，不排重连",
    (reason) => {
      const { transport, timers } = setup();
      try {
        const first = FakeWebSocket.instances[0]!;
        first.open();
        first.receive(closing(reason));
        expect(transport.getState()).toMatchObject({ status: "closed", error: reason });
        first.emit("close", { reason });
        expect(timers).toHaveLength(0);
        expect(FakeWebSocket.instances).toHaveLength(1);
      } finally {
        transport.dispose();
      }
    }
  );

  it("control error 的不可重试错误码同样停在错误上", () => {
    const { transport, timers } = setup();
    try {
      const first = FakeWebSocket.instances[0]!;
      first.open();
      first.receive(
        encodeSessionFrame(
          SESSION_CHANNEL.CONTROL,
          encodeSessionControlMessage({ type: "error", code: "unauthenticated", message: "未认证" })
        )
      );
      expect(transport.getState()).toMatchObject({ status: "closed", error: "unauthenticated: 未认证" });
      first.emit("close", { reason: "unauthenticated" });
      expect(timers).toHaveLength(0);
    } finally {
      transport.dispose();
    }
  });

  it("可重试的 control error 只记录错误，连接保持可写并在断线后重连", () => {
    const { transport, timers } = setup();
    try {
      const first = FakeWebSocket.instances[0]!;
      first.open();
      first.receive(
        encodeSessionFrame(
          SESSION_CHANNEL.CONTROL,
          encodeSessionControlMessage({ type: "error", code: "task-unavailable", retryable: true })
        )
      );
      expect(transport.getState()).toMatchObject({ status: "open", error: "task-unavailable" });
      first.emit("close", { reason: "server-closing" });
      expect(timers).toHaveLength(1);
    } finally {
      transport.dispose();
    }
  });

  it("reconnect() 取消挂起的退避并立即发起新连接（不叠加 timer）", () => {
    const { transport, timers } = setup();
    try {
      const first = FakeWebSocket.instances[0]!;
      first.open();
      first.emit("close", { reason: "network" });
      expect(timers).toHaveLength(1);
      transport.reconnect();
      expect(timers[0]!.cancelled).toBe(true);
      expect(FakeWebSocket.instances).toHaveLength(2);
      // 没有排第二个退避 timer：重连由显式调用自己发起。
      expect(timers).toHaveLength(1);
    } finally {
      transport.dispose();
    }
  });

  it("reconnect() 关闭尚未打开的旧 socket，且不因它的 close 再次调度", () => {
    const { transport, timers } = setup();
    try {
      const first = FakeWebSocket.instances[0]!;
      first.open();
      // 服务端先宣告 closing（status 已 closed，但 socket 的 close 事件尚未到）：此时显式重连
      // 必须关掉这条旧 socket，且它的 close 不得再排一次 timer。
      first.receive(closing("server-closing"));
      transport.reconnect();
      expect(first.closedWith).toEqual({ code: 1000, reason: "client-reconnect" });
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(timers).toHaveLength(0);
      expect(transport.getState().status).toBe("connecting");
    } finally {
      transport.dispose();
    }
  });

  it("已 open 时 reconnect() 是空操作", () => {
    const { transport, timers } = setup();
    try {
      FakeWebSocket.instances[0]!.open();
      transport.reconnect();
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(timers).toHaveLength(0);
      expect(transport.getState().status).toBe("open");
    } finally {
      transport.dispose();
    }
  });

  it("reconnect() 重置退避计数，下一次退避回到基值", () => {
    const { transport, timers } = setup();
    try {
      const first = FakeWebSocket.instances[0]!;
      first.open();
      first.emit("close", { reason: "network" });
      expect(timers.at(-1)!.delayMs).toBe(300);
      timers.at(-1)!.run();
      FakeWebSocket.instances[1]!.emit("close", { reason: "network" });
      expect(timers.at(-1)!.delayMs).toBe(600);
      // 显式重连：退避计数归零，下一次失败仍从基值开始。
      transport.reconnect();
      FakeWebSocket.instances.at(-1)!.emit("close", { reason: "network" });
      expect(timers.at(-1)!.delayMs).toBe(300);
    } finally {
      transport.dispose();
    }
  });

  it("dispose 后不再重连（取消挂起 timer，close 事件也不再调度）", () => {
    const { transport, timers } = setup();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.emit("close", { reason: "network" });
    expect(timers).toHaveLength(1);
    transport.dispose();
    expect(timers[0]!.cancelled).toBe(true);
    first.emit("close", { reason: "network" });
    expect(timers).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("SessionProtocolError 引用", () => {
  it("错误类型导出可用", () => {
    expect(new SessionProtocolError("malformed-frame", "x").code).toBe("malformed-frame");
  });
});
