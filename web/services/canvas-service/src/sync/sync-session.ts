/**
 * 同步会话（任务 5.2–5.7 / design D4）。
 *
 * **传输无关**：会话只依赖 `SyncSocket` 抽象（send/close/onMessage/onClose），因此
 * dev、build/preview 与测试可以注入不同实现（`ws` 或内存 fake），协议逻辑只有一份。
 *
 * 握手顺序（design D4）：
 * 1. 认证 / Origin / canvas access / actorId —— 由调用方在 upgrade 前完成；
 * 2. 交换 syncProtocolVersion、yDocFormatVersion、canvasId、room epoch、revision；
 * 3. 版本不兼容或 epoch 过期 → 在**交换文档内容之前**失败关闭；
 * 4. 客户端发 state vector → 服务端回差量；随后发送 synced status，才允许提交命令。
 *
 * 关键约束：客户端**只允许**发送 SYNC step1（state vector）。发送 step2 / update 视为
 * 协议违规：拒绝并关闭连接，且 published Y.Doc、存储与其它客户端保持不变。
 */
import * as Y from "yjs";
import { MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  decodeMessage,
  encodeJsonMessage,
  encodeStatusMessage,
  encodeSyncMessage,
  isForbiddenClientSyncType,
  ProtocolError } from "@woohaa3/contracts/canvas-yjs";
import { YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  decodeYjsCommandBatch,
  type SyncSocket } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "./room.js";

export type { SyncSocket };

export type SyncSessionLimits = {
  /** 单条入站消息字节上限。 */
  maxMessageBytes: number;
  /** 单批命令数量上限。 */
  maxCommands: number;
  /** 每窗口允许的消息数（简单 rate limit）。 */
  maxMessagesPerWindow: number;
  /** rate limit 窗口毫秒。 */
  rateWindowMs: number;
};

export const DEFAULT_SYNC_LIMITS: SyncSessionLimits = {
  maxMessageBytes: 1024 * 1024,
  maxCommands: 512,
  maxMessagesPerWindow: 600,
  rateWindowMs: 10_000
};

export type SyncSessionContext = {
  room: CanvasRoom;
  socket: SyncSocket;
  /** 客户端声明的协议版本。 */
  clientProtocolVersion: number;
  /** 客户端声明的 Y.Doc 格式版本。 */
  clientFormatVersion: string;
  /** 客户端缓存的 room epoch；与服务端不一致时必须丢弃本地 cache。 */
  clientRoomEpoch: string | null;
  /** 客户端状态向量（可为空）。 */
  clientStateVector: Uint8Array;
  /** 已认证的 actorId（由服务端上下文产生，绝不信任客户端输入）。 */
  actorId: string;
  limits?: Partial<SyncSessionLimits>;
  now?: () => number;
  /**
   * 每条命令在 **room 队列/持久 commit 之前**的 write 复核
   * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 4.5/6.2/6.3）。
   *
   * 复核作为命令选项随命令一起进入 room 串行队列，与 ACL 撤 write 通过同一队列排序：
   * 撤权生效后的 commit 被拒绝且不形成新 revision/不广播；撤权前已入队的命令按既有顺序。
   */
  authorizeCommand?: () => Promise<boolean>;
  /** Queue + authorization + durable commit wall time; excludes transport. */
  onCommandComplete?: (input: { status: string; latencyMs: number }) => void;
};

export type SyncSessionStatus =
  | "handshaking"
  | "syncing"
  | "ready"
  | "closed";

/**
 * 单连接同步会话。
 *
 * 一个实例只服务一个连接；room 由 registry 提供并负责串行。
 */
export class CanvasSyncSession {
  private readonly room: CanvasRoom;
  private readonly socket: SyncSocket;
  private readonly actorId: string;
  private readonly limits: SyncSessionLimits;
  private readonly now: () => number;
  private status: SyncSessionStatus = "handshaking";
  private detachMessage: (() => void) | undefined;
  private detachClose: (() => void) | undefined;
  /** 简单滑动窗口 rate limit。 */
  private messageTimestamps: number[] = [];
  /** 是否已经完成 state-vector 同步（未完成前不接受命令）。 */
  private synced = false;
  /** write 复核钩子（任务 4.5/6.2/6.3）；未注入时不传（历史行为不变）。 */
  private readonly authorizeCommand: (() => Promise<boolean>) | undefined;
  private readonly onCommandComplete: SyncSessionContext["onCommandComplete"];

  constructor(context: SyncSessionContext) {
    this.room = context.room;
    this.socket = context.socket;
    this.actorId = context.actorId;
    this.authorizeCommand = context.authorizeCommand;
    this.onCommandComplete = context.onCommandComplete;
    this.limits = { ...DEFAULT_SYNC_LIMITS, ...context.limits };
    this.now = context.now ?? (() => Date.now());

    if (context.clientProtocolVersion !== YJS_SYNC_PROTOCOL_VERSION) {
      // 协议不兼容：交换文档内容**之前**失败关闭。旧页面需刷新后重新握手（change 任务 1.3）。
      this.fail(
        "protocol-version-unsupported",
        `同步协议版本不兼容（客户端 ${context.clientProtocolVersion}，服务端 ${YJS_SYNC_PROTOCOL_VERSION}），请刷新页面`
      );
      return;
    }
    if (context.clientFormatVersion !== YJS_CANVAS_FORMAT_VERSION) {
      this.fail("ydoc-format-unsupported", "Y.Doc 格式版本不兼容，请刷新页面");
      return;
    }
    if (this.room.roomState === "quarantined") {
      this.fail("room-quarantined", this.room.diagnostics ?? "room 已隔离");
      return;
    }
    if (this.room.roomState !== "ready") {
      this.fail("room-not-ready", "room 尚未就绪");
      return;
    }
    // epoch 不一致：告知客户端必须丢弃本地 cache，但仍允许从头同步。
    const epochMismatch = context.clientRoomEpoch !== null
      && context.clientRoomEpoch !== this.room.roomEpoch;

    this.detachMessage = this.socket.onMessage((data) => this.handleMessage(data));
    this.detachClose = this.socket.onClose(() => this.dispose());

    this.status = "syncing";
    // 1) 在任何文档内容之前声明权威 epoch，让客户端先丢弃旧 room cache。
    this.socket.send(encodeStatusMessage({
      status: "syncing",
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      yDocFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: this.room.roomEpoch,
      revision: this.room.currentRevision
    }));
    // 2) 发送 sync step1（服务端 state vector），让客户端回差量请求。
    const serverStateVector = this.room.encodeStateVector();
    this.socket.send(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, serverStateVector));
    // 3) 直接根据客户端 state vector 计算差量（无论是否 epoch 过期）。
    //    epoch 过期时用「空 state vector」强制全量，让客户端丢弃本地 cache。
    const base = epochMismatch ? Y.encodeStateVector(new Y.Doc()) : context.clientStateVector;
    const diff = this.room.encodeDiff(base);
    this.socket.send(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, diff));
    // 4) 差量应用完成后进入 ready。
    this.synced = true;
    this.status = "ready";
    this.socket.send(encodeStatusMessage({
      status: "synced",
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      yDocFormatVersion: YJS_CANVAS_FORMAT_VERSION,
      roomEpoch: this.room.roomEpoch,
      revision: this.room.currentRevision
    }));
  }

  get sessionStatus(): SyncSessionStatus {
    return this.status;
  }

  /** 处理一条入站消息。 */
  private handleMessage(data: Uint8Array): void {
    if (this.status === "closed") return;

    // 容量与速率限制在**解析之前**执行，避免畸形大包触发解析开销。
    if (data.byteLength > this.limits.maxMessageBytes) {
      this.fail("message-too-large", `消息超过上限（${data.byteLength} > ${this.limits.maxMessageBytes}）`);
      return;
    }
    const nowMs = this.now();
    this.messageTimestamps = this.messageTimestamps.filter((at) => nowMs - at < this.limits.rateWindowMs);
    this.messageTimestamps.push(nowMs);
    if (this.messageTimestamps.length > this.limits.maxMessagesPerWindow) {
      this.fail("rate-limited", "消息速率超过上限");
      return;
    }

    let decoded;
    try {
      decoded = decodeMessage(data);
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : "malformed-message";
      this.fail(code, "无法解析入站消息");
      return;
    }

    if (decoded.type === MESSAGE_TYPE.SYNC) {
      // 客户端只允许 step1（携带 state vector 的同步请求）。
      if (isForbiddenClientSyncType(decoded.syncType)) {
        // 协议违规：published Y.Doc、存储与其它客户端保持不变（我们只是关闭连接）。
        this.fail("client-sync-update-forbidden", "客户端不得发送 sync update / step 2");
        return;
      }
      if (decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
        this.respondToStateVector(decoded.payload);
      }
      return;
    }

    if (decoded.type === MESSAGE_TYPE.COMMAND) {
      void this.handleCommand(decoded.batch);
      return;
    }

    // COMMAND_RESULT / STATUS 是服务端 → 客户端方向；客户端发来视为违规。
    this.fail("unknown-message-type", "客户端不得发送该消息类型");
  }

  /** 客户端回送 state vector：从 published 计算缺失差量。 */
  private respondToStateVector(stateVectorBytes: Uint8Array): void {
    // step1 的 payload 就是 Yjs 编码的 state vector 原始字节（空文档为 `[0]`）。
    // 递归调用同一条规范化路径，避免 0 字节输入让 Yjs 抛错。
    let diff: Uint8Array;
    try {
      diff = this.room.encodeDiff(stateVectorBytes);
    } catch {
      this.fail("malformed-message", "state vector 解析失败");
      return;
    }
    this.socket.send(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, diff));
    this.socket.send(encodeStatusMessage({
      status: "synced",
      revision: this.room.currentRevision
    }));
  }

  /** 命令：交给 room 串行执行；结果回给**发起连接的客户端**。 */
  private async handleCommand(rawBatch: unknown): Promise<void> {
    if (!this.synced || this.status !== "ready") {
      this.socket.send(encodeJsonMessage(MESSAGE_TYPE.COMMAND_RESULT, {
        commandId: "unknown",
        status: "rejected",
        code: "not-synced",
        error: "尚未完成初始同步"
      }));
      return;
    }

    const decoded = decodeYjsCommandBatch(rawBatch, { expectedProtocolVersion: YJS_SYNC_PROTOCOL_VERSION });
    if (!decoded.ok) {
      this.socket.send(encodeJsonMessage(MESSAGE_TYPE.COMMAND_RESULT, {
        commandId: "unknown",
        status: "rejected",
        code: "invalid-command-batch",
        error: decoded.reason
      }));
      return;
    }
    const batch = decoded.batch;
    if (batch.commands.length > this.limits.maxCommands) {
      this.socket.send(encodeJsonMessage(MESSAGE_TYPE.COMMAND_RESULT, {
        commandId: batch.commandId,
        status: "rejected",
        code: "limit-exceeded",
        error: `命令数量超过上限（${batch.commands.length} > ${this.limits.maxCommands}）`
      }));
      return;
    }

    // actorId 以**服务端上下文**为准，忽略客户端自报值。
    // write 复核（任务 4.5/6.2/6.3）作为命令选项进入 room 串行队列：撤权后 barrier 拒绝，
    // 不形成新 revision、不广播；检查与持久 commit 之间无无保护授权窗口。
    const started = performance.now();
    const outcome = await this.room.submit(
      {
        ...batch,
        canvasId: this.room.canvasId,
        actorId: this.actorId
      },
      this.authorizeCommand ? { authorize: this.authorizeCommand } : undefined
    );
    try {
      this.onCommandComplete?.({ status: outcome.status, latencyMs: Math.max(0, performance.now() - started) });
    } catch { /* Diagnostics must not affect command confirmation. */ }

    if (outcome.ok) {
      this.socket.send(encodeJsonMessage(MESSAGE_TYPE.COMMAND_RESULT, {
        commandId: outcome.commandId,
        status: outcome.status === "duplicate" ? "duplicate" : "accepted",
        revision: outcome.revision,
        noop: outcome.noop
      }));
      return;
    }
    this.socket.send(encodeJsonMessage(MESSAGE_TYPE.COMMAND_RESULT, {
      commandId: outcome.commandId,
      status: outcome.status,
      code: outcome.code,
      error: outcome.message,
      ...(outcome.conflict ? { conflict: outcome.conflict } : {})
    }));
  }

  /** 广播一条 durable update（由 room 的 broadcast 回调驱动）。 */
  broadcastUpdate(update: Uint8Array, revision: number): void {
    if (this.status !== "ready") return;
    this.socket.send(encodeSyncMessage(SYNC_MESSAGE_TYPE.UPDATE, update));
    this.socket.send(encodeStatusMessage({ status: "synced", revision }));
  }

  /** 失败关闭：发送可诊断 status 后关闭连接。 */
  private fail(code: string, message: string): void {
    if (this.status === "closed") return;
    this.status = "closed";
    try {
      this.socket.send(encodeStatusMessage({ status: "error", code, error: message }));
    } catch {
      // 连接可能已经不可写。
    }
    this.socket.close(1008, code);
    this.dispose();
  }

  dispose(): void {
    this.status = "closed";
    this.detachMessage?.();
    this.detachClose?.();
    this.detachMessage = undefined;
    this.detachClose = undefined;
  }

  /**
   * 主动关闭连接（由 hub/registry 触发）。
   *
   * 与 `dispose()` 的差别：先给客户端一条可诊断的 closing status，再关闭底层 socket，
   * 让前端能区分「服务端主动关闭」与「网络断开」。
   */
  close(reason = "server-closing"): void {
    if (this.status === "closed") return;
    try {
      this.socket.send(encodeStatusMessage({ status: "closing", error: reason }));
    } catch {
      // 连接可能已不可写。
    }
    this.status = "closed";
    this.socket.close(1000, reason);
    this.dispose();
  }
}
