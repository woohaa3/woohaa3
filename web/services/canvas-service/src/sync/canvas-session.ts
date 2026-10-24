/**
 * 服务端 Canvas Session（change: unify-canvas-session-websocket，任务 2.1–2.5 / design D1、D2、D3、D6、D7）。
 *
 * 一条物理连接被提升为**版本化 Canvas Session**：它拥有 envelope dispatcher、每通道的方向
 * 与大小约束、发送队列上限与统一 dispose；Yjs 同步与画布任务活动只是两个逻辑通道。
 *
 * 传输无关：只依赖 `SyncSocket` 抽象，因此 `ws` 与内存 fake 共用同一份协议逻辑。
 * 层级：
 *
 * ```text
 * CanvasSession                     ← 物理连接、envelope、限流、dispose
 *   ├─ ChannelSocket(canvas-yjs)     ← 交给既有 CanvasSyncSession（state vector / 命令 / durable 广播）
 *   └─ task-activity                ← subscribe/record/ready/error + cursor
 * ```
 *
 * 关键约束（spec「Canvas Session SHALL version and recover the physical connection
 * independently of channels」）：
 * - `sessionProtocolVersion` 在交换任何 Yjs 文档内容或任务活动记录**之前**校验；
 * - 未知 channel / 畸形 frame / 尾随 bytes / 越界方向 → 稳定协议错误并关闭，不泄漏其它画布数据；
 * - 单个通道的依赖错误（例如 Task 不可用）只在该通道报告，不关闭健康的 Yjs 通道。
 */
import {
  CANVAS_SESSION_PROTOCOL_VERSION,
  SESSION_CHANNEL,
  SESSION_LIMITS,
  SessionProtocolError,
  decodeSessionFrame,
  decodeTaskActivityClientMessage,
  encodeSessionControlMessage,
  encodeSessionFrame,
  encodeTaskActivityError,
  encodeTaskActivityReady,
  encodeTaskActivityRecord,
  type SessionChannelId
} from "@woohaa3/contracts/canvas-yjs";
import type { CanvasTaskActivity } from "@woohaa3/contracts/canvas-yjs";
import type { SyncSocket } from "@woohaa3/contracts/canvas-yjs";
import { CanvasSyncSession, DEFAULT_SYNC_LIMITS, type SyncSessionLimits, type SyncSessionContext } from "./sync-session.js";
import type { CanvasSessionBroadcastTarget } from "./sync-hub.js";
import type { CanvasRoom } from "./room.js";

/** 应用层 close code（WebSocket 4000–4999 段为应用保留）。 */
export const SESSION_CLOSE = {
  /** 协议违规：版本不兼容、未知 channel、畸形 frame、越界方向。 */
  protocolViolation: 1008,
  /** 会话过载：慢 consumer 导致发送队列超限（可重连恢复）。 */
  overloaded: 1013,
  /** 服务端主动关闭（切换/退出）。 */
  serverClosing: 1000
} as const;

export type CanvasSessionLimits = {
  /** 单条入站 frame 字节上限（进入 envelope 解码之前）。 */
  maxMessageBytes: number;
  /** 发送队列（含底层 `bufferedAmount`）字节上限。 */
  maxOutboundQueueBytes: number;
  /** 每窗口允许的入站帧数。 */
  maxMessagesPerWindow: number;
  /** rate limit 窗口毫秒。 */
  rateWindowMs: number;
};

export const DEFAULT_CANVAS_SESSION_LIMITS: CanvasSessionLimits = {
  maxMessageBytes: SESSION_LIMITS.maxFrameBytes,
  maxOutboundQueueBytes: 8 * 1024 * 1024,
  maxMessagesPerWindow: 600,
  rateWindowMs: 10_000
};

export type CanvasSessionContext = {
  room: CanvasRoom;
  socket: SyncSocket;
  /** 客户端声明的外层 Canvas Session 版本（query `sessionProtocolVersion`）。 */
  clientSessionProtocolVersion: number;
  /** 客户端声明的内层 Yjs 协议版本。 */
  clientProtocolVersion: number;
  clientFormatVersion: string;
  clientRoomEpoch: string | null;
  clientStateVector: Uint8Array;
  actorId: string;
  limits?: Partial<CanvasSessionLimits>;
  /** 内层 Yjs 会话限制覆盖。 */
  yjsLimits?: Partial<SyncSessionLimits>;
  now?: () => number;
  /** task-activity 订阅（由 relay 接线）；`after` 是已验证的单调 cursor。 */
  onActivitySubscribe?: (after: number) => void;
  /** 会话释放（relay 退订 / 指标）；socket 关闭与主动 dispose 时都调用一次。 */
  onSessionDispose?: () => void;
  /** 每条命令提交前的 write 复核（任务 4.5/6.2/6.3）；撤权后立即拒绝。 */
  authorizeCommand?: () => Promise<boolean>;
  onCommandComplete?: SyncSessionContext["onCommandComplete"];
  /** 广播前可读性复核（任务 6.3）；撤 read 后停止发送。缺省恒 true。 */
  authorizeRead?: () => Promise<boolean>;
};

export type CanvasSessionStatus = "ready" | "closed";

/**
 * 一个逻辑通道的传输视图。
 *
 * 服务端 session 创建它并交给 channel consumer（Yjs）使用；`deliver` 由 dispatcher 调用，
 * 保证每帧只投递给一个 handler（spec「每帧只投递一个 handler」）。
 */
export class ChannelSocket implements SyncSocket {
  private readonly messageHandlers = new Set<(data: Uint8Array) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly session: CanvasSession,
    readonly channelId: SessionChannelId
  ) {}

  send(data: Uint8Array): void {
    this.session.sendChannel(this.channelId, data);
  }

  close(code?: number, reason?: string): void {
    this.session.close(code, reason);
  }

  onMessage(handler: (data: Uint8Array) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    if (this.closed) {
      handler();
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  isOpen(): boolean {
    return !this.closed && this.session.sessionStatus === "ready";
  }

  /** dispatcher 投递一条该 channel 的消息。 */
  deliver(data: Uint8Array): void {
    for (const handler of [...this.messageHandlers]) handler(data);
  }

  /** 物理关闭时通知 consumer（每个 handler 只触发一次）。 */
  signalClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) handler();
    this.closeHandlers.clear();
  }
}

/**
 * 单连接 Canvas Session。
 *
 * 一个实例只服务一个物理连接；room 由 registry 提供并负责串行。
 */
export class CanvasSession implements CanvasSessionBroadcastTarget {
  private readonly socket: SyncSocket;
  private readonly limits: CanvasSessionLimits;
  private readonly now: () => number;
  private readonly onActivitySubscribe: ((after: number) => void) | undefined;
  private readonly onSessionDispose: (() => void) | undefined;
  private readonly authorizeRead: (() => Promise<boolean>) | undefined;
  /** 广播屏障串行队列：read 复核与发送按连接顺序化。 */
  private broadcastGate: Promise<boolean> = Promise.resolve(true);
  private readonly yjsChannel: ChannelSocket;
  private yjsSession: CanvasSyncSession | null = null;
  private status: CanvasSessionStatus = "ready";
  private detachMessage: (() => void) | undefined;
  private detachClose: (() => void) | undefined;
  private messageTimestamps: number[] = [];
  private activitySubscribed = false;
  private activityCursor = 0;
  private disposed = false;

  constructor(context: CanvasSessionContext) {
    this.socket = context.socket;
    this.limits = { ...DEFAULT_CANVAS_SESSION_LIMITS, ...context.limits };
    this.now = context.now ?? (() => Date.now());
    this.onActivitySubscribe = context.onActivitySubscribe;
    this.onSessionDispose = context.onSessionDispose;
    this.authorizeRead = context.authorizeRead;
    this.yjsChannel = new ChannelSocket(this, SESSION_CHANNEL.CANVAS_YJS);

    // --- 版本闸门：在交换任何业务消息之前判定（design D8 / spec 场景）---
    // 不兼容时**不**构造 Yjs 会话，因此不会发送任何文档内容或 sync 状态。
    if (context.clientSessionProtocolVersion !== CANVAS_SESSION_PROTOCOL_VERSION) {
      this.fail("session-version-unsupported", "Canvas Session 协议版本不兼容", SESSION_CLOSE.protocolViolation);
      return;
    }

    this.yjsSession = new CanvasSyncSession({
      room: context.room,
      socket: this.yjsChannel,
      clientProtocolVersion: context.clientProtocolVersion,
      clientFormatVersion: context.clientFormatVersion,
      clientRoomEpoch: context.clientRoomEpoch,
      clientStateVector: context.clientStateVector,
      actorId: context.actorId,
      ...(context.yjsLimits ? { limits: context.yjsLimits } : {}),
      ...(context.now ? { now: context.now } : {}),
      ...(context.authorizeCommand ? { authorizeCommand: context.authorizeCommand } : {}),
      ...(context.onCommandComplete ? { onCommandComplete: context.onCommandComplete } : {})
    });

    this.detachMessage = this.socket.onMessage((data) => this.handleFrame(data));
    this.detachClose = this.socket.onClose(() => this.dispose());
  }

  get sessionStatus(): CanvasSessionStatus {
    return this.status;
  }

  /** 当前底层未发送字节数（慢 consumer 判定/指标用）。 */
  get bufferedBytes(): number {
    return this.socket.bufferedAmount?.() ?? 0;
  }

  /** 是否已订阅 task-activity 通道（relay 引用计数用）。 */
  get hasActivitySubscription(): boolean {
    return this.activitySubscribed;
  }

  /** 客户端确认的 activity cursor（诊断/测试用）。 */
  get subscribedCursor(): number {
    return this.activityCursor;
  }

  /** 等待广播屏障队列排空（测试/优雅关闭用）。 */
  async settledBroadcast(): Promise<void> {
    await this.broadcastGate.catch(() => undefined);
  }

  /** 向指定通道发送一个 payload（限流/队列上限在物理层统一判定）。 */
  sendChannel(channelId: SessionChannelId, payload: Uint8Array): void {
    if (this.status === "closed") return;
    const queued = (this.socket.bufferedAmount?.() ?? 0) + payload.byteLength;
    if (queued > this.limits.maxOutboundQueueBytes) {
      // 慢 consumer：有界终止并要求客户端重连（state vector / cursor 恢复）。
      this.fail("session-overloaded", "发送队列超过上限", SESSION_CLOSE.overloaded);
      return;
    }
    try {
      this.socket.send(encodeSessionFrame(channelId, payload));
    } catch {
      this.dispose();
    }
  }

  /** 广播一条 durable Yjs update（由 room 的 broadcast 回调经 hub 驱动）。 */
  broadcastUpdate(update: Uint8Array, revision: number): void {
    this.scheduleBroadcast(() => this.yjsSession?.broadcastUpdate(update, revision));
  }

  /**
   * 投递一条已持久化的画布任务活动记录。
   *
   * 未订阅 `task-activity` 通道时静默忽略；cursor 单调，重复投递幂等（前端合并保证收敛）。
   */
  receiveActivityRecord(record: CanvasTaskActivity, cursor: number): void {
    if (this.status === "closed" || !this.activitySubscribed) return;
    this.scheduleBroadcast(() => {
      if (this.status === "closed" || !this.activitySubscribed) return;
      this.activityCursor = Math.max(this.activityCursor, cursor);
      this.sendChannel(
        SESSION_CHANNEL.TASK_ACTIVITY,
        encodeTaskActivityRecord({ type: "record", cursor, record })
      );
    });
  }

  /** 通知 task-activity 通道就绪（当前高水位）。 */
  sendActivityReady(cursor: number): void {
    if (this.status === "closed" || !this.activitySubscribed) return;
    this.sendChannel(SESSION_CHANNEL.TASK_ACTIVITY, encodeTaskActivityReady({ type: "ready", cursor }));
  }

  /** 在 task-activity 通道报告依赖错误；不关闭健康的 Yjs 通道（design D6）。 */
  sendActivityError(code: string, retryable: boolean): void {
    if (this.status === "closed" || !this.activitySubscribed) return;
    this.sendChannel(SESSION_CHANNEL.TASK_ACTIVITY, encodeTaskActivityError({ type: "error", code, retryable }));
  }

  /** 主动关闭物理连接（hub/registry 触发）。 */
  close(code: number = SESSION_CLOSE.serverClosing, reason = "server-closing"): void {
    if (this.status === "closed") return;
    try {
      this.socket.send(encodeSessionFrame(
        SESSION_CHANNEL.CONTROL,
        encodeSessionControlMessage({ type: "closing", reason })
      ));
    } catch {
      // 连接可能已不可写。
    }
    this.status = "closed";
    try {
      this.socket.close(code, reason);
    } catch {
      // ignore
    }
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.status = "closed";
    this.detachMessage?.();
    this.detachClose?.();
    this.detachMessage = undefined;
    this.detachClose = undefined;
    this.yjsChannel.signalClose();
    this.onSessionDispose?.();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private handleFrame(data: Uint8Array): void {
    if (this.status === "closed") return;

    // 容量与速率在**解析之前**判定，避免畸形大包触发解析开销。
    if (data.byteLength > this.limits.maxMessageBytes) {
      this.fail("message-too-large", `frame 超过上限（${data.byteLength}）`, SESSION_CLOSE.protocolViolation);
      return;
    }
    const nowMs = this.now();
    this.messageTimestamps = this.messageTimestamps.filter((at) => nowMs - at < this.limits.rateWindowMs);
    this.messageTimestamps.push(nowMs);
    if (this.messageTimestamps.length > this.limits.maxMessagesPerWindow) {
      this.fail("rate-limited", "消息速率超过上限", SESSION_CLOSE.protocolViolation);
      return;
    }

    let decoded;
    try {
      decoded = decodeSessionFrame(data);
    } catch (error) {
      // 未知 channel / 畸形 / 尾随 / 超限：稳定协议错误，绝不投递部分 payload。
      const code = error instanceof SessionProtocolError ? error.code : "malformed-frame";
      this.fail(code, "无法解析 session frame", SESSION_CLOSE.protocolViolation);
      return;
    }

    switch (decoded.channelId) {
      case SESSION_CHANNEL.CANVAS_YJS:
        this.yjsChannel.deliver(decoded.payload);
        return;
      case SESSION_CHANNEL.TASK_ACTIVITY:
        this.handleActivityMessage(decoded.payload);
        return;
      case SESSION_CHANNEL.CONTROL:
      default:
        // session-control 是服务端 → 客户端方向；客户端发来即违规。
        this.fail("invalid-direction", "session-control 不接受客户端消息", SESSION_CLOSE.protocolViolation);
        return;
    }
  }

  private handleActivityMessage(payload: Uint8Array): void {
    let message;
    try {
      message = decodeTaskActivityClientMessage(payload);
    } catch (error) {
      // 单通道消息非法：在该通道报告，不污染 Yjs 通道（design D6）。
      const code = error instanceof SessionProtocolError ? error.code : "malformed-message";
      this.sendChannel(
        SESSION_CHANNEL.TASK_ACTIVITY,
        encodeTaskActivityError({ type: "error", code, retryable: false })
      );
      return;
    }
    // 一个 session 至多一个活动订阅；后续 subscribe 只替换 cursor（不新增 listener）。
    this.activitySubscribed = true;
    this.activityCursor = message.after;
    this.onActivitySubscribe?.(message.after);
  }

  /**
   * 广播屏障（任务 6.3）：把 read 复核与发送按连接顺序化。
   *
   * 若已因撤 read 关闭则直接跳过。复核失败（含 provider 故障）时关闭会话，绝不发送生效后的内容。
   * 选项在通过复核后才调用，避免在已关闭会话上重复执行发送闭包。
   */
  private scheduleBroadcast(send: () => void): void {
    if (this.status === "closed") return;
    if (!this.authorizeRead) {
      send();
      return;
    }
    const authorizeRead = this.authorizeRead;
    this.broadcastGate = this.broadcastGate.then(async () => {
      if (this.status === "closed") return false;
      let allowed = true;
      try {
        allowed = await authorizeRead();
      } catch {
        allowed = false;
      }
      if (!allowed) {
        this.close(SESSION_CLOSE.serverClosing, "read-revoked");
        return false;
      }
      send();
      return true;
    }).catch(() => false);
  }

  /** 失败关闭：先发可诊断 control error，再以应用 close code 关闭。 */
  private fail(code: string, message: string, closeCode: number): void {
    if (this.status === "closed") return;
    try {
      this.socket.send(encodeSessionFrame(
        SESSION_CHANNEL.CONTROL,
        encodeSessionControlMessage({ type: "error", code, message })
      ));
    } catch {
      // 连接可能已经不可写。
    }
    this.status = "closed";
    try {
      this.socket.close(closeCode, code);
    } catch {
      // ignore
    }
    this.dispose();
  }
}

/** 供测试/实现复用的默认值。 */
export { DEFAULT_SYNC_LIMITS };
