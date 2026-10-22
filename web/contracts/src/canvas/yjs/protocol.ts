/**
 * 同步协议编解码（任务 1.5 / design D4）。
 *
 * 传输格式：**lib0 encoding**（Yjs 生态的紧凑二进制编码），顶层消息用单字节 type 判别。
 *
 * ```
 * SYNC            Yjs sync step / state vector / update payload（y-protocols/sync 语义）
 * COMMAND         JSON CanvasCommandBatch，client -> server
 * COMMAND_RESULT  JSON result，server -> originating client
 * STATUS          JSON synced/error/closing
 * ```
 *
 * 关键约束（design D4）：
 * - 客户端**只允许**发送 sync step 1 / state vector；发送 step 2 或写 update 视为协议违规。
 * - 编解码必须对**未知消息类型**与**畸形输入**给出稳定错误，而不是崩溃或静默丢弃。
 * - 因此本模块只有 `decode`/`encode` 两个方向，不绑定任何 socket 实现。
 */
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { CanvasCommandBatch } from "./commands.js";

/** 顶层消息类型（wire 契约；改动即破坏兼容）。 */
export const MESSAGE_TYPE = {
  /** Yjs sync 协议 payload（y-protocols/sync）。 */
  SYNC: 0,
  /** JSON CanvasCommandBatch（client -> server）。 */
  COMMAND: 1,
  /** JSON command result（server -> originating client）。 */
  COMMAND_RESULT: 2,
  /** JSON status（server -> client）。 */
  STATUS: 3
} as const;

export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

export const MESSAGE_TYPE_NAMES: Record<MessageType, string> = {
  [MESSAGE_TYPE.SYNC]: "SYNC",
  [MESSAGE_TYPE.COMMAND]: "COMMAND",
  [MESSAGE_TYPE.COMMAND_RESULT]: "COMMAND_RESULT",
  [MESSAGE_TYPE.STATUS]: "STATUS"
};

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === "number" && Object.values(MESSAGE_TYPE).includes(value as MessageType);
}

/**
 * 同步子类型（Yjs sync 协议的 step；用于区分客户端合法/非法输入）。
 *
 * 值与 y-protocols/sync 一致，但我们显式定义以让「拒绝客户端 step 2」成为可断言契约。
 */
export const SYNC_MESSAGE_TYPE = {
  STEP1: 0,
  STEP2: 1,
  UPDATE: 2
} as const;

export type SyncMessageType = (typeof SYNC_MESSAGE_TYPE)[keyof typeof SYNC_MESSAGE_TYPE];

// ---------------------------------------------------------------------------
// 消息形状（JSON payload）
// ---------------------------------------------------------------------------

export type SyncStatusPayload = {
  status: "syncing" | "synced" | "closing" | "error";
  /** 握手期间返回；客户端据此判断是否需要丢弃本地 cache。 */
  protocolVersion?: number;
  yDocFormatVersion?: string;
  roomEpoch?: string | null;
  revision?: number;
  error?: string;
  code?: string;
};

export type CommandResultPayload = {
  commandId: string;
  status: "accepted" | "duplicate" | "rejected" | "failed";
  /** 净变化后的业务 revision；no-op 时等于 base revision。 */
  revision?: number;
  /** 是否为 no-op（有效命令但无净变化）。 */
  noop?: boolean;
  error?: string;
  code?: string;
};

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type ProtocolErrorCode =
  | "unknown-message-type"
  | "malformed-message"
  | "invalid-json"
  | "payload-too-large"
  | "client-sync-update-forbidden";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 编码（服务端/客户端共用的纯函数）
// ---------------------------------------------------------------------------

/**
 * 编码一条 SYNC 消息。
 *
 * wire 格式：`[SYNC][varUint(syncType)][varUint8Array(payload)]`，与解码器**严格对称**。
 * `payload` 是 subtype 之后的 sync 数据（state vector / update 字节），由调用方从
 * y-protocols 读出后传入。
 */
export function encodeSyncMessage(syncType: SyncMessageType, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
  encoding.writeVarUint(encoder, syncType);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/** 编码一条 JSON 消息（COMMAND / COMMAND_RESULT / STATUS）。 */
export function encodeJsonMessage(type: MessageType, payload: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  encoding.writeVarString(encoder, JSON.stringify(payload));
  return encoding.toUint8Array(encoder);
}

export function encodeCommandMessage(batch: CanvasCommandBatch): Uint8Array {
  return encodeJsonMessage(MESSAGE_TYPE.COMMAND, batch);
}

export function encodeCommandResultMessage(result: CommandResultPayload): Uint8Array {
  return encodeJsonMessage(MESSAGE_TYPE.COMMAND_RESULT, result);
}

export function encodeStatusMessage(status: SyncStatusPayload): Uint8Array {
  return encodeJsonMessage(MESSAGE_TYPE.STATUS, status);
}

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

export type DecodedMessage =
  | { type: typeof MESSAGE_TYPE.SYNC; syncType: SyncMessageType; payload: Uint8Array }
  | { type: typeof MESSAGE_TYPE.COMMAND; batch: unknown }
  | { type: typeof MESSAGE_TYPE.COMMAND_RESULT; result: CommandResultPayload }
  | { type: typeof MESSAGE_TYPE.STATUS; status: SyncStatusPayload };

/**
 * 解码任意入站消息。
 *
 * 未知类型与畸形输入都抛 `ProtocolError`（调用方据此关闭连接），**不返回 null** ——
 * 静默丢弃会让协议违规看起来像网络抖动。
 */
export function decodeMessage(data: Uint8Array): DecodedMessage {
  let decoder: decoding.Decoder;
  try {
    decoder = decoding.createDecoder(data);
  } catch {
    throw new ProtocolError("malformed-message", "无法创建解码器");
  }

  let type: number;
  try {
    type = decoding.readVarUint(decoder);
  } catch {
    throw new ProtocolError("malformed-message", "缺少消息类型");
  }

  if (!isMessageType(type)) {
    throw new ProtocolError("unknown-message-type", `未知消息类型：${type}`);
  }

  if (type === MESSAGE_TYPE.SYNC) {
    let syncType: number;
    try {
      syncType = decoding.readVarUint(decoder);
    } catch {
      throw new ProtocolError("malformed-message", "SYNC 消息缺少子类型");
    }
    if (
      syncType !== SYNC_MESSAGE_TYPE.STEP1
      && syncType !== SYNC_MESSAGE_TYPE.STEP2
      && syncType !== SYNC_MESSAGE_TYPE.UPDATE
    ) {
      throw new ProtocolError("unknown-message-type", `未知 SYNC 子类型：${syncType}`);
    }
    // 余下字节就是 sync payload（可能是空的 step1 不带 state vector，由上层判定）。
    let payload: Uint8Array;
    try {
      payload = decoding.readVarUint8Array(decoder);
    } catch {
      payload = new Uint8Array(0);
    }
    return { type: MESSAGE_TYPE.SYNC, syncType, payload };
  }

  let json: string;
  try {
    json = decoding.readVarString(decoder);
  } catch {
    throw new ProtocolError("malformed-message", "消息缺少 JSON 载荷");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new ProtocolError("invalid-json", "载荷不是合法 JSON");
  }

  if (type === MESSAGE_TYPE.COMMAND) {
    return { type: MESSAGE_TYPE.COMMAND, batch: payload };
  }
  if (type === MESSAGE_TYPE.COMMAND_RESULT) {
    return { type: MESSAGE_TYPE.COMMAND_RESULT, result: payload as CommandResultPayload };
  }
  return { type: MESSAGE_TYPE.STATUS, status: payload as SyncStatusPayload };
}

/**
 * 判定入站 SYNC 消息是否是**客户端写 update**（协议违规）。
 *
 * 客户端只允许 STEP1（携带 state vector 的同步请求）。STEP2 与 UPDATE 都是服务端 → 客户端的
 * 方向；客户端发来即违规（design D4 / spec「客户端提交 raw Yjs update」）。
 */
export function isForbiddenClientSyncType(syncType: SyncMessageType): boolean {
  return syncType === SYNC_MESSAGE_TYPE.STEP2 || syncType === SYNC_MESSAGE_TYPE.UPDATE;
}
