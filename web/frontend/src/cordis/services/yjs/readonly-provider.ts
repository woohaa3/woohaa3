import { measureInteractionWork } from "../interaction-timing.js";
/**
 * 只读同步 provider（任务 6.1 / design D9、D4）。
 *
 * **刻意不使用通用 `y-websocket` provider**：它会监听本地 Y.Doc transaction 并自动把
 * 本地 update 上传。本 change 的协议要求浏览器**只允许发送 state vector**（sync step1），
 * 持久化必须走语义命令。因此这里自己实现一个只读 provider：
 *
 * - 出站只发：sync step1（state vector）、COMMAND（语义命令）；
 * - 入站接收：sync update（应用进本地 Y.Doc）、COMMAND_RESULT、STATUS；
 * - 本地 transaction **绝不**触发出站 update。
 *
 * 传输无关（`SyncSocket` 抽象），因此可以在 Node 测试里用 fake socket 驱动。
 */
import * as Y from "yjs";
import { MESSAGE_TYPE,
  SYNC_MESSAGE_TYPE,
  decodeMessage,
  encodeCommandMessage,
  encodeSyncMessage,
  isForbiddenClientSyncType,
  ProtocolError,
  YJS_CANVAS_FORMAT_VERSION,
  YJS_SYNC_PROTOCOL_VERSION,
  type CanvasCommandBatch,
  type CommandResultPayload,
  type SyncSocket,
  type SyncStatusPayload } from "@woohaa3/contracts/canvas-yjs";

export type ReadonlyProviderPhase =
  | "loading-cache"
  | "connecting"
  | "syncing"
  | "ready"
  | "offline-readonly"
  | "error";

export type ReadonlyProviderState = {
  phase: ReadonlyProviderPhase;
  /** 服务端确认的业务 revision；未 synced 前为 null。 */
  revision: number | null;
  /** 服务端声明的 room epoch；与服务端不一致时必须丢弃本地 cache。 */
  roomEpoch: string | null;
  error: string | null;
};

export type CommandResultListener = (result: CommandResultPayload) => void;

export type ReadonlyProviderOptions = {
  socket: SyncSocket;
  /** 本地 Y.Doc（由 provider 负责应用服务端 update）。 */
  doc?: Y.Doc;
  canvasId: string;
  /** 本地 cache 的 format 与 epoch（来自 IndexedDB）。 */
  cacheFormatVersion?: string | null;
  cacheRoomEpoch?: string | null;
  protocolVersion?: number;
  formatVersion?: string;
  now?: () => number;
  onChange?: (state: ReadonlyProviderState) => void;
  /**
   * 收到服务端权威握手后丢弃已加载的 cache 文档；宿主据此清空持久化 cache。
   * 即使 epoch 相同也必须重建，因为旧版本可能曾把本地状态写进同 epoch 的缓存。
   */
  onCachedDocumentDiscarded?: (input: {
    cached: string | null;
    server: string | null;
    epochMismatch: boolean;
  }) => void;
  /** 收到 command result 时回调（宿主据此更新 pending/committed 生命周期）。 */
  onCommandResult?: CommandResultListener;
  /**
   * 应用一条服务端 published update 后回调（change: add-frontend-speculative-canvas-state，
   * design D10）。宿主据此把 update 追加到 IndexedDB cache，并更新 confirmed revision。
   */
  onServerUpdate?: (update: Uint8Array) => void;
  /**
   * provider 是否拥有底层 socket 生命周期（默认 true）。
   *
   * 共享 Canvas Session transport 时（change: unify-canvas-session-websocket）设为 false：
   * provider 只解绑监听，**不**关闭物理连接（连接由 page-owned session 统一管理）。
   */
  ownsSocket?: boolean;
};

/**
 * 只读 provider。
 *
 * 生命周期：`start()` → 发送带本地 state vector 的 sync step1 → 收到 update 与 synced
 * status → `ready`。`ready` 之前命令会被拒绝（写入门禁）。
 */
export class ReadonlyCanvasProvider {
  doc: Y.Doc;
  private readonly socket: SyncSocket;
  private readonly canvasId: string;
  private readonly protocolVersion: number;
  private readonly formatVersion: string;
  private readonly onChange: ((state: ReadonlyProviderState) => void) | undefined;
  private readonly onCachedDocumentDiscarded: ReadonlyProviderOptions["onCachedDocumentDiscarded"];
  private readonly onCommandResult: CommandResultListener | undefined;
  private readonly onServerUpdate: ((update: Uint8Array) => void) | undefined;
  private readonly cacheRoomEpoch: string | null;
  private readonly hasCachedDocument: boolean;
  private readonly ownsSocket: boolean;
  private authoritativeHandshakeHandled = false;

  private detachMessage: (() => void) | undefined;
  private detachClose: (() => void) | undefined;
  private detachOpen: (() => void) | undefined;
  private state: ReadonlyProviderState;

  /** Monotonic document transaction version, including received updates. */
  private localTransactionCount = 0;
  /** 出站消息计数（测试断言只读性）。 */
  private outboundSyncUpdates = 0;

  constructor(options: ReadonlyProviderOptions) {
    this.socket = options.socket;
    this.canvasId = options.canvasId;
    this.protocolVersion = options.protocolVersion ?? YJS_SYNC_PROTOCOL_VERSION;
    this.formatVersion = options.formatVersion ?? YJS_CANVAS_FORMAT_VERSION;
    this.onChange = options.onChange;
    this.onCachedDocumentDiscarded = options.onCachedDocumentDiscarded;
    this.onCommandResult = options.onCommandResult;
    this.onServerUpdate = options.onServerUpdate;
    this.doc = options.doc ?? new Y.Doc();
    this.ownsSocket = options.ownsSocket ?? true;

    // cache 只用于服务端握手前快速显示；握手后总是从权威文档重建。
    const cacheFormat = options.cacheFormatVersion ?? null;
    const cacheMismatch = cacheFormat !== null && cacheFormat !== this.formatVersion;
    this.cacheRoomEpoch = options.cacheRoomEpoch ?? null;
    this.hasCachedDocument = cacheFormat !== null && !cacheMismatch;

    this.state = {
      phase: cacheMismatch ? "connecting" : "loading-cache",
      revision: null,
      roomEpoch: this.cacheRoomEpoch,
      error: null
    };

    // 关键：本地 transaction 只记录，**绝不**发送任何 update 出去。
    this.doc.on("afterTransaction", () => {
      this.localTransactionCount += 1;
    });
  }

  get providerState(): ReadonlyProviderState {
    return this.state;
  }

  /** 本地 cache transaction 次数（测试断言 cache 不产生出站）。 */
  get localTransactions(): number {
    return this.localTransactionCount;
  }

  /** Invalidates derived projections without encoding or traversing the document. */
  get documentVersion(): number {
    return this.localTransactionCount;
  }

  /** 出站 sync update 次数；只读 provider 永远应为 0。 */
  get outboundUpdates(): number {
    return this.outboundSyncUpdates;
  }

  /** 建立连接并发起握手。 */
  start(): void {
    this.detachMessage = this.socket.onMessage((data) => this.handleMessage(data));
    this.detachClose = this.socket.onClose(() => this.handleClose());
    this.setState({ phase: "syncing", error: null });

    const handshake = () => {
      // 只读出站：带本地 state vector 的 step1（不含任何本地 update）。
      // 共享 Canvas Session transport 会在透明重连后**再次**触发通道 open，因此这里每次
      // open 都重新握手（state-vector 恢复），而不是只做一次性握手。
      this.setState({ phase: "syncing", error: null });
      const stateVector = Y.encodeStateVector(this.doc);
      this.socket.send(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, stateVector));
    };

    // 浏览器 `WebSocket` 在 CONNECTING 时 `send()` 会抛错，因此必须等 open。
    // 共享 transport 的 `onOpen` 在已 open 时**同步**回调；浏览器 `addEventListener("open")`
    // 在已 open 时不回调。两种情况都必须恰好握手一次。
    if (this.socket.onOpen) {
      let openedSynchronously = false;
      this.detachOpen = this.socket.onOpen(() => {
        openedSynchronously = true;
        handshake();
      });
      if (!openedSynchronously && this.socket.isOpen?.()) handshake();
      return;
    }
    // 无 onOpen 的传输（内存 fake / 已连接的传输）直接握手。
    handshake();
  }

  /**
   * 提交一个语义命令。
   *
   * 未 `ready` 时拒绝（写入门禁）；这是结构性的：持久化只能经此路径。
   */
  submitCommand(batch: CanvasCommandBatch): { ok: true } | { ok: false; reason: string } {
    if (this.state.phase !== "ready") {
      return { ok: false, reason: `画布尚未完成同步（当前 ${this.state.phase}），暂不可写` };
    }
    const encoded = measureInteractionWork("commandWireMs", () => encodeCommandMessage({
      ...batch,
      canvasId: this.canvasId,
      protocolVersion: this.protocolVersion
    }));
    this.socket.send(encoded);
    return { ok: true };
  }

  private handleMessage(data: Uint8Array): void {
    let decoded;
    try {
      decoded = decodeMessage(data);
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : "malformed-message";
      this.setState({ phase: "error", error: `${code}: 无法解析入站消息` });
      return;
    }

    if (decoded.type === MESSAGE_TYPE.SYNC) {
      // 服务端 → 客户端方向：step1（服务端 state vector）、step2/update 都合法。
      if (decoded.syncType === SYNC_MESSAGE_TYPE.STEP1) {
        // 服务端要我们的 state vector：回一条 step1（仍不是写 update）。
        this.socket.send(encodeSyncMessage(SYNC_MESSAGE_TYPE.STEP1, Y.encodeStateVector(this.doc)));
        return;
      }
      if (isForbiddenClientSyncType(decoded.syncType)) {
        // 这两个方向正是我们**接收**的：应用到本地文档。
        Y.applyUpdate(this.doc, decoded.payload);
        // 只把服务端 published update 追加到 cache（design D10）。
        this.onServerUpdate?.(decoded.payload);
      }
      return;
    }

    if (decoded.type === MESSAGE_TYPE.COMMAND_RESULT) {
      this.onCommandResult?.(decoded.result);
      return;
    }

    if (decoded.type === MESSAGE_TYPE.STATUS) {
      this.handleStatus(decoded.status);
      return;
    }
  }

  private handleStatus(status: SyncStatusPayload): void {
    if (status.status === "error") {
      this.setState({
        phase: "error",
        error: `${status.code ?? "error"}: ${status.error ?? "同步错误"}`
      });
      return;
    }
    if (status.status === "closing") {
      this.setState({ phase: "offline-readonly", error: status.error ?? null });
      return;
    }
    if (status.status === "syncing") {
      this.reconcileServerEpoch(status.roomEpoch ?? null);
      this.setState({ phase: "syncing", roomEpoch: status.roomEpoch ?? null, error: null });
      return;
    }
    if (status.status === "synced") {
      this.reconcileServerEpoch(status.roomEpoch ?? this.state.roomEpoch);
      this.setState({
        phase: "ready",
        revision: status.revision ?? this.state.revision,
        roomEpoch: status.roomEpoch ?? this.state.roomEpoch,
        error: null
      });
    }
  }

  /**
   * Yjs update 只能合并，不能证明并删除 cache 中服务端不存在的本地结构。
   * 因此 cache 只用于连接前显示；首次权威握手时无条件换空 doc，再接收服务端全量状态。
   */
  private reconcileServerEpoch(serverEpoch: string | null): void {
    if (this.authoritativeHandshakeHandled) return;
    this.authoritativeHandshakeHandled = true;
    if (!this.hasCachedDocument) return;

    this.doc = new Y.Doc();
    this.doc.on("afterTransaction", () => {
      this.localTransactionCount += 1;
    });
    this.onCachedDocumentDiscarded?.({
      cached: this.cacheRoomEpoch,
      server: serverEpoch,
      epochMismatch: this.cacheRoomEpoch !== serverEpoch
    });
  }

  private handleClose(): void {
    if (this.state.phase === "error") return;
    this.setState({ phase: "offline-readonly", error: "连接已断开，画布只读" });
  }

  private setState(patch: Partial<ReadonlyProviderState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange?.(this.state);
  }

  dispose(): void {
    this.detachMessage?.();
    this.detachClose?.();
    this.detachOpen?.();
    this.detachMessage = undefined;
    this.detachClose = undefined;
    this.detachOpen = undefined;
    // provider 拥有 socket 生命周期：dispose 时必须关闭底层传输，否则多画布切换会泄漏
    // 旧画布的 WebSocket（change: 2026-09-29-add-multi-canvas-workspace，任务 5.2）。
    // 共享 Canvas Session transport 时（ownsSocket=false）只解绑监听，连接由 page 统一管理。
    if (!this.ownsSocket) return;
    try {
      this.socket.close();
    } catch {
      // socket 已关闭/底层抛错不影响其余清理。
    }
  }
}
