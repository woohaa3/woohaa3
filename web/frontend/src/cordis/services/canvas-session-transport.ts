/**
 * Canvas Session 物理传输（change: unify-canvas-session-websocket，任务 4.1 / 4.2 / 4.4 / design D2、D6、D7）。
 *
 * Canvas page scope 的**唯一**物理 WebSocket 拥有者。它负责：
 * - 用 `sessionProtocolVersion` + 内层 Yjs 版本构造同源 `/api/canvases/:id/sync`；
 * - envelope 编解码与通道分派（每帧只交给一个逻辑通道）；
 * - 物理 open/close/reconnect 状态、指数退避 + 抖动与有界出站队列；
 * - 每次连接/重连成功后重新触发各通道的 open 握手（Yjs state vector / activity cursor）；
 * - 关闭原因分类：不可重试原因（权限撤销/画布删除/版本不兼容/未认证）停在明确错误上，
 *   其余关闭（含服务端主动 control `closing`）一律重建物理连接
 *   （change: 2026-10-21-recover-canvas-connection-explicitly）。
 *
 * feature/plugin 只消费 `channel(channelId)` 返回的 `SyncSocket`，**不**创建 WebSocket、
 * 不持有重连 timer（架构审计强制）。
 */
import {
  CANVAS_SESSION_PROTOCOL_VERSION,
  SESSION_CHANNEL,
  SESSION_LIMITS,
  SessionProtocolError,
  decodeSessionControlMessage,
  decodeSessionFrame,
  encodeSessionFrame,
  type SessionChannelId
} from "@woohaa3/contracts/canvas-yjs";
import type { SyncSocket } from "@woohaa3/contracts/canvas-yjs";
import { YJS_CANVAS_FORMAT_VERSION, YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import {
  activeTelemetryClient,
  stableTelemetryErrorCode,
  telemetryNow,
  type TelemetryClient
} from "./telemetry-primitives.js";

export type CanvasSessionTransportStatus = "connecting" | "open" | "closed";

export type CanvasSessionTransportState = {
  status: CanvasSessionTransportStatus;
  /** 服务端确认的 session wire 版本（握手后）。 */
  sessionVersion: number;
  /** 最近一次协议/连接错误（安全短文案）。 */
  error: string | null;
  /** 已建立的物理连接序号（每次 open 递增；用于断言重连只创建一个 socket）。 */
  generation: number;
};

export type CanvasSessionTransportOptions = {
  url: string;
  webSocketImpl?: typeof globalThis.WebSocket;
  /** 出站队列字节上限（超限有界终止）。 */
  maxQueuedBytes?: number;
  /** 重连退避基数/上限（毫秒）。 */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** 抖动比例（0..1）。 */
  jitterRatio?: number;
  schedule?: (run: () => void, delayMs: number) => () => void;
  random?: () => number;
  onStateChange?: (state: CanvasSessionTransportState) => void;
  /**
   * 遥测采集客户端（可选；change: 2026-10-20-add-local-client-telemetry，任务 4.2）。
   *
   * 省略时回退到 App scope 安装的客户端；两者都不存在时 `sync.reconcile` 埋点整体 no-op。
   * **不**硬依赖：传输是纯工厂，测试/插件实例化时不需要遥测存在。
   */
  telemetry?: TelemetryClient;
};

type ChannelDispatcher = {
  message: Set<(data: Uint8Array) => void>;
  open: Set<() => void>;
  close: Set<() => void>;
  closed: boolean;
};

export type CanvasSessionTransport = {
  channel(channelId: SessionChannelId): SyncSocket;
  getState(): CanvasSessionTransportState;
  subscribe(listener: (state: CanvasSessionTransportState) => void): () => void;
  /** 主动重连（未打开时立即重试）。 */
  reconnect(): void;
  dispose(): void;
  /** 出站队列当前字节数（测试用）。 */
  queuedBytes(): number;
  /** 当前物理连接 generation（测试用；每次 open 递增）。 */
  generation(): number;
};

export function createCanvasSessionTransport(options: CanvasSessionTransportOptions): CanvasSessionTransport {
  const maxQueuedBytes = options.maxQueuedBytes ?? SESSION_LIMITS.maxFrameBytes * 4;
  const reconnectBaseMs = options.reconnectBaseMs ?? 300;
  const reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
  const jitterRatio = options.jitterRatio ?? 0.3;
  const schedule = options.schedule ?? ((run, delayMs) => {
    const handle = setTimeout(run, delayMs);
    return () => clearTimeout(handle);
  });
  const random = options.random ?? Math.random;
  const webSocketImpl = options.webSocketImpl ?? (globalThis.WebSocket as unknown as typeof globalThis.WebSocket);

  const channels = new Map<SessionChannelId, ChannelDispatcher>();
  const stateListeners = new Set<(state: CanvasSessionTransportState) => void>();
  let state: CanvasSessionTransportState = {
    status: "connecting",
    sessionVersion: CANVAS_SESSION_PROTOCOL_VERSION,
    error: null,
    generation: 0
  };
  let ws: WebSocket | null = null;
  let disposed = false;
  let queued: Uint8Array[] = [];
  let queuedBytes = 0;
  let cancelReconnect: (() => void) | null = null;
  let reconnectAttempt = 0;
  /**
   * 最近一次关闭是否值得重连。
   *
   * 服务端可通过 control `closing` 的 reason 或 control error 的 code 宣告终态原因
   * （权限被撤销、画布被删除、协议版本不兼容、未认证）：这些情况重建连接也不会成功，
   * 必须停在明确错误上，不能进入指数退避把页面永久留在重连中。
   */
  let retryable = true;

  // —— sync.reconcile 埋点（可选；change: 2026-10-20-add-local-client-telemetry，design D3/D7）——
  // 只观测**重连尝试**：首次连接由 canvas-session 的 sync.connect 覆盖。一次尝试的 open（成功）
  // 或 close/创建失败（失败）结算一条，durationMs = 该次尝试耗时；缺失客户端即 no-op。
  const telemetry = (): TelemetryClient | undefined => options.telemetry ?? activeTelemetryClient();
  const recordTelemetry = (input: Parameters<TelemetryClient["record"]>[0]): void => {
    try {
      telemetry()?.record(input);
    } catch {
      // 防御：埋点异常不得影响连接/重连。
    }
  };
  let reconcileStartedAt: number | null = null;
  const settleReconcile = (result: "success" | "failure" | "cancelled", errorCode?: string): void => {
    if (reconcileStartedAt === null) return;
    const durationMs = Math.max(0, Math.round(telemetryNow() - reconcileStartedAt));
    reconcileStartedAt = null;
    recordTelemetry({
      name: "sync.reconcile",
      result,
      origin: "browser",
      surface: "sync",
      durationMs,
      ...(errorCode === undefined ? {} : { errorCode })
    });
  };

  const publish = (patch: Partial<CanvasSessionTransportState>) => {
    state = { ...state, ...patch };
    for (const listener of [...stateListeners]) listener(state);
    options.onStateChange?.(state);
  };

  const dispatcherFor = (channelId: SessionChannelId): ChannelDispatcher => {
    let dispatcher = channels.get(channelId);
    if (!dispatcher) {
      dispatcher = { message: new Set(), open: new Set(), close: new Set(), closed: false };
      channels.set(channelId, dispatcher);
    }
    return dispatcher;
  };

  const clearQueue = () => {
    queued = [];
    queuedBytes = 0;
  };

  const closeChannels = () => {
    for (const dispatcher of channels.values()) {
      if (dispatcher.closed) continue;
      dispatcher.closed = true;
      for (const handler of [...dispatcher.close]) handler();
    }
  };

  const scheduleReconnect = () => {
    if (disposed || cancelReconnect) return;
    const base = Math.min(reconnectBaseMs * 2 ** reconnectAttempt, reconnectMaxMs);
    const jitter = base * jitterRatio * random();
    reconnectAttempt += 1;
    cancelReconnect = schedule(() => {
      cancelReconnect = null;
      // 从这里起的 connect 都是"重连尝试"：开始计时（首次连接不经过本路径）。
      reconcileStartedAt = telemetryNow();
      connect();
    }, Math.round(base + jitter));
  };

  const connect = () => {
    if (disposed) return;
    /** 这条 socket 是否真的建立过：服务端主动关闭后仍要重建连接（见 close 处理）。 */
    let opened = false;
    let socket: WebSocket;
    try {
      socket = new webSocketImpl(options.url);
    } catch (error) {
      publish({ status: "closed", error: error instanceof Error ? error.message : "无法创建连接" });
      settleReconcile("failure", stableTelemetryErrorCode(error instanceof Error ? error.message : undefined, "connect-failed"));
      scheduleReconnect();
      return;
    }
    ws = socket;
    // 浏览器默认 binaryType 是 "blob"，协议层只接受字节视图。
    socket.binaryType = "arraybuffer";
    publish({ status: "connecting", error: null });

    socket.addEventListener("open", () => {
      if (disposed || ws !== socket) return;
      opened = true;
      // 新连接建立后重置终态判定：本次会话仍可继续被服务端关闭以宣告不可重试原因。
      retryable = true;
      reconnectAttempt = 0;
      publish({ status: "open", error: null, generation: state.generation + 1 });
      // 重连尝试成功：结算 sync.reconcile（首次连接无计时，settle 为 no-op）。
      settleReconcile("success");
      // 先 flush 缓存帧，再触发各通道 open 握手。
      for (const frame of queued) {
        try {
          socket.send(frame);
        } catch {
          // ignore
        }
      }
      clearQueue();
      for (const dispatcher of channels.values()) {
        dispatcher.closed = false;
        for (const handler of [...dispatcher.open]) handler();
      }
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      // 拒绝一帧后，已排队的 synced/ready 不得把失败连接重新标成可写。
      if (disposed || ws !== socket || state.status === "closed") return;
      const data = toBytes(event.data);
      if (!data) return;
      let frame;
      try {
        frame = decodeSessionFrame(data, {
          maxFrameBytes: SESSION_LIMITS.maxServerFrameBytes,
          maxChannelPayloadBytes: SESSION_LIMITS.maxServerChannelPayloadBytes
        });
      } catch (error) {
        const code = error instanceof SessionProtocolError ? error.code : "malformed-frame";
        // 立即通知各通道失去连接，不等待异步 close 后才撤销写入门禁。
        publish({ status: "closed", error: code });
        closeChannels();
        try {
          socket.close(1008, code);
        } catch {
          // ignore
        }
        return;
      }
      if (frame.channelId === SESSION_CHANNEL.CONTROL) {
        handleControl(frame.payload);
        return;
      }
      const dispatcher = channels.get(frame.channelId);
      if (!dispatcher) return;
      for (const handler of [...dispatcher.message]) handler(frame.payload);
    });

    socket.addEventListener("close", (event: CloseEvent) => {
      if (ws !== socket) return;
      ws = null;
      // 服务端主动关闭会先发 control `closing`（此时 status 已是 closed）。若只按
      // `status !== "closed"` 判定是否重连，这类关闭就**永不重建连接**，画布永久只读。
      // 判定改成「这条 socket 是否建立过 / 是否仍在可写期」，再叠加关闭原因分类
      // （change: 2026-10-21-recover-canvas-connection-explicitly）。
      const closeReason = (event as CloseEvent | undefined)?.reason ?? null;
      if (closeReason) retryable = retryable && isRetryableCloseReason(closeReason);
      const shouldReconnect = opened || state.status !== "closed";
      publish({ status: "closed", error: state.error });
      closeChannels();
      // 重连尝试在 open 之前关闭：本次对账失败（下一次 scheduleReconnect 会重新计时）。
      if (!disposed) settleReconcile("failure", stableTelemetryErrorCode(state.error, "connect-failed"));
      if (shouldReconnect && retryable && !disposed) scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (disposed || ws !== socket) return;
      publish({ error: "连接错误" });
    });
  };

  const handleControl = (payload: Uint8Array) => {
    let message;
    try {
      message = decodeSessionControlMessage(payload);
    } catch {
      return;
    }
    if (message.type === "ready") {
      publish({ status: "open", error: null });
      return;
    }
    if (message.type === "closing") {
      // 关闭原因分类（change: 2026-10-21-recover-canvas-connection-explicitly）：
      // 不可重试原因停在明确错误上；其余（server-closing / canvas-closing / server-shutdown）
      // 在随后的 socket close 里按退避重建物理连接。
      retryable = isRetryableCloseReason(message.reason);
      publish({ status: "closed", error: message.reason ?? null });
      return;
    }
    // 通道级/协议级错误：记录；版本不兼容是致命（服务端会关闭连接）。
    const detail = `${message.code}${message.message ? `: ${message.message}` : ""}`;
    if (!isRetryableCloseReason(`${message.code} ${message.message ?? ""}`)) {
      // 不可重试的协议错误与 closing 同效：停在明确错误上，不进入指数退避。
      retryable = false;
      publish({ status: "closed", error: detail });
      return;
    }
    publish({ error: detail });
  };

  const sendFrame = (frame: Uint8Array) => {
    if (disposed) return;
    if (ws && state.status === "open" && ws.readyState === webSocketImpl.OPEN) {
      try {
        ws.send(frame);
        return;
      } catch {
        // 落到队列重连后发送。
      }
    }
    if (queuedBytes + frame.byteLength > maxQueuedBytes) {
      // 慢 consumer：有界终止（重连后用 state vector / cursor 恢复）。
      publish({ status: "closed", error: "outbound-queue-overflow" });
      try {
        ws?.close(1013, "outbound-queue-overflow");
      } catch {
        // ignore
      }
      clearQueue();
      return;
    }
    queued.push(frame);
    queuedBytes += frame.byteLength;
  };

  const channel = (channelId: SessionChannelId): SyncSocket => {
    const dispatcher = dispatcherFor(channelId);
    return {
      send(data: Uint8Array) {
        sendFrame(encodeSessionFrame(channelId, data));
      },
      close(code?: number, reason?: string) {
        try {
          ws?.close(code, reason);
        } catch {
          // ignore
        }
      },
      isOpen: () => state.status === "open",
      bufferedAmount: () => queuedBytes,
      onOpen(handler: () => void) {
        dispatcher.open.add(handler);
        if (state.status === "open") handler();
        return () => dispatcher.open.delete(handler);
      },
      onMessage(handler: (data: Uint8Array) => void) {
        dispatcher.message.add(handler);
        return () => dispatcher.message.delete(handler);
      },
      onClose(handler: () => void) {
        if (dispatcher.closed) {
          handler();
          return () => undefined;
        }
        dispatcher.close.add(handler);
        return () => dispatcher.close.delete(handler);
      }
    };
  };

  connect();

  return {
    channel,
    getState: () => state,
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    /**
     * 显式重连：立即重建物理连接，不等退避。
     *
     * 顺序很重要：先取消挂起的 timer，再关闭「尚未打开的旧 socket」（先把引用置空，
     * 它的 close 事件就不会再排一次 timer），最后立即 connect。已 open 时空操作。
     * 重置退避与不可重试判定：这是用户的显式恢复请求，不应被上一次的终态挡住。
     */
    reconnect() {
      if (disposed) return;
      cancelReconnect?.();
      cancelReconnect = null;
      if (state.status === "open" && ws) return;
      reconnectAttempt = 0;
      retryable = true;
      const stale = ws;
      ws = null;
      try {
        stale?.close(1000, "client-reconnect");
      } catch {
        // 旧 socket 已关闭/底层抛错不影响新连接。
      }
      // 显式重连同样是一次重连尝试：纳入 sync.reconcile 观测（与退避重连一致）。
      reconcileStartedAt = telemetryNow();
      connect();
    },
    dispose() {
      // 尚未结算的重连尝试按取消计（不伪装成失败）。
      settleReconcile("cancelled");
      disposed = true;
      cancelReconnect?.();
      cancelReconnect = null;
      clearQueue();
      const socket = ws;
      ws = null;
      try {
        socket?.close(1000, "client-dispose");
      } catch {
        // ignore
      }
      stateListeners.clear();
      channels.clear();
    },
    queuedBytes: () => queuedBytes,
    generation: () => state.generation
  };
}

/** 服务端明确宣告的不可重试关闭原因（重建连接也不会成功）。 */
const NON_RETRYABLE_CLOSE_REASONS = [
  "read-revoked",
  "canvas-deleted",
  "session-version-unsupported",
  "unsupported-version",
  "unauthenticated"
] as const;

/**
 * 关闭原因是否可重试（change: 2026-10-21-recover-canvas-connection-explicitly）。
 *
 * 权限被撤销、画布被删除、协议版本不兼容、未认证都属于「重建连接也不会成功」的终态：
 * 必须停在明确错误上，不能进指数退避把页面永久留在重连中（用户看到的仍是只读）。
 * 空原因（正常 close、网络抖动、服务端重启）按可重试处理。
 */
function isRetryableCloseReason(reason: string | null | undefined): boolean {
  if (!reason) return true;
  const text = reason.toLowerCase();
  return !NON_RETRYABLE_CLOSE_REASONS.some((marker) => text.includes(marker));
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  return null;
}

/** 构造同源 Canvas Session WebSocket URL（Yjs provider 不再自行拼 URL）。 */
export function canvasSessionUrl(input: {
  basePath: string;
  canvasId: string;
  roomEpoch: string | null;
  location: { protocol?: string; host?: string };
}): string {
  const protocol = input.location.protocol === "https:" ? "wss:" : "ws:";
  const host = input.location.host ?? "localhost";
  const params = new URLSearchParams({
    sessionProtocolVersion: String(CANVAS_SESSION_PROTOCOL_VERSION),
    protocolVersion: String(YJS_SYNC_PROTOCOL_VERSION),
    formatVersion: YJS_CANVAS_FORMAT_VERSION
  });
  if (input.roomEpoch) params.set("roomEpoch", input.roomEpoch);
  return `${protocol}//${host}${input.basePath}/${encodeURIComponent(input.canvasId)}/sync?${params.toString()}`;
}
